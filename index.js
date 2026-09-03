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
    SUBSCRIPTION_PLANS,
    updateUserPassword
} from './database.js';
import { setupUserScheduledMessage, stopUserScheduledMessage } from './scheduler.js';
import { dispatchGoogleSheetAutomation, previewGoogleSheetRows, listGoogleSheetNames } from './sheets_engine.js';

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

// Helper to extract message content of all types (PDF/Docs, Images, Videos, Audio, Text)
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
        const mime = (message.documentMessage.mimetype || 'application/pdf').toLowerCase();
        const rawFileName = message.documentMessage.fileName || '';
        const lowerName = rawFileName.toLowerCase();
        let type = 'document';
        if (mime.includes('pdf') || lowerName.endsWith('.pdf')) {
            type = 'pdf';
        } else if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|tiff|heic)$/i.test(lowerName)) {
            type = 'image';
        } else if (mime.startsWith('video/') || /\.(mp4|mkv|mov|avi|webm|3gp)$/i.test(lowerName)) {
            type = 'video';
        } else if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|opus|aac|m4a)$/i.test(lowerName)) {
            type = 'audio';
        }
        return {
            type: type,
            mimetype: mime,
            fileName: rawFileName || (type === 'pdf' ? 'document.pdf' : (type === 'image' ? 'image.jpg' : (type === 'video' ? 'video.mp4' : 'file'))),
            caption: message.documentMessage.caption || '',
            media: message.documentMessage
        };
    }
    if (message.imageMessage) {
        const rawFileName = message.imageMessage.fileName || '';
        const ext = (message.imageMessage.mimetype || '').split('/')[1]?.split(';')[0] || 'jpeg';
        return {
            type: 'image',
            mimetype: message.imageMessage.mimetype || 'image/jpeg',
            fileName: rawFileName || `image.${ext === 'jpeg' ? 'jpg' : ext}`,
            caption: message.imageMessage.caption || '',
            media: message.imageMessage
        };
    }
    if (message.videoMessage) {
        const rawFileName = message.videoMessage.fileName || '';
        const ext = (message.videoMessage.mimetype || '').split('/')[1]?.split(';')[0] || 'mp4';
        return {
            type: 'video',
            mimetype: message.videoMessage.mimetype || 'video/mp4',
            fileName: rawFileName || `video.${ext}`,
            caption: message.videoMessage.caption || '',
            gifPlayback: message.videoMessage.gifPlayback || false,
            media: message.videoMessage
        };
    }
    if (message.audioMessage) {
        const rawFileName = message.audioMessage.fileName || '';
        const ext = (message.audioMessage.mimetype || '').includes('ogg') ? 'ogg' : 'mp3';
        return {
            type: 'audio',
            mimetype: message.audioMessage.mimetype || 'audio/mp4',
            fileName: rawFileName || (message.audioMessage.ptt ? 'voice_note.opus' : `audio.${ext}`),
            ptt: message.audioMessage.ptt || false,
            media: message.audioMessage
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

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exact filename & text trigger matching
function matchesTriggerFilter(filterString, content) {
    const rawFilter = (filterString || '').trim();
    if (!rawFilter || rawFilter === '*' || rawFilter.toLowerCase() === 'all') {
        return true;
    }

    const keywords = rawFilter.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.length === 0) return true;

    const rawFileName = (content.fileName || '').trim().toLowerCase();
    const rawCaption = (content.caption || '').trim().toLowerCase();
    const rawText = (content.text || '').trim().toLowerCase();

    return keywords.some(k => {
        if (k === '*' || k === 'all') return true;

        // If content is a file (pdf, document, image, video, audio):
        if (content.type === 'pdf' || content.type === 'document' || content.type === 'image' || content.type === 'video' || content.type === 'audio') {
            // Check exact file name
            if (rawFileName) {
                // Exact filename match (e.g. filter 'a.pdf' matches file 'a.pdf', 'a.png' matches 'a.png')
                if (rawFileName === k) return true;

                // Support WhatsApp auto-numbered copy/duplicate suffix (e.g. "a (1).pdf" or "a-1.pdf" when filter is "a.pdf")
                if (k.includes('.')) {
                    const ext = k.split('.').pop();
                    const stem = k.slice(0, -(ext.length + 1));
                    const duplicateRegex = new RegExp('^' + escapeRegExp(stem) + '(\\s*[\\(\\-_]\\s*\\d+\\s*\\)?)*\\.' + escapeRegExp(ext) + '$', 'i');
                    if (duplicateRegex.test(rawFileName)) return true;
                }
            }

            // Also check caption if caption exactly equals k
            if (rawCaption && rawCaption === k) {
                return true;
            }

            return false;
        }

        // If content is a text message:
        if (content.type === 'text') {
            // Exact text match: "if it is a then it have to be a"
            return rawText === k;
        }

        return false;
    });
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

// Robust international/national phone number comparison
function isSamePhoneNumber(phone1, phone2) {
    if (!phone1 || !phone2) return false;
    const clean1 = String(phone1).replace(/[^\d]/g, '');
    const clean2 = String(phone2).replace(/[^\d]/g, '');
    if (!clean1 || !clean2) return false;
    if (clean1 === clean2) return true;
    
    // Country code tolerance (e.g. 919135779897 vs 9135779897)
    if (clean1.length >= 8 && clean2.length >= 8) {
        if (clean1.endsWith(clean2) || clean2.endsWith(clean1)) {
            const minLen = Math.min(clean1.length, clean2.length);
            if (minLen >= 8) return true;
        }
    }
    return false;
}

        // Dynamically learn contact LIDs and Phone numbers from WhatsApp contact sync
        sock.ev.on('contacts.upsert', (contacts) => {
            for (const c of contacts) {
                if (c.id && c.lid) {
                    const p = c.id.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                    const l = c.lid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                    if (p && l) {
                        lidToPhoneMap.set(l, p);
                        lidToPhoneMap.set(`${l}@lid`, p);
                        lidToPhoneMap.set(c.lid, p);
                    }
                }
            }
        });

        sock.ev.on('contacts.update', (contacts) => {
            for (const c of contacts) {
                if (c.id && c.lid) {
                    const p = c.id.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                    const l = c.lid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                    if (p && l) {
                        lidToPhoneMap.set(l, p);
                        lidToPhoneMap.set(`${l}@lid`, p);
                        lidToPhoneMap.set(c.lid, p);
                    }
                }
            }
        });

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

                        const isGroupMsg = senderJid.endsWith('@g.us');
                        const participantJid = msg.key.participant || '';

                        const content = extractMessageContent(msg.message);
                        if (!content) continue;

                        const currentConfig = await getUserBotConfig(userId);
                        session.config = currentConfig;
                        const activeTemplates = (currentConfig.templates && Array.isArray(currentConfig.templates))
                            ? currentConfig.templates.filter(t => t.active !== false && (t.type === 'forwarding' || !t.type))
                            : (currentConfig.targetNumber || currentConfig.targetGroup ? [currentConfig] : []);

                        if (activeTemplates.length === 0) {
                            continue;
                        }

                        for (const tpl of activeTemplates) {
                            const sourceType = tpl.sourceType || 'number';
                            const targetNumberStr = tpl.targetNumber || tpl.sourceNumber || '';
                            const sourceGroupStr = tpl.sourceGroup || '';
                            const templateName = tpl.name || 'Auto-Sharing Rule';
                            
                            let isMatch = false;
                            let sourceLabel = '';

                            if (sourceType === 'all') {
                                // 3. All Chats: matches any chat (direct messages & groups)
                                isMatch = true;
                                sourceLabel = isGroupMsg ? `Group (${senderJid})` : `Direct Chat (${senderJid})`;
                            } else if (sourceType === 'group') {
                                // 2. Specific Group: MUST be from the configured group(s)
                                if (isGroupMsg && sourceGroupStr) {
                                    const allowedGroups = sourceGroupStr
                                        .split(',')
                                        .map(s => s.trim().toLowerCase())
                                        .filter(Boolean);
                                    const currentGroup = senderJid.toLowerCase();
                                    if (allowedGroups.some(g => currentGroup === g || currentGroup.includes(g))) {
                                        isMatch = true;
                                        sourceLabel = `Group (${senderJid})`;
                                    }
                                }
                            } else {
                                // 1. Contact Number: STRICTLY checks 1-on-1 direct messages from specified phone number(s)
                                if (!isGroupMsg && targetNumberStr) {
                                    const targetNumbers = targetNumberStr
                                        .split(',')
                                        .map(n => n.replace(/[^\d]/g, ''))
                                        .filter(Boolean);

                                    let senderPhone = '';
                                    if (senderJid.endsWith('@s.whatsapp.net')) {
                                        senderPhone = senderJid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                                    } else if (senderJid.endsWith('@lid')) {
                                        const cleanLid = senderJid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                                        senderPhone = lidToPhoneMap.get(cleanLid) || lidToPhoneMap.get(senderJid) || '';

                                        // If not cached, query WhatsApp for target numbers to check their LID
                                        if (!senderPhone && sock) {
                                            for (const tNum of targetNumbers) {
                                                try {
                                                    const [waRes] = await sock.onWhatsApp(`${tNum}@s.whatsapp.net`);
                                                    if (waRes && waRes.lid) {
                                                        const tLidClean = waRes.lid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                                                        lidToPhoneMap.set(tLidClean, tNum);
                                                        lidToPhoneMap.set(`${tLidClean}@lid`, tNum);
                                                        lidToPhoneMap.set(waRes.lid, tNum);
                                                        if (tLidClean === cleanLid) {
                                                            senderPhone = tNum;
                                                            break;
                                                        }
                                                    }
                                                } catch (e) {}
                                            }
                                        }
                                    }

                                    if (senderPhone && targetNumbers.some(targetNum => isSamePhoneNumber(senderPhone, targetNum))) {
                                        isMatch = true;
                                        sourceLabel = `Contact (+${senderPhone})`;
                                    }
                                }
                            }

                            if (!isMatch) {
                                continue;
                            }

                            session.addLog(`[${templateName}] 🎯 Matched source: ${sourceLabel} (incoming ${content.type}${content.fileName ? ` "${content.fileName}"` : ''})`);

                            // Check allowed sharing media types
                            const shareTypes = tpl.shareTypes || ['pdf', 'document', 'image', 'video', 'audio', 'text'];
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
                                const isMatchKeyword = matchesTriggerFilter(keywordFilter, content);
                                if (!isMatchKeyword) {
                                    session.addLog(`[${templateName}] 🛑 Skipped & Blocked: "${content.fileName || content.text || 'media'}" does not match filter "${keywordFilter}". NOT forwarding.`);
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
                                    let deliveredCount = 0;
                                    for (const dest of targetDestinations) {
                                        if (dest === senderJid) continue;
                                        await sock.sendMessage(dest, { text: messageText });
                                        deliveredCount++;
                                    }
                                    if (deliveredCount > 0) {
                                        session.addLog(`[${templateName}] ✅ Forwarded text to ${deliveredCount} destination(s).`);

                                        const notifyTarget = session.config?.notificationTargetNumber || tpl.notificationTargetNumber;
                                        if (notifyTarget) {
                                            try {
                                                const notifyJid = formatJid(notifyTarget);
                                                const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                                const auditText = `🔔 *[Cortex AutoBot Alert]*\n✅ *Action:* Text Message Forwarded\n👤 *Source:* ${sourceLabel}\n👥 *Delivered To:* ${deliveredCount} destination(s)\n⏰ *Time:* ${timeIST} IST`;
                                                sock.sendMessage(notifyJid, { text: auditText }).catch(() => {});
                                            } catch (notifyErr) {
                                                console.warn(`[User ${userId}] Notification alert error:`, notifyErr.message);
                                            }
                                        }
                                    }
                                } else {
                                    // Download media attachment with fallback
                                    const buffer = await downloadMediaBuffer(content, msg, sock);

                                    if (!buffer || buffer.length === 0) {
                                        session.addLog(`[${templateName}] ❌ Failed downloading media buffer.`);
                                        continue;
                                    }

                                    let deliveredCount = 0;
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
                                        }

                                        deliveredCount++;
                                    }
                                    if (deliveredCount > 0) {
                                        session.addLog(`[${templateName}] ✅ Forwarded ${content.type} "${outFileName}" to ${deliveredCount} destination(s).`);

                                        const notifyTarget = session.config?.notificationTargetNumber || tpl.notificationTargetNumber;
                                        if (notifyTarget) {
                                            try {
                                                const notifyJid = formatJid(notifyTarget);
                                                const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                                const auditText = `🔔 *[Cortex AutoBot Alert]*\n✅ *Action:* Message Successfully Forwarded\n📂 *Type:* ${content.type.toUpperCase()} ("${outFileName}")\n👤 *Source:* ${sourceLabel}\n👥 *Delivered To:* ${deliveredCount} destination(s)\n⏰ *Time:* ${timeIST} IST`;
                                                sock.sendMessage(notifyJid, { text: auditText }).catch(() => {});
                                            } catch (notifyErr) {
                                                console.warn(`[User ${userId}] Notification alert error:`, notifyErr.message);
                                            }
                                        }
                                    }
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

// --------------------------------------------------------------------------
// Google Apps Script Webhook Integration (OTP Email & Google Sheet Sync)
// --------------------------------------------------------------------------
async function callGoogleAppsScript(payload) {
    const webAppUrl = (process.env.GOOGLE_SHEET_WEBAPP_URL || '').trim();
    if (!webAppUrl || !webAppUrl.startsWith('http')) {
        console.log(`[GOOGLE APPS SCRIPT] URL not configured in .env. Skipping webhook for action: ${payload.action}`);
        return { success: false, warning: "GOOGLE_SHEET_WEBAPP_URL not configured" };
    }

    try {
        const res = await fetch(webAppUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            redirect: 'follow'
        });
        const data = await res.json();
        console.log(`[GOOGLE APPS SCRIPT] Webhook response (${payload.action}):`, data);
        return data;
    } catch (err) {
        console.error(`[GOOGLE APPS SCRIPT] Webhook failed (${payload.action}):`, err.message);
        return { success: false, error: err.message };
    }
}

async function syncUserToGoogleSheet(user, extra = {}) {
    if (!user) return;
    try {
        let targetContact = extra.targetContact;
        if (!targetContact) {
            try {
                const cfg = await getUserBotConfig(user.id);
                targetContact = cfg?.notificationTargetNumber || cfg?.targetNumber || 'Not Set';
            } catch {
                targetContact = 'Not Set';
            }
        }

        const session = userSessions.get(user.id.toString());
        const waState = session ? session.connectionStatus : 'Offline';

        const payload = {
            action: 'saveUser',
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            plan: user.plan || 'Free Trial (15 msgs/day)',
            messages_sent_today: user.messages_sent_today || 0,
            messages_sent_total: user.messages_sent_total || 0,
            targetContact: targetContact || 'Not Set',
            waState: waState || 'Offline',
            authProvider: extra.authProvider || 'Email',
            created_at: user.created_at || new Date().toISOString()
        };

        callGoogleAppsScript(payload).catch(err => {
            console.warn("[GOOGLE APPS SCRIPT] Async sheet sync error:", err.message);
        });
    } catch (err) {
        console.warn("[GOOGLE APPS SCRIPT] syncUserToGoogleSheet error:", err.message);
    }
}

// In-memory store for pending user registrations awaiting OTP verification
const pendingSignups = new Map();

// 1b. Public User Signup - Step 1: Request OTP via Google Apps Script (HTML Email)
app.post('/api/auth/signup-request-otp', async (req, res) => {
    const { name, email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    if (password.length < 8) {
        return res.status(400).json({ success: false, error: 'Password must be at least 8 characters long.' });
    }

    try {
        const normalizedEmail = email.toLowerCase().trim();
        const existing = await getUserByEmail(normalizedEmail);
        if (existing) {
            return res.status(400).json({ success: false, error: 'An account with this email already exists. Please sign in.' });
        }

        const userName = (name && name.trim()) ? name.trim() : normalizedEmail.split('@')[0];
        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();

        pendingSignups.set(normalizedEmail, {
            name: userName,
            email: normalizedEmail,
            password: password,
            otp: generatedOtp,
            expiresAt: Date.now() + 10 * 60 * 1000
        });

        console.log(`[AUTH SIGNUP] Generated OTP for ${normalizedEmail}: ${generatedOtp} (Valid for 10 min)`);

        // Send OTP via Google Apps Script Web App (Email)
        const emailResult = await callGoogleAppsScript({
            action: 'sendOtp',
            email: normalizedEmail,
            name: userName,
            otp: generatedOtp,
            appName: 'Cortex WA AutoBot'
        });

        res.json({
            success: true,
            message: `OTP sent to ${normalizedEmail}. Please check your email inbox.`,
            emailDelivery: emailResult.success ? 'sent' : 'fallback',
            demoOtp: generatedOtp
        });
    } catch (err) {
        console.error("Signup request OTP error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 1c. Public User Signup - Step 2: Verify OTP, Create User, Sync to Google Sheet "User" Tab
app.post('/api/auth/signup-verify', async (req, res) => {
    const { email, otp } = req.body;

    if (!email || !otp) {
        return res.status(400).json({ success: false, error: 'Email and verification OTP are required.' });
    }

    try {
        const normalizedEmail = email.toLowerCase().trim();
        const pending = pendingSignups.get(normalizedEmail);

        if (!pending) {
            return res.status(400).json({ success: false, error: 'Signup session expired or not found. Please try signing up again.' });
        }

        if (Date.now() > pending.expiresAt) {
            pendingSignups.delete(normalizedEmail);
            return res.status(400).json({ success: false, error: 'Verification code expired. Please request a new code.' });
        }

        const demoOtp = process.env.DEMO_OTP || '123456';
        if (otp.trim() !== pending.otp && otp.trim() !== demoOtp) {
            return res.status(400).json({ success: false, error: 'Invalid verification code. Please check and try again.' });
        }

        // Create user in database
        const newUser = await createUser({
            email: pending.email,
            name: pending.name,
            password: pending.password,
            role: 'user',
            avatar: 'assets/images/avatar/avatar-2.jpg'
        });

        pendingSignups.delete(normalizedEmail);

        // Sync immediately to Google Sheet "User" tab
        syncUserToGoogleSheet(newUser, { authProvider: 'Email OTP' });

        const token = createToken({
            id: newUser.id,
            email: newUser.email,
            name: newUser.name,
            role: newUser.role,
            avatar: newUser.avatar
        });

        getOrCreateUserSession(newUser.id, newUser.email);

        res.json({
            success: true,
            isNewUser: true,
            token,
            user: {
                id: newUser.id,
                email: newUser.email,
                name: newUser.name,
                role: newUser.role,
                avatar: newUser.avatar
            }
        });
    } catch (err) {
        console.error("Signup verify error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 1d. Legacy direct signup fallback
app.post('/api/auth/signup', async (req, res) => {
    const { name, email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    if (password.length < 8) {
        return res.status(400).json({ success: false, error: 'Password must be at least 8 characters long.' });
    }

    try {
        const normalizedEmail = email.toLowerCase().trim();
        const existing = await getUserByEmail(normalizedEmail);
        if (existing) {
            return res.status(400).json({ success: false, error: 'An account with this email already exists. Please sign in.' });
        }

        const userName = (name && name.trim()) ? name.trim() : normalizedEmail.split('@')[0];
        const newUser = await createUser({
            email: normalizedEmail,
            name: userName,
            password,
            role: 'user',
            avatar: 'assets/images/avatar/avatar-2.jpg'
        });

        syncUserToGoogleSheet(newUser, { authProvider: 'Direct Signup' });

        const token = createToken({
            id: newUser.id,
            email: newUser.email,
            name: newUser.name,
            role: newUser.role,
            avatar: newUser.avatar
        });

        getOrCreateUserSession(newUser.id, newUser.email);

        res.json({
            success: true,
            isNewUser: true,
            token,
            user: {
                id: newUser.id,
                email: newUser.email,
                name: newUser.name,
                role: newUser.role,
                avatar: newUser.avatar
            }
        });
    } catch (err) {
        console.error("Signup error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Send Email OTP (Using Google Apps Script Web App)
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

        // Send OTP via Google Apps Script Web App
        await callGoogleAppsScript({
            action: 'sendOtp',
            email: normalizedEmail,
            otp: otpToUse,
            name: normalizedEmail.split('@')[0],
            appName: 'Cortex WA AutoBot'
        });

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

        syncUserToGoogleSheet(user, { authProvider: 'Email OTP' });

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

// 4. Official Google Sign-In (No OTP sent - Google verifies email!)
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

        const isNewUser = !user.password_hash;

        // Sync Google User to Google Sheet "User" tab
        syncUserToGoogleSheet(user, { authProvider: 'Google' });

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
            isNewUser,
            hasPassword: !!user.password_hash,
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

// 4b. Set Account Password for Google User (Create password feature without OTP)
app.post('/api/auth/google-set-password', authenticateUser, async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 8) {
        return res.status(400).json({ success: false, error: 'Password must be at least 8 characters long.' });
    }

    try {
        const success = await updateUserPassword(req.user.id, password);
        if (success) {
            const updatedUser = await getUserById(req.user.id);
            syncUserToGoogleSheet(updatedUser, { authProvider: 'Google + Password' });
            res.json({ success: true, message: 'Password set successfully.' });
        } else {
            res.status(500).json({ success: false, error: 'Could not update password.' });
        }
    } catch (err) {
        console.error("Google set password error:", err);
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
                notificationTargetNumber: session.config?.notificationTargetNumber || session.config?.targetNumber || '',
                sourceType: session.config?.sourceType || 'number',
                targetNumber: session.config?.targetNumber || session.config?.sourceNumber || '',
                sourceNumber: session.config?.sourceNumber || session.config?.targetNumber || '',
                sourceGroup: session.config?.sourceGroup || '',
                destinationType: session.config?.destinationType || 'groups',
                targetGroup: session.config?.targetGroup || session.config?.destinations || '',
                destinations: session.config?.destinations || session.config?.targetGroup || '',
                shareTypes: session.config?.shareTypes || ['pdf', 'document', 'image', 'video', 'audio', 'text'],
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
            isDatabase: !!(process.env.DATABASE_URL || process.env.DB_HOST),
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

// Dedicated endpoint: Save ONLY the notification target number without touching templates/triggers
app.patch('/api/config/notification-target', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    const { notificationTargetNumber } = req.body;

    if (!notificationTargetNumber) {
        return res.status(400).json({ success: false, error: 'notificationTargetNumber is required.' });
    }

    try {
        // Load existing config first so we don't overwrite templates/triggers
        const existingConfig = await getUserBotConfig(userId) || {};

        // Merge — only update the notification target field
        const updatedConfig = {
            ...existingConfig,
            notificationTargetNumber: notificationTargetNumber,
            targetNumber: existingConfig.targetNumber || notificationTargetNumber,
        };

        await saveUserBotConfig(userId, updatedConfig);

        const session = await getOrCreateUserSession(userId, req.user.email);
        session.config = updatedConfig;
        session.addLog(`Notification Target updated: +${notificationTargetNumber}`);

        res.json({ success: true, message: 'Notification target saved successfully.' });
    } catch (err) {
        console.error('Error saving notification target for user:', userId, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/config', authenticateUser, async (req, res) => {
    const userId = req.user.id;
    const { 
        templates,
        configMode, sourceType, sourceNumber, targetNumber, sourceGroup,
        destinationType, targetGroup, destinations, shareTypes, customPrefix, keywordFilter,
        morningMessage, scheduleTime,
        bulkContacts, bulkMsgType, bulkMessage, sheetUrl, sheetColPhone, sheetColMsg,
        notificationTargetNumber
    } = req.body;
    
    try {
        // Load existing config first — merge so neither templates nor notification target overwrite each other
        const existingConfig = await getUserBotConfig(userId) || {};

        const resolvedTargetNumber = sourceNumber || targetNumber || existingConfig.targetNumber || '';
        const resolvedTargetGroup = destinations || targetGroup || existingConfig.targetGroup || '';
        // Preserve existing notificationTargetNumber if not provided in this request
        const resolvedNotificationTarget = notificationTargetNumber || existingConfig.notificationTargetNumber || resolvedTargetNumber || '';
        
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
                notificationTargetNumber: resolvedNotificationTarget,
                shareTypes: Array.isArray(shareTypes) ? shareTypes : ['pdf', 'document', 'image', 'video', 'audio', 'text'],
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
            notificationTargetNumber: resolvedNotificationTarget,
            sourceType: sourceType || (resolvedTemplates[0]?.sourceType) || 'number',
            sourceNumber: resolvedTargetNumber || (resolvedTemplates[0]?.sourceNumber) || '',
            targetNumber: resolvedTargetNumber || (resolvedTemplates[0]?.targetNumber) || '',
            sourceGroup: sourceGroup || (resolvedTemplates[0]?.sourceGroup) || '',
            destinationType: destinationType || (resolvedTemplates[0]?.destinationType) || 'groups',
            targetGroup: resolvedTargetGroup || (resolvedTemplates[0]?.targetGroup) || '',
            destinations: resolvedTargetGroup || (resolvedTemplates[0]?.destinations) || '',
            shareTypes: Array.isArray(shareTypes) ? shareTypes : (resolvedTemplates[0]?.shareTypes || ['pdf', 'document', 'image', 'video', 'audio', 'text']),
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

        if (resolvedNotificationTarget) {
            getUserById(userId).then(u => {
                if (u) syncUserToGoogleSheet(u, { targetContact: resolvedNotificationTarget });
            }).catch(() => {});
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

// Get all sheet tab names from a Google Spreadsheet URL
app.post('/api/templates/sheet-names', authenticateUser, async (req, res) => {
    try {
        const { sheetUrl } = req.body;
        if (!sheetUrl) {
            return res.status(400).json({ success: false, error: 'Please enter a Google Sheet URL.' });
        }
        const sheets = await listGoogleSheetNames(sheetUrl);
        res.json({ success: true, sheets });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// Test and Preview Google Sheet rows without sending messages
app.post('/api/templates/test-sheet', authenticateUser, async (req, res) => {
    try {
        const { sheetUrl, sheetColPhone, sheetColMsg, sheetGid } = req.body;
        if (!sheetUrl) {
            return res.status(400).json({ success: false, error: 'Please enter a Google Sheet URL.' });
        }
        const preview = await previewGoogleSheetRows(sheetUrl, sheetColPhone || 'A', sheetColMsg || 'B', sheetGid || null);
        res.json({ success: true, ...preview });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
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
                const qCheck = await checkUserCanSendMessage(userId);
                if (!qCheck.allowed) {
                    session.addLog(`[${templateName}] 🛑 Bulk broadcast halted: ${qCheck.reason}`);
                    break;
                }
                const jid = formatJid(phone);
                await session.sock.sendMessage(jid, { text: bulkMsg });
                sentCount++;
                await recordUserMessageSent(userId);
                if (delaySec > 0 && sentCount < contacts.length) {
                    await new Promise(r => setTimeout(r, delaySec * 1000));
                }
            }
            session.addLog(`[${templateName}] Instant bulk broadcast sent to ${sentCount} contact(s).`);

            // Send notification alert
            const notifyTarget = session.config?.notificationTargetNumber;
            if (notifyTarget && sentCount > 0) {
                try {
                    const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    const auditText = `🔔 *[Cortex AutoBot Alert]*\n✅ *Action:* Bulk Broadcast Sent\n📋 *Template:* ${templateName}\n👥 *Delivered To:* ${sentCount} contact(s)\n⏰ *Time:* ${timeIST} IST`;
                    session.sock.sendMessage(formatJid(notifyTarget), { text: auditText }).catch(() => {});
                } catch (ne) {}
            }

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

            let sentCount = 0;
            for (const dest of targetDestinations) {
                const qCheck = await checkUserCanSendMessage(userId);
                if (!qCheck.allowed) {
                    session.addLog(`[${templateName}] 🛑 Scheduled broadcast halted: ${qCheck.reason}`);
                    break;
                }
                await session.sock.sendMessage(dest, { text: msg });
                sentCount++;
                await recordUserMessageSent(userId);
            }
            session.addLog(`[${templateName}] Instant broadcast sent to ${sentCount} destination(s).`);

            // Send notification alert
            const notifyTargetS = session.config?.notificationTargetNumber;
            if (notifyTargetS && sentCount > 0) {
                try {
                    const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    const auditText = `🔔 *[Cortex AutoBot Alert]*\n✅ *Action:* Scheduled Broadcast Sent\n📋 *Template:* ${templateName}\n👥 *Delivered To:* ${sentCount} destination(s)\n⏰ *Time:* ${timeIST} IST`;
                    session.sock.sendMessage(formatJid(notifyTargetS), { text: auditText }).catch(() => {});
                } catch (ne) {}
            }

            return res.json({ success: true, message: `Instant message delivered to ${sentCount} destination(s)!` });

        } else if (tplType === 'sheets') {
            const sheetUrl = tpl.sheetUrl;
            if (!sheetUrl) {
                return res.status(400).json({ success: false, error: 'No Google Sheet URL configured in this template!' });
            }
            try {
                const result = await dispatchGoogleSheetAutomation(userId, session.sock, tpl, session.addLog.bind(session));

                // Send notification alert
                const notifyTargetG = session.config?.notificationTargetNumber;
                if (notifyTargetG && result.sentCount > 0) {
                    try {
                        const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        const auditText = `🔔 *[Cortex AutoBot Alert]*\n✅ *Action:* Google Sheet Automation Sent\n📋 *Template:* ${templateName}\n👥 *Delivered To:* ${result.sentCount} contact(s)\n⏰ *Time:* ${timeIST} IST`;
                        session.sock.sendMessage(formatJid(notifyTargetG), { text: auditText }).catch(() => {});
                    } catch (ne) {}
                }

                return res.json({ 
                    success: true, 
                    message: `Google Sheet sync complete! Sent ${result.sentCount} message(s) successfully.` 
                });
            } catch (sheetErr) {
                session.addLog(`[${templateName}] ❌ Google Sheet error: ${sheetErr.message}`);
                return res.status(400).json({ success: false, error: sheetErr.message });
            }

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
                    const qCheck = await checkUserCanSendMessage(userId);
                    if (!qCheck.allowed) {
                        session.addLog(`[${templateName}] 🛑 Test message halted: ${qCheck.reason}`);
                        break;
                    }
                    await session.sock.sendMessage(dest, { text: testMsg });
                    await recordUserMessageSent(userId);
                    destinationsSent.push(dest.includes('@g.us') ? 'Target Group' : `+${dest.replace(/[^\d]/g, '')}`);
                }
            }

            // 2. Also send test confirmation to source number if configured
            if (targetNumber) {
                const qCheck = await checkUserCanSendMessage(userId);
                if (qCheck.allowed) {
                    const numJid = formatJid(targetNumber);
                    await session.sock.sendMessage(numJid, { text: `[Test Message] Auto-Sharing rule "${templateName}" is actively listening to this phone number.` });
                    await recordUserMessageSent(userId);
                    destinationsSent.push(`Contact (+${targetNumber.replace(/[^\d]/g, '')})`);
                } else {
                    session.addLog(`[${templateName}] 🛑 Test message halted: ${qCheck.reason}`);
                }
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
            const userPlan = u.plan || (u.role === 'admin' ? 'pro_12m' : 'trial');
            return {
                id: u.id,
                email: u.email,
                name: u.name,
                role: u.role,
                avatar: u.avatar,
                plan: userPlan,
                plan_expires_at: u.plan_expires_at,
                messages_sent_today: u.messages_sent_today || 0,
                messages_sent_total: u.messages_sent_total || 0,
                createdAt: u.created_at,
                lastLogin: u.last_login,
                whatsappStatus: session ? session.connectionStatus : 'disconnected',
                targetNumber: config?.targetNumber || '',
                targetGroup: config?.targetGroup || '',
                destinationType: config?.destinationType || (config?.targetGroup ? 'group' : 'number'),
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
