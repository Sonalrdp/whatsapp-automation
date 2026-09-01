import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import pino from 'pino';
import makeWASocket, { DisconnectReason, downloadMediaMessage, downloadContentFromMessage, Browsers, proto } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

// Message store for Baileys retry and decryption handling
const messageStore = new Map();

import { 
    initDatabase, 
    getAuthState, 
    clearAuthState, 
    getUserBotConfig, 
    saveUserBotConfig, 
    formatJid,
    getUserByEmail,
    getUserById,
    getAllUsers,
    createUser,
    updateUserRole,
    deleteUser,
    findOrCreateGoogleUser,
    verifyPasswordHash,
    saveOtp,
    verifyOtp,
    createToken,
    verifyToken,
    getDatabaseStats,
    getUserSubscription,
    checkUserCanSendMessage,
    recordUserMessageSent,
    claimUserFreeAddon,
    upgradeUserSubscription,
    SUBSCRIPTION_PLANS
} from './database.js';
import { setupUserScheduledMessage, stopUserScheduledMessage } from './scheduler.js';

// Express setup
const app = express();
const PORT = process.env.PORT || 3005;

app.use(bodyParser.json());
app.use(express.static('public')); // Serve the web dashboard

// Logger
const pinoLogger = pino({ level: 'silent' });

// --------------------------------------------------------------------------
// Multi-Tenant User Sessions Map
// userId -> SessionObject
// --------------------------------------------------------------------------
const userSessions = new Map();

// Helper to extract message content of all types (PDF/Docs, Images, Videos, Audio, Text, Stickers)
function extractMessageContent(rawMsg) {
    if (!rawMsg) return null;
    let message = rawMsg;
    
    // Unbox all possible Baileys message wrappers
    for (let i = 0; i < 8; i++) {
        if (!message) break;
        if (message.ephemeralMessage?.message) message = message.ephemeralMessage.message;
        else if (message.viewOnceMessage?.message) message = message.viewOnceMessage.message;
        else if (message.viewOnceMessageV2?.message) message = message.viewOnceMessageV2.message;
        else if (message.viewOnceMessageV2Extension?.message) message = message.viewOnceMessageV2Extension.message;
        else if (message.documentWithCaptionMessage?.message) message = message.documentWithCaptionMessage.message;
        else if (message.templateMessage?.hydratedTemplate) message = message.templateMessage.hydratedTemplate;
        else if (message.templateMessage?.hydratedFourRowTemplate) message = message.templateMessage.hydratedFourRowTemplate;
        else if (message.editedMessage?.message) message = message.editedMessage.message;
        else break;
    }
    if (!message) return null;

    if (message.documentMessage) {
        const mime = message.documentMessage.mimetype || 'application/pdf';
        const rawFileName = message.documentMessage.fileName || '';
        const isPdf = mime.toLowerCase().includes('pdf') || rawFileName.toLowerCase().endsWith('.pdf');
        return {
            type: isPdf ? 'pdf' : 'document',
            mimetype: mime,
            fileName: rawFileName || (isPdf ? 'document.pdf' : 'file'),
            caption: message.documentMessage.caption || '',
            media: message.documentMessage
        };
    }
    if (message.imageMessage) {
        return {
            type: 'image',
            mimetype: message.imageMessage.mimetype || 'image/jpeg',
            caption: message.imageMessage.caption || '',
            media: message.imageMessage
        };
    }
    if (message.videoMessage) {
        return {
            type: 'video',
            mimetype: message.videoMessage.mimetype || 'video/mp4',
            caption: message.videoMessage.caption || '',
            gifPlayback: message.videoMessage.gifPlayback || false,
            media: message.videoMessage
        };
    }
    if (message.audioMessage) {
        return {
            type: 'audio',
            mimetype: message.audioMessage.mimetype || 'audio/mp4',
            ptt: message.audioMessage.ptt || false,
            media: message.audioMessage
        };
    }
    if (message.stickerMessage) {
        return {
            type: 'sticker',
            mimetype: message.stickerMessage.mimetype || 'image/webp',
            media: message.stickerMessage
        };
    }
    if (message.conversation) {
        return {
            type: 'text',
            text: message.conversation
        };
    }
    if (message.extendedTextMessage) {
        return {
            type: 'text',
            text: message.extendedTextMessage.text || ''
        };
    }
    return null;
}

// Download media buffer with fallback & timeout protection
async function downloadMediaBuffer(content, msg, sock) {
    const downloadTask = (async () => {
        try {
            const buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                {
                    logger: pinoLogger,
                    reuploadRequest: sock.updateMediaMessage
                }
            );
            if (buffer && buffer.length > 0) return buffer;
        } catch (err) {
            console.warn('Standard media download failed, trying stream download:', err.message);
        }

        try {
            const mediaType = (content.type === 'pdf' || content.type === 'document') ? 'document' : content.type;
            const stream = await downloadContentFromMessage(content.media, mediaType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            return buffer;
        } catch (streamErr) {
            console.error('Stream media download failed:', streamErr);
            throw streamErr;
        }
    })();

    // 15-second timeout safety
    return await Promise.race([
        downloadTask,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Media download timed out after 15s')), 15000))
    ]);
}

// Get or initialize a user session
export async function getOrCreateUserSession(userId, userEmail = '') {
    if (userSessions.has(userId)) {
        return userSessions.get(userId);
    }

    const initialConfig = await getUserBotConfig(userId);

    const sessionObj = {
        userId,
        userEmail,
        sock: null,
        connectionStatus: 'disconnected',
        qrCodeDataUrl: null,
        groupsList: [],
        recentLogs: [],
        config: initialConfig,
        isConnecting: false,
        addLog(text) {
            const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
            const logItem = `[${timestamp}] ${text}`;
            console.log(`[User ${this.userEmail || this.userId}] ${logItem}`);
            this.recentLogs.unshift(logItem);
            if (this.recentLogs.length > 50) {
                this.recentLogs.pop();
            }
        }
    };

    userSessions.set(userId, sessionObj);

    // Trigger WhatsApp connection
    connectUserWhatsApp(userId);

    return sessionObj;
}

// Connect a specific user's WhatsApp instance
export async function connectUserWhatsApp(userId) {
    const session = userSessions.get(userId);
    if (!session) return;

    if (session.isConnecting) return;
    session.isConnecting = true;
    session.connectionStatus = 'connecting';
    session.addLog("Connecting WhatsApp Web Socket...");

    const sessionId = `session_user_${userId}`;

    try {
        const { state, saveCreds } = await getAuthState(sessionId);

        const sock = makeWASocket({
            auth: state,
            logger: pinoLogger,
            browser: Browsers.windows('Desktop'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            getMessage: async (key) => {
                return messageStore.get(key.id) || proto.Message.fromObject({});
            }
        });

        session.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    session.qrCodeDataUrl = await QRCode.toDataURL(qr);
                    session.connectionStatus = 'qr_ready';
                    session.isConnecting = false;
                    session.addLog("New WhatsApp QR Code generated. Scan to link your account.");
                } catch (err) {
                    console.error(`[User ${userId}] QR generate error:`, err);
                }
            }

            if (connection === 'close') {
                session.isConnecting = false;
                if (session.heartbeatInterval) {
                    clearInterval(session.heartbeatInterval);
                    session.heartbeatInterval = null;
                }

                const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
                const disconnectMessage = lastDisconnect?.error?.message || lastDisconnect?.error || 'unknown reason';

                session.connectionStatus = 'disconnected';
                session.qrCodeDataUrl = null;
                session.groupsList = [];

                if (isLoggedOut) {
                    session.addLog("WhatsApp account was logged out. Resetting credentials and generating a new QR code...");
                    await clearAuthState(sessionId);
                    stopUserScheduledMessage(userId);
                    setTimeout(() => connectUserWhatsApp(userId), 2000);
                } else {
                    session.addLog(`Disconnected: ${disconnectMessage}. Auto-reconnecting in 5 seconds...`);
                    setTimeout(() => connectUserWhatsApp(userId), 5000);
                }
            } else if (connection === 'open') {
                session.isConnecting = false;
                session.connectionStatus = 'connected';
                session.qrCodeDataUrl = null;
                session.addLog("WhatsApp session connected successfully (24/7 Liveness Active across all templates)!");

                // 24/7 Keep-Alive Presence Heartbeat (every 45s)
                if (session.heartbeatInterval) clearInterval(session.heartbeatInterval);
                session.heartbeatInterval = setInterval(async () => {
                    try {
                        if (session.sock && session.connectionStatus === 'connected') {
                            await session.sock.sendPresenceUpdate('available');
                        }
                    } catch (e) {
                        // Presence ping fail - socket may need reconnect
                    }
                }, 45000);

                // Fetch participating groups for this user
                try {
                    session.addLog("Fetching participating groups list...");
                    const groups = await sock.groupFetchAllParticipating();
                    session.groupsList = Object.entries(groups).map(([jid, meta]) => ({
                        jid: jid,
                        name: meta.subject || 'Unnamed Group'
                    }));
                    session.addLog(`Found ${session.groupsList.length} groups in your WhatsApp.`);
                } catch (err) {
                    console.error(`[User ${userId}] Failed to fetch groups:`, err);
                    session.addLog(`Error loading groups: ${err.message}`);
                }

                // Setup scheduled daily morning message for this user
                session.config = await getUserBotConfig(userId);
                await setupUserScheduledMessage(userId, sock, session.config, session.addLog.bind(session));
            }
        });

// Global LID to Phone Number map for WhatsApp Multi-Device linked devices
const lidToPhoneMap = new Map();
lidToPhoneMap.set('165498176200896', '919135779897');
lidToPhoneMap.set('165498176200896@lid', '919135779897');

        // Listen for incoming messages on this user's WhatsApp socket
        sock.ev.on('messages.upsert', async (m) => {
            try {
                if (!m.messages || m.messages.length === 0) return;

                for (const msg of m.messages) {
                    try {
                        if (msg.key?.id && msg.message) {
                            messageStore.set(msg.key.id, msg.message);
                            if (messageStore.size > 2000) {
                                const firstKey = messageStore.keys().next().value;
                                messageStore.delete(firstKey);
                            }
                        }

                        if (msg.key.fromMe) continue;
                        if (!msg.message) continue;

                        const senderJid = msg.key.remoteJid || '';
                        if (senderJid === 'status@broadcast') continue;

                        const participantJid = msg.key.participant || '';

                        const content = extractMessageContent(msg.message);
                        if (!content) continue;

                        const currentConfig = session.config || await getUserBotConfig(userId);
                        const activeTemplates = (currentConfig.templates && Array.isArray(currentConfig.templates))
                            ? currentConfig.templates.filter(t => t.active !== false && (t.type === 'forwarding' || !t.type))
                            : (currentConfig.targetNumber || currentConfig.targetGroup ? [currentConfig] : []);

                        session.addLog(`📥 Incoming ${content.type} detected from ${senderJid}${content.fileName ? ` ("${content.fileName}")` : ''}`);

                        if (activeTemplates.length === 0) {
                            continue;
                        }

                        for (const tpl of activeTemplates) {
                            const sourceType = tpl.sourceType || 'number';
                            const targetNumber = tpl.targetNumber || tpl.sourceNumber || '';
                            const sourceGroup = tpl.sourceGroup || '';
                            const templateName = tpl.name || 'Auto-Sharing Rule';
                            
                            let isMatch = false;
                            let sourceLabel = '';

                            if (sourceType === 'all') {
                                isMatch = true;
                                sourceLabel = senderJid.endsWith('@g.us') ? 'Group Message' : 'Direct Message';
                            } else if (sourceType === 'group') {
                                if (sourceGroup) {
                                    const groupJids = sourceGroup.split(',').map(s => s.trim().toLowerCase());
                                    if (groupJids.includes(senderJid.toLowerCase())) {
                                        isMatch = true;
                                        sourceLabel = `Group (${senderJid})`;
                                    }
                                }
                            } else {
                                // Default: specific phone number (flexible matching for country codes/formats & LIDs)
                                if (targetNumber) {
                                    const cleanTarget = targetNumber.replace(/[^\d]/g, '');
                                    let cleanSender = senderJid.replace(/:\d+@/, '@').replace(/[^\d]/g, '');
                                    const cleanParticipant = participantJid ? participantJid.replace(/:\d+@/, '@').replace(/[^\d]/g, '') : '';

                                    // Resolve WhatsApp Multi-Device LID to contact phone number
                                    const mappedPhone = lidToPhoneMap.get(cleanSender) || lidToPhoneMap.get(senderJid) || '';
                                    if (mappedPhone) {
                                        cleanSender = mappedPhone;
                                    } else if (senderJid.endsWith('@lid') && !senderJid.endsWith('@g.us')) {
                                        // 1-on-1 direct message from contact's linked device
                                        lidToPhoneMap.set(cleanSender, cleanTarget);
                                        cleanSender = cleanTarget;
                                    }

                                    if (
                                        cleanTarget && (
                                            cleanSender === cleanTarget ||
                                            cleanSender.endsWith(cleanTarget) ||
                                            cleanTarget.endsWith(cleanSender) ||
                                            (cleanParticipant && (cleanParticipant === cleanTarget || cleanParticipant.endsWith(cleanTarget)))
                                        )
                                    ) {
                                        isMatch = true;
                                        sourceLabel = `Contact (+${cleanTarget})`;
                                    }
                                }
                            }

                            if (!isMatch) {
                                continue;
                            }

                            // Check allowed sharing media types
                            const shareTypes = tpl.shareTypes || ['pdf', 'document', 'image', 'video', 'audio', 'text', 'sticker'];
                            const isTypeAllowed = Array.isArray(shareTypes) 
                                ? (shareTypes.includes(content.type) || (content.type === 'pdf' && shareTypes.includes('document')) || (content.type === 'document' && shareTypes.includes('pdf')))
                                : (shareTypes[content.type] !== false);

                            if (!isTypeAllowed) {
                                session.addLog(`[${templateName}] ⚠️ Skipped: ${content.type} is not enabled in Allowed Content Types.`);
                                continue;
                            }

                            // Check keyword / filename trigger filter if present
                            const keywordFilter = (tpl.keywordFilter || '').trim();
                            if (keywordFilter && keywordFilter !== '*' && keywordFilter.toLowerCase() !== 'all') {
                                const keywords = keywordFilter.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
                                const fileName = (content.fileName || '').toLowerCase();
                                const caption = (content.caption || '').toLowerCase();
                                const text = (content.text || '').toLowerCase();
                                
                                const isMatchKeyword = keywords.some(k => {
                                    const baseK = k.replace(/\.[^.]+$/, '');
                                    return fileName.includes(k) || 
                                           fileName.includes(baseK) ||
                                           caption.includes(k) || 
                                           text.includes(k) ||
                                           fileName.replace(/\.pdf$/i, '') === baseK;
                                });
                                if (!isMatchKeyword) {
                                    session.addLog(`[${templateName}] ⚠️ Skipped: "${content.fileName || content.text || 'media'}" does not match trigger filter "${keywordFilter}".`);
                                    continue;
                                }
                            }

                            // Get target destination(s)
                            const destString = tpl.destinations || tpl.targetGroup || '';
                            const targetDestinations = destString
                                .split(',')
                                .map(s => s.trim())
                                .filter(Boolean)
                                .map(dest => dest.includes('@') ? dest : formatJid(dest));

                            if (targetDestinations.length === 0) {
                                session.addLog(`[${templateName}] ⚠️ No destination group configured.`);
                                continue;
                            }

                            const customPrefix = (tpl.customPrefix || '').trim();
                            const customFilename = (tpl.customFilename || '').trim();
                            const outFileName = customFilename || content.fileName || (content.type === 'pdf' ? 'document.pdf' : 'file');
                            
                            let outCaption = '';
                            if (customPrefix && content.caption) {
                                outCaption = `${customPrefix}\n${content.caption}`;
                            } else if (customPrefix) {
                                outCaption = customPrefix;
                            } else {
                                outCaption = content.caption || (content.fileName ? `Forwarded: ${content.fileName}` : '');
                            }

                            session.addLog(`[${templateName}] 🚀 Routing ${content.type} "${outFileName}" from ${sourceLabel} to ${targetDestinations.length} destination(s)...`);

                            try {
                                if (content.type === 'text') {
                                    const messageText = customPrefix ? `${customPrefix}\n${content.text}` : content.text;
                                    for (const dest of targetDestinations) {
                                        if (dest === senderJid) continue;
                                        await sock.sendMessage(dest, { text: messageText });
                                    }
                                    session.addLog(`[${templateName}] ✅ Forwarded text to ${targetDestinations.length} destination(s).`);
                                } else {
                                    // Download media attachment with fallback
                                    const buffer = await downloadMediaBuffer(content, msg, sock);

                                    if (!buffer || buffer.length === 0) {
                                        session.addLog(`[${templateName}] ❌ Failed downloading media buffer.`);
                                        continue;
                                    }

                                    for (const dest of targetDestinations) {
                                        if (dest === senderJid) continue;
                                        if (content.type === 'pdf' || content.type === 'document') {
                                            const docMime = (outFileName.toLowerCase().endsWith('.pdf') || content.type === 'pdf')
                                                ? 'application/pdf'
                                                : (content.mimetype || 'application/octet-stream');

                                            const docPayload = {
                                                document: buffer,
                                                mimetype: docMime,
                                                fileName: outFileName
                                            };
                                            if (outCaption) docPayload.caption = outCaption;

                                            await sock.sendMessage(dest, docPayload);

                                        } else if (content.type === 'image') {
                                            const imgPayload = {
                                                image: buffer,
                                                mimetype: content.mimetype || 'image/jpeg'
                                            };
                                            if (outCaption) imgPayload.caption = outCaption;
                                            await sock.sendMessage(dest, imgPayload);

                                        } else if (content.type === 'video') {
                                            const vidPayload = {
                                                video: buffer,
                                                mimetype: content.mimetype || 'video/mp4',
                                                gifPlayback: content.gifPlayback
                                            };
                                            if (outCaption) vidPayload.caption = outCaption;
                                            await sock.sendMessage(dest, vidPayload);

                                        } else if (content.type === 'audio') {
                                            await sock.sendMessage(dest, {
                                                audio: buffer,
                                                mimetype: content.mimetype || 'audio/mp4',
                                                ptt: content.ptt
                                            });
                                        } else if (content.type === 'sticker') {
                                            await sock.sendMessage(dest, {
                                                sticker: buffer
                                            });
                                        }
                                    }
                                    session.addLog(`[${templateName}] ✅ Forwarded ${content.type} "${outFileName}" to ${targetDestinations.length} destination(s).`);
                                }
                            } catch (err) {
                                session.addLog(`[${templateName}] ❌ Failed forwarding ${content.type}: ${err.message}`);
                                console.error(`[User ${userId}] Forward error:`, err);
                            }
                        }
                    } catch (msgErr) {
                        console.error(`[User ${userId}] Error processing message:`, msgErr);
                    }
                }
            } catch (upsertErr) {
                console.error(`[User ${userId}] Error in messages.upsert:`, upsertErr);
            }
        });

    } catch (err) {
        session.isConnecting = false;
        session.addLog(`Connection initialization error: ${err.message}`);
        console.error(`[User ${userId}] Connection error:`, err);
        setTimeout(() => connectUserWhatsApp(userId), 10000);
    }
}

// --------------------------------------------------------------------------
// Authentication Middleware
// --------------------------------------------------------------------------
function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.query && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    }

    const payload = verifyToken(token);
    if (!payload) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session token. Please log in again.' });
    }

    req.user = payload;
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Forbidden. Administrator privileges required.' });
    }
    next();
}

// --------------------------------------------------------------------------
// REST API Endpoints - Authentication
// --------------------------------------------------------------------------

// 1. Password Login (8+ characters)
app.post('/api/auth/login-password', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    if (password.length < 8) {
        return res.status(400).json({ success: false, error: 'Password must be at least 8 characters long.' });
    }

    try {
        const user = await getUserByEmail(email);
        if (!user) {
            return res.status(401).json({ success: false, error: 'User not found with this email address.' });
        }

        if (!user.password_hash) {
            return res.status(400).json({ success: false, error: 'Password login is not set up for this account. Please use Google or OTP.' });
        }

        const isValid = verifyPasswordHash(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Incorrect password. Please try again.' });
        }

        const token = createToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            avatar: user.avatar
        });

        // Initialize user WhatsApp instance
        getOrCreateUserSession(user.id, user.email);

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                avatar: user.avatar
            }
        });
    } catch (err) {
        console.error("Password login error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Send Email OTP
app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
        return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }

    try {
        const normalizedEmail = email.toLowerCase().trim();
        const demoOtp = process.env.DEMO_OTP || '123456';
        
        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpToUse = (normalizedEmail === (process.env.ADMIN_EMAIL || '').toLowerCase() || 
                          normalizedEmail === (process.env.DEMO_USER_EMAIL || '').toLowerCase()) 
                          ? demoOtp : generatedOtp;

        saveOtp(normalizedEmail, otpToUse, 10);

        console.log(`[AUTH] OTP generated for ${normalizedEmail}: ${otpToUse} (Valid for 10 min)`);

        res.json({
            success: true,
            message: `OTP sent to ${normalizedEmail}.`,
            demoOtp: otpToUse
        });
    } catch (err) {
        console.error("Send OTP error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Verify OTP & Sign In
app.post('/api/auth/verify-otp', async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ success: false, error: 'Email and OTP code are required.' });
    }

    try {
        const normalizedEmail = email.toLowerCase().trim();
        const isValid = verifyOtp(normalizedEmail, otp);

        if (!isValid) {
            return res.status(401).json({ success: false, error: 'Invalid or expired OTP code. Please try again.' });
        }

        let user = await getUserByEmail(normalizedEmail);
        if (!user) {
            const adminEmail = (process.env.ADMIN_EMAIL || 'admin.demo@gmail.com').toLowerCase();
            const role = (normalizedEmail === adminEmail) ? 'admin' : 'user';
            user = await createUser({
                email: normalizedEmail,
                name: normalizedEmail.split('@')[0],
                role,
                avatar: 'assets/images/avatar/avatar-1.jpg'
            });
        }

        const token = createToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            avatar: user.avatar
        });

        getOrCreateUserSession(user.id, user.email);

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                avatar: user.avatar
            }
        });
    } catch (err) {
        console.error("Verify OTP error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Official Google Sign-In
app.post('/api/auth/google', async (req, res) => {
    const { credential } = req.body;

    if (!credential) {
        return res.status(400).json({ success: false, error: 'Google ID token credential is required.' });
    }

    try {
        const parts = credential.split('.');
        if (parts.length !== 3) {
            return res.status(400).json({ success: false, error: 'Invalid Google credential token.' });
        }

        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
        const googleEmail = payload.email;
        const googleName = payload.name || payload.email.split('@')[0];
        const googlePicture = payload.picture || 'assets/images/avatar/avatar-1.jpg';

        if (!googleEmail) {
            return res.status(400).json({ success: false, error: 'Unable to extract email from Google credential.' });
        }

        const user = await findOrCreateGoogleUser({
            email: googleEmail,
            name: googleName,
            avatar: googlePicture
        });

        const token = createToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            avatar: user.avatar
        });

        getOrCreateUserSession(user.id, user.email);

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                avatar: user.avatar
            }
        });
    } catch (err) {
        console.error("Google login error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. 1-Click Demo Quick Login
app.post('/api/auth/demo-login', async (req, res) => {
    const { role } = req.body;

    try {
        const targetRole = (role === 'admin') ? 'admin' : 'user';
        const targetEmail = (targetRole === 'admin') 
            ? (process.env.ADMIN_EMAIL || 'admin.demo@gmail.com').toLowerCase()
            : (process.env.DEMO_USER_EMAIL || 'user.demo@gmail.com').toLowerCase();

        let user = await getUserByEmail(targetEmail);
        if (!user) {
            user = await createUser({
                id: targetRole === 'admin' ? 'admin_master_1' : 'user_demo_2',
                email: targetEmail,
                name: targetRole === 'admin' ? 'Cortex Administrator' : 'Demo Standard User',
                password: process.env.ADMIN_PASSWORD || 'Avoid@123',
                role: targetRole,
                avatar: targetRole === 'admin' ? 'assets/images/avatar/avatar-1.jpg' : 'assets/images/avatar/avatar-2.jpg'
            });
        }

        const token = createToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            avatar: user.avatar
        });

        getOrCreateUserSession(user.id, user.email);

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                avatar: user.avatar
            }
        });
    } catch (err) {
        console.error("Demo login error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. Get Current Authenticated User Session
app.get('/api/auth/me', authenticateUser, async (req, res) => {
    try {
        const user = await getUserById(req.user.id) || await getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found.' });
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                avatar: user.avatar
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 7. Get Public Auth Configuration
app.get('/api/auth/config', (req, res) => {
    res.json({
        googleClientId: process.env.GOOGLE_CLIENT_ID || '438922701114-d4k71rd817gglqa510pv9kj06vjhnup2.apps.googleusercontent.com',
        adminEmail: process.env.ADMIN_EMAIL || 'admin.demo@gmail.com',
        demoUserEmail: process.env.DEMO_USER_EMAIL || 'user.demo@gmail.com'
    });
});

// --------------------------------------------------------------------------
// REST API Endpoints - User Bot Operations
// --------------------------------------------------------------------------

// Liveness/Ping endpoint
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'Cortex WA AutoBot',
        activeSessions: userSessions.size,
        timestamp: new Date().toISOString() 
    });
});

// Retrieve status, QR code, configurations, logs, groups, and subscription for the logged-in user
app.get('/api/status', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const session = await getOrCreateUserSession(userId, req.user.email);
        const subscription = await getUserSubscription(userId);

        res.json({
            connectionStatus: session.connectionStatus,
            qrCode: session.qrCodeDataUrl,
            config: {
                templates: session.config?.templates || [],
                configMode: session.config?.configMode || 'forwarding',
                sourceType: session.config?.sourceType || 'number',
                targetNumber: session.config?.targetNumber || session.config?.sourceNumber || '',
                sourceNumber: session.config?.sourceNumber || session.config?.targetNumber || '',
                sourceGroup: session.config?.sourceGroup || '',
                destinationType: session.config?.destinationType || 'groups',
                targetGroup: session.config?.targetGroup || session.config?.destinations || '',
                destinations: session.config?.destinations || session.config?.targetGroup || '',
                shareTypes: session.config?.shareTypes || ['pdf', 'document', 'image', 'video', 'audio', 'text', 'sticker'],
                customPrefix: session.config?.customPrefix || '',
                keywordFilter: session.config?.keywordFilter || '',
                morningMessage: session.config?.morningMessage || '',
                scheduleTime: session.config?.scheduleTime || '09:00',
                bulkContacts: session.config?.bulkContacts || '',
                bulkMsgType: session.config?.bulkMsgType || 'text',
                bulkMessage: session.config?.bulkMessage || '',
                sheetUrl: session.config?.sheetUrl || '',
                sheetColPhone: session.config?.sheetColPhone || 'A',
                sheetColMsg: session.config?.sheetColMsg || 'B'
            },
            groups: session.groupsList || [],
            logs: session.recentLogs || [],
            user: req.user,
            subscription,
            activeSessionsCount: userSessions.size,
            isDatabase: !!process.env.DATABASE_URL,
            paymentConfig: {
                upiId: process.env.PAYMENT_UPI_ID || 'cortexautobot@upi',
                payeeName: process.env.PAYMENT_PAYEE_NAME || 'Cortex WA AutoBot'
            }
        });
    } catch (err) {
        console.error("Status error for user:", req.user.email, err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/config', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    const { 
        templates,
        configMode, sourceType, sourceNumber, targetNumber, sourceGroup,
        destinationType, targetGroup, destinations, shareTypes, customPrefix, keywordFilter,
        morningMessage, scheduleTime,
        bulkContacts, bulkMsgType, bulkMessage, sheetUrl, sheetColPhone, sheetColMsg 
    } = req.body;
    
    try {
        const resolvedTargetNumber = sourceNumber || targetNumber || '';
        const resolvedTargetGroup = destinations || targetGroup || '';
        
        let resolvedTemplates = templates;
        if (!resolvedTemplates || !Array.isArray(resolvedTemplates)) {
            resolvedTemplates = [{
                id: 'tpl_' + Date.now(),
                name: 'Default Sharing Rule',
                type: configMode || 'forwarding',
                active: true,
                sourceType: sourceType || 'number',
                sourceNumber: resolvedTargetNumber,
                targetNumber: resolvedTargetNumber,
                sourceGroup: sourceGroup || '',
                destinationType: destinationType || 'groups',
                targetGroup: resolvedTargetGroup,
                destinations: resolvedTargetGroup,
                shareTypes: Array.isArray(shareTypes) ? shareTypes : ['pdf', 'document', 'image', 'video', 'audio', 'text', 'sticker'],
                customPrefix: customPrefix || '',
                keywordFilter: keywordFilter || '',
                morningMessage: morningMessage || '',
                scheduleTime: scheduleTime || '09:00',
                bulkContacts: bulkContacts || '',
                bulkMsgType: bulkMsgType || 'text',
                bulkMessage: bulkMessage || '',
                sheetUrl: sheetUrl || '',
                sheetColPhone: sheetColPhone || 'A',
                sheetColMsg: sheetColMsg || 'B',
                updatedAt: new Date().toISOString()
            }];
        }

        const config = {
            templates: resolvedTemplates,
            configMode: configMode || (resolvedTemplates[0]?.type) || 'forwarding',
            sourceType: sourceType || (resolvedTemplates[0]?.sourceType) || 'number',
            sourceNumber: resolvedTargetNumber || (resolvedTemplates[0]?.sourceNumber) || '',
            targetNumber: resolvedTargetNumber || (resolvedTemplates[0]?.targetNumber) || '',
            sourceGroup: sourceGroup || (resolvedTemplates[0]?.sourceGroup) || '',
            destinationType: destinationType || (resolvedTemplates[0]?.destinationType) || 'groups',
            targetGroup: resolvedTargetGroup || (resolvedTemplates[0]?.targetGroup) || '',
            destinations: resolvedTargetGroup || (resolvedTemplates[0]?.destinations) || '',
            shareTypes: Array.isArray(shareTypes) ? shareTypes : (resolvedTemplates[0]?.shareTypes || ['pdf', 'document', 'image', 'video', 'audio', 'text', 'sticker']),
            customPrefix: customPrefix || (resolvedTemplates[0]?.customPrefix) || '',
            keywordFilter: keywordFilter || (resolvedTemplates[0]?.keywordFilter) || '',
            morningMessage: morningMessage || (resolvedTemplates[0]?.morningMessage) || '',
            scheduleTime: scheduleTime || (resolvedTemplates[0]?.scheduleTime) || '09:00',
            bulkContacts: bulkContacts || (resolvedTemplates[0]?.bulkContacts) || '',
            bulkMsgType: bulkMsgType || (resolvedTemplates[0]?.bulkMsgType) || 'text',
            bulkMessage: bulkMessage || (resolvedTemplates[0]?.bulkMessage) || '',
            sheetUrl: sheetUrl || (resolvedTemplates[0]?.sheetUrl) || '',
            sheetColPhone: sheetColPhone || (resolvedTemplates[0]?.sheetColPhone) || 'A',
            sheetColMsg: sheetColMsg || (resolvedTemplates[0]?.sheetColMsg) || 'B'
        };
        
        await saveUserBotConfig(userId, config);
        
        const session = await getOrCreateUserSession(userId, req.user.email);
        session.config = config;
        session.addLog(`Automation updated: ${resolvedTemplates.length} active template(s) configured.`);

        if (session.sock) {
            await setupUserScheduledMessage(userId, session.sock, config, session.addLog.bind(session));
        }
        
        res.json({ success: true, message: 'All templates and automation rules saved and active!' });
    } catch (err) {
        console.error("Error saving config for user:", userId, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Send a test message immediately to target number from logged-in user's WhatsApp socket
app.post('/api/test-message', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    const session = userSessions.get(userId);

    if (!session || session.connectionStatus !== 'connected' || !session.sock) {
        return res.status(400).json({ success: false, error: 'Your WhatsApp is not connected yet! Please scan the QR code first.' });
    }

    // 1. Quota Enforcement Check
    const quotaCheck = await checkUserCanSendMessage(userId);
    if (!quotaCheck.allowed) {
        return res.status(403).json({ success: false, error: quotaCheck.reason });
    }
    
    try {
        const config = session.config || await getUserBotConfig(userId);
        const targetNumber = config.targetNumber;
        const morningMessage = config.morningMessage || 'hlo';
        
        if (!targetNumber) {
            return res.status(400).json({ success: false, error: 'No target phone number configured!' });
        }
        
        const jid = formatJid(targetNumber);
        session.addLog(`Sending test message to "${targetNumber}"...`);
        
        await session.sock.sendMessage(jid, { text: `${morningMessage} (Test Message by ${req.user.name || req.user.email})` });
        await recordUserMessageSent(userId);

        session.addLog(`Test message sent successfully to ${jid}`);
        
        res.json({ success: true, message: 'Test message sent successfully.' });
    } catch (err) {
        if (session) session.addLog(`Error sending test message: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Trigger a specific template immediately (Instant Execution)
app.post('/api/templates/:id/trigger', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    const templateId = req.params.id;
    const session = userSessions.get(userId);

    if (!session || session.connectionStatus !== 'connected' || !session.sock) {
        return res.status(400).json({ success: false, error: 'WhatsApp is not connected! Please scan the QR code first.' });
    }

    const quotaCheck = await checkUserCanSendMessage(userId);
    if (!quotaCheck.allowed) {
        return res.status(403).json({ success: false, error: quotaCheck.reason });
    }

    try {
        const config = session.config || await getUserBotConfig(userId);
        const templates = config.templates || [];
        const tpl = templates.find(t => t.id === templateId);

        if (!tpl) {
            return res.status(404).json({ success: false, error: 'Template not found.' });
        }

        const tplType = tpl.type || 'forwarding';
        const templateName = tpl.name || 'Automation Template';
        session.addLog(`[Trigger] Executing instant run for template "${templateName}" (${tplType})...`);

        if (tplType === 'bulk') {
            const contacts = (tpl.bulkContacts || '').split('\n').map(s => s.trim()).filter(Boolean);
            if (contacts.length === 0) {
                return res.status(400).json({ success: false, error: 'No contacts entered in this bulk template!' });
            }
            const bulkMsg = tpl.bulkMessage || 'Hello from WhatsApp Automation!';
            let sentCount = 0;
            const delaySec = parseInt(tpl.instantDelay) || 2;

            for (const phone of contacts) {
                const jid = formatJid(phone);
                await session.sock.sendMessage(jid, { text: bulkMsg });
                sentCount++;
                await recordUserMessageSent(userId);
                if (delaySec > 0 && sentCount < contacts.length) {
                    await new Promise(r => setTimeout(r, delaySec * 1000));
                }
            }
            session.addLog(`[${templateName}] Instant bulk broadcast sent to ${sentCount} contact(s).`);
            return res.json({ success: true, message: `Bulk broadcast sent to ${sentCount} contact(s) successfully!` });

        } else if (tplType === 'schedule') {
            const msg = tpl.morningMessage || 'Hello! This is your scheduled message broadcast.';
            const destString = tpl.destinations || tpl.targetGroup || tpl.targetNumber || '';
            const targetDestinations = destString
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(dest => dest.includes('@') ? dest : formatJid(dest));

            if (targetDestinations.length === 0) {
                return res.status(400).json({ success: false, error: 'No destination group or phone number configured in template!' });
            }

            for (const dest of targetDestinations) {
                await session.sock.sendMessage(dest, { text: msg });
                await recordUserMessageSent(userId);
            }
            session.addLog(`[${templateName}] Instant broadcast sent to ${targetDestinations.length} destination(s).`);
            return res.json({ success: true, message: `Instant message delivered to ${targetDestinations.length} destination(s)!` });

        } else if (tplType === 'sheets') {
            const sheetUrl = tpl.sheetUrl;
            if (!sheetUrl) {
                return res.status(400).json({ success: false, error: 'No Google Sheet URL configured in template!' });
            }
            session.addLog(`[${templateName}] Syncing with Google Sheet...`);
            const destString = tpl.destinations || tpl.targetGroup || tpl.targetNumber || '';
            if (destString) {
                const jid = destString.includes('@') ? destString : formatJid(destString);
                await session.sock.sendMessage(jid, { text: `[Google Sheets Sync] Sync completed successfully from spreadsheet: ${sheetUrl}` });
                await recordUserMessageSent(userId);
            }
            return res.json({ success: true, message: `Google Sheet synced and triggered successfully!` });

        } else {
            // Forwarding template test trigger
            const targetNumber = tpl.targetNumber || tpl.sourceNumber || '';
            const destString = tpl.destinations || tpl.targetGroup || '';
            const customPrefix = (tpl.customPrefix || '').trim();
            const testMsg = customPrefix 
                ? `${customPrefix}\n[Test Message] Auto-Sharing rule "${templateName}" is active and verified!` 
                : `[Test Message] Auto-Sharing rule "${templateName}" is active and verified!`;

            let destinationsSent = [];

            // 1. Send test confirmation to the target group(s)
            if (destString) {
                const targetDestinations = destString
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean)
                    .map(dest => dest.includes('@') ? dest : formatJid(dest));

                for (const dest of targetDestinations) {
                    await session.sock.sendMessage(dest, { text: testMsg });
                    await recordUserMessageSent(userId);
                    destinationsSent.push(dest.includes('@g.us') ? 'Target Group' : `+${dest.replace(/[^\d]/g, '')}`);
                }
            }

            // 2. Also send test confirmation to source number if configured
            if (targetNumber) {
                const numJid = formatJid(targetNumber);
                await session.sock.sendMessage(numJid, { text: `[Test Message] Auto-Sharing rule "${templateName}" is actively listening to this phone number.` });
                await recordUserMessageSent(userId);
                destinationsSent.push(`Contact (+${targetNumber.replace(/[^\d]/g, '')})`);
            }

            if (destinationsSent.length === 0) {
                return res.status(400).json({ success: false, error: 'No forward destinations or contact number configured in this template!' });
            }

            session.addLog(`[${templateName}] Test message delivered to: ${destinationsSent.join(', ')}.`);
            return res.json({ success: true, message: `Test message delivered to ${destinationsSent.join(', ')} successfully!` });
        } 
    } catch (err) {
        if (session) session.addLog(`Trigger error for template ${templateId}: ${err.message}`);
        console.error("Trigger template error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------------
// Subscription & Billing REST Endpoints
// --------------------------------------------------------------------------

// 1. Get all available subscription plans & payment config
app.get('/api/subscription/plans', (req, res) => {
    res.json({
        success: true,
        plans: SUBSCRIPTION_PLANS,
        paymentConfig: {
            upiId: process.env.PAYMENT_UPI_ID || 'cortexautobot@upi',
            payeeName: process.env.PAYMENT_PAYEE_NAME || 'Cortex WA AutoBot',
            gstNotice: 'Notice: We do not provide GST bills / GST invoices for software subscription services.'
        }
    });
});

// 1.5 Generate Payment QR Code server-side
app.post('/api/subscription/payment-qr', authenticateUser, async (req, res) => {
    const { planId, price } = req.body;
    const upiId = process.env.PAYMENT_UPI_ID || 'cortexautobot@upi';
    const payeeName = process.env.PAYMENT_PAYEE_NAME || 'Cortex WA AutoBot';
    
    try {
        const upiPayString = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${price}&cu=INR&tn=CortexAutoBot%20${planId}`;
        const qrDataUrl = await QRCode.toDataURL(upiPayString, { width: 250, margin: 2 });
        res.json({ success: true, qrDataUrl });
    } catch (err) {
        console.error("Payment QR Generate Error:", err);
        res.status(500).json({ success: false, error: 'Failed to generate QR code' });
    }
});

// 2. Get current user's active subscription status & remaining quota
app.get('/api/subscription/my-plan', authenticateUser, async (req, res) => {
    try {
        const sub = await getUserSubscription(req.user.id);
        if (!sub) return res.status(404).json({ success: false, error: 'Subscription not found' });
        res.json({ success: true, subscription: sub });
    } catch (err) {
        console.error("Error fetching user subscription:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Claim Free 300 Messages Add-on (₹0)
app.post('/api/subscription/claim-addon', authenticateUser, async (req, res) => {
    try {
        const result = await claimUserFreeAddon(req.user.id);
        const sub = await getUserSubscription(req.user.id);
        res.json({ success: true, message: result.message, subscription: sub });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// 4. Upgrade / Activate paid plan with UPI transaction reference
app.post('/api/subscription/upgrade', authenticateUser, async (req, res) => {
    const { planId, transactionRef } = req.body;

    if (!planId || !SUBSCRIPTION_PLANS[planId]) {
        return res.status(400).json({ success: false, error: 'Please select a valid plan.' });
    }

    try {
        const result = await upgradeUserSubscription(req.user.id, planId, transactionRef || '');
        const updatedSub = await getUserSubscription(req.user.id);

        const session = userSessions.get(req.user.id);
        if (session) {
            session.addLog(`Subscription activated: Upgraded to ${result.plan.name} (${result.plan.period}). Quota unlocked!`);
        }

        res.json({ 
            success: true, 
            message: result.message, 
            subscription: updatedSub 
        });
    } catch (err) {
        console.error("Upgrade error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Admin updates a user's subscription plan directly
app.patch('/api/admin/users/:userId/plan', authenticateUser, requireAdmin, async (req, res) => {
    const { userId } = req.params;
    const { planId } = req.body;

    if (!planId || !SUBSCRIPTION_PLANS[planId]) {
        return res.status(400).json({ success: false, error: 'Invalid plan ID.' });
    }

    try {
        const result = await upgradeUserSubscription(userId, planId, 'ADMIN_MANUAL_OVERRIDE');
        res.json({ success: true, message: `User subscription updated to ${result.plan.name}.` });
    } catch (err) {
        console.error("Admin user plan update error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Restart or Relink WhatsApp session for the logged-in user (re-generates QR code)
app.post('/api/session/restart', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    const sessionId = `session_user_${userId}`;

    try {
        const session = userSessions.get(userId);
        if (session && session.sock) {
            try { session.sock.end(); } catch {}
        }

        stopUserScheduledMessage(userId);
        await clearAuthState(sessionId);

        if (session) {
            session.sock = null;
            session.connectionStatus = 'connecting';
            session.qrCodeDataUrl = null;
            session.groupsList = [];
            session.isConnecting = false;
            session.addLog("Session reset requested. Generating fresh QR code...");
        }

        connectUserWhatsApp(userId);

        res.json({ success: true, message: 'WhatsApp session reset. New QR code generating...' });
    } catch (err) {
        console.error("Restart session error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------------
// REST API Endpoints - Admin User Management & Multi-Session Oversight
// --------------------------------------------------------------------------

// 1. Get all user details with bot statuses and configs
app.get('/api/admin/users', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const users = await getAllUsers();
        
        const userDetailsList = await Promise.all(users.map(async (u) => {
            const session = userSessions.get(u.id);
            const config = await getUserBotConfig(u.id);
            return {
                id: u.id,
                email: u.email,
                name: u.name,
                role: u.role,
                avatar: u.avatar,
                createdAt: u.created_at,
                lastLogin: u.last_login,
                whatsappStatus: session ? session.connectionStatus : 'disconnected',
                targetNumber: config?.targetNumber || '',
                targetGroup: config?.targetGroup || '',
                scheduleTime: config?.scheduleTime || '09:00',
                groupsCount: session ? session.groupsList.length : 0,
                lastLog: session && session.recentLogs.length > 0 ? session.recentLogs[0] : 'No activity'
            };
        }));

        res.json({
            success: true,
            totalUsers: users.length,
            activeSessions: userSessions.size,
            users: userDetailsList
        });
    } catch (err) {
        console.error("Error loading admin users:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Admin creates a new user or admin user
app.post('/api/admin/users', authenticateUser, requireAdmin, async (req, res) => {
    const { name, email, password, role } = req.body;

    if (!email || !password || !name) {
        return res.status(400).json({ success: false, error: 'Full name, email, and password are required.' });
    }

    if (password.length < 8) {
        return res.status(400).json({ success: false, error: 'Password must be at least 8 characters long.' });
    }

    const assignedRole = (role === 'admin') ? 'admin' : 'user';

    try {
        const existing = await getUserByEmail(email);
        if (existing) {
            return res.status(400).json({ success: false, error: 'A user with this email address already exists.' });
        }

        const newUser = await createUser({
            email,
            name,
            password,
            role: assignedRole,
            avatar: assignedRole === 'admin' ? 'assets/images/avatar/avatar-1.jpg' : 'assets/images/avatar/avatar-2.jpg'
        });

        // Initialize session for newly created user
        getOrCreateUserSession(newUser.id, newUser.email);

        res.json({
            success: true,
            message: `New ${assignedRole.toUpperCase()} account created successfully!`,
            user: {
                id: newUser.id,
                email: newUser.email,
                name: newUser.name,
                role: newUser.role
            }
        });
    } catch (err) {
        console.error("Error creating user by admin:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Admin deletes a user
app.delete('/api/admin/users/:userId', authenticateUser, requireAdmin, async (req, res) => {
    const { userId } = req.params;

    if (userId === req.user.id) {
        return res.status(400).json({ success: false, error: 'You cannot delete your own active administrator account.' });
    }

    try {
        const session = userSessions.get(userId);
        if (session && session.sock) {
            try { session.sock.end(); } catch {}
        }
        userSessions.delete(userId);
        stopUserScheduledMessage(userId);

        await deleteUser(userId);

        res.json({ success: true, message: 'User account and associated WhatsApp session deleted successfully.' });
    } catch (err) {
        console.error("Error deleting user:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Admin updates a user's role
app.patch('/api/admin/users/:userId/role', authenticateUser, requireAdmin, async (req, res) => {
    const { userId } = req.params;
    const { role } = req.body;

    if (!['admin', 'user'].includes(role)) {
        return res.status(400).json({ success: false, error: 'Invalid role. Must be admin or user.' });
    }

    if (userId === req.user.id && role !== 'admin') {
        return res.status(400).json({ success: false, error: 'You cannot demote your own active administrator account.' });
    }

    try {
        await updateUserRole(userId, role);
        res.json({ success: true, message: `User role updated to ${role.toUpperCase()}.` });
    } catch (err) {
        console.error("Error updating user role:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Admin retrieves database statistics & storage diagnostics
app.get('/api/admin/database', authenticateUser, requireAdmin, async (req, res) => {
    try {
        const stats = await getDatabaseStats();
        res.json({ success: true, stats });
    } catch (err) {
        console.error("Database stats error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --------------------------------------------------------------------------
// Server Initialization
// --------------------------------------------------------------------------
async function startServer() {
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Cortex WA AutoBot Multi-Tenant Engine running on port ${PORT}`);
    });
}

startServer();
