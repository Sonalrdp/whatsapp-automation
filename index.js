import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import makeWASocket, { DisconnectReason, downloadMediaMessage, downloadContentFromMessage, Browsers, proto, BufferJSON } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import NodeCache from 'node-cache';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Message retry counter cache across reconnections to handle Signal re-keys
const msgRetryCounterCache = new NodeCache({
    stdTTL: 3600, // 1 hour TTL
    checkperiod: 120,
    useClones: false
});

// Persistent Message Store for Baileys retry and decryption handling
const MESSAGE_STORE_FILE = path.join(__dirname, 'auth_info', 'messages_store.json');
const messageStore = new Map();

// Load persisted message keys on startup
try {
    if (fs.existsSync(MESSAGE_STORE_FILE)) {
        const raw = fs.readFileSync(MESSAGE_STORE_FILE, 'utf-8');
        const parsed = JSON.parse(raw, BufferJSON.reviver);
        if (Array.isArray(parsed)) {
            for (const [id, val] of parsed) {
                if (id && val) messageStore.set(id, val);
            }
        }
        console.log(`[MessageStore] Loaded ${messageStore.size} persistent messages from disk.`);
    }
} catch (err) {
    console.warn(`[MessageStore] Could not load persisted message store: ${err.message}`);
}

// Debounced flush to disk (prevents disk lag on high message volume)
let messageStoreFlushTimer = null;
function persistMessageStore() {
    if (messageStoreFlushTimer) return;
    messageStoreFlushTimer = setTimeout(() => {
        messageStoreFlushTimer = null;
        try {
            const dir = path.dirname(MESSAGE_STORE_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const entries = Array.from(messageStore.entries()).slice(-2500); // Retain latest 2500 messages
            fs.writeFileSync(MESSAGE_STORE_FILE, JSON.stringify(entries, BufferJSON.replacer));
        } catch (e) {
            console.error('[MessageStore] Error writing message store to disk:', e.message);
        }
    }, 1500);
}

function storeMessage(id, data) {
    if (!id || !data) return;
    messageStore.set(id, data);
    if (messageStore.size > 3000) {
        const firstKey = messageStore.keys().next().value;
        messageStore.delete(firstKey);
    }
    persistMessageStore();
}

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
    updateUserPassword,
    generateAccessToken,
    getUserByAccessToken,
    regenerateUserAccessToken,
    generateConvertApiSecret,
    getUserByConvertApiSecret,
    regenerateUserConvertApiSecret,
    getMessageTemplates,
    saveMessageTemplate,
    getMessageTemplateByName,
    deleteMessageTemplate
} from './database.js';
import { setupUserScheduledMessage, stopUserScheduledMessage } from './scheduler.js';
import { dispatchGoogleSheetAutomation, previewGoogleSheetRows, listGoogleSheetNames } from './sheets_engine.js';
import { 
    testTallyConnection, 
    findLedgerByPhone, 
    fetchLedgerTransactions, 
    generateLedgerPdf, 
    cleanPhoneNumber,
    formatCurrency,
    formatPhoneDisplay,
    getAllTallyPhoneNumbers
} from './tally_engine.js';
import convertApiRouter from './ConvertAPI/index.js';

// Conversational session tracker for Tally requests: Map<`${userId}:${cleanPhone}`, sessionState>
const tallyUserSessions = new Map();

// Global LID to Phone Number cache for WhatsApp Multi-Device linked identities
const lidToPhoneMap = new Map();
lidToPhoneMap.set('165498176200896', '919135779897');
lidToPhoneMap.set('165498176200896@lid', '919135779897');
lidToPhoneMap.set('232113404141591', '918235066919');
lidToPhoneMap.set('232113404141591@lid', '918235066919');

// Robust phone number comparison: strictly matches the 10 digits after +91
function isSamePhoneNumber(phone1, phone2) {
    if (!phone1 || !phone2) return false;
    const clean1 = cleanPhoneNumber(phone1);
    const clean2 = cleanPhoneNumber(phone2);
    if (!clean1 || !clean2) return false;
    return clean1 === clean2;
}

// Helper: Checks if incoming text matches any trigger keyword strictly (whole word / exact phrase)
function isTallyTriggerMatch(messageText, rawKeywords) {
    if (!messageText) return false;
    const cleanMsg = messageText.toString().trim().toLowerCase();
    if (!cleanMsg) return false;

    const keywords = (rawKeywords || 'ledger, leadger, statement, hisab, khata')
        .split(',')
        .map(k => k.trim().toLowerCase())
        .filter(k => k.length >= 2); // Ignore single characters like 'a' or accidental commas

    if (keywords.length === 0) return false;

    // Remove punctuation, collapse spaces to extract discrete words
    const normalizedMsg = cleanMsg.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const words = normalizedMsg.split(' ').filter(Boolean);

    for (const kw of keywords) {
        // Direct match with full message
        if (cleanMsg === kw || normalizedMsg === kw) return true;

        if (kw.includes(' ')) {
            // Multi-word phrase matching
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i');
            if (regex.test(normalizedMsg)) return true;
        } else {
            // Single-word keyword: must match as a standalone word (NOT a substring inside unrelated words)
            if (words.includes(kw)) return true;
        }
    }
    return false;
}

// Universal Sender Phone Resolver (resolves @s.whatsapp.net, self-chats, and modern WhatsApp @lid)
async function resolveSenderPhone(effectiveJid, msg, sock, currentConfig) {
    if (!effectiveJid) return '';

    // 1. Direct s.whatsapp.net phone JID
    if (effectiveJid.endsWith('@s.whatsapp.net')) {
        return cleanPhoneNumber(effectiveJid.split('@')[0].split(':')[0]);
    }

    // 2. If it is fromMe (self-chat / test message from bot's own WhatsApp)
    if (msg?.key?.fromMe) {
        const botPhone = (sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^\d]/g, '');
        if (botPhone) return cleanPhoneNumber(botPhone);
    }

    const cleanLid = effectiveJid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');

    // 3. Check memory cache
    const cached = lidToPhoneMap.get(cleanLid) || lidToPhoneMap.get(effectiveJid);
    if (cached) return cached;

    // 4. Check if sender LID is the bot's own LID
    const botLid = (sock?.authState?.creds?.me?.lid || '').split('@')[0].split(':')[0].replace(/[^\d]/g, '');
    if (botLid && (cleanLid === botLid || effectiveJid === botLid)) {
        const botPhone = (sock?.user?.id || '').split('@')[0].split(':')[0].replace(/[^\d]/g, '');
        if (botPhone) {
            lidToPhoneMap.set(cleanLid, botPhone);
            return botPhone;
        }
    }

    // 5. Build candidate phone list to query on WhatsApp
    const candidates = new Set();
    if (currentConfig?.templates && Array.isArray(currentConfig.templates)) {
        for (const t of currentConfig.templates) {
            if (t.targetNumber) candidates.add(t.targetNumber.replace(/[^\d]/g, ''));
            if (t.sourceNumber) candidates.add(t.sourceNumber.replace(/[^\d]/g, ''));
            if (t.notificationTargetNumber) candidates.add(t.notificationTargetNumber.replace(/[^\d]/g, ''));
        }
    }
    candidates.add('919135779897');
    candidates.add('918235066919');

    // Also include debtor phones currently in Tally
    try {
        const tallyTpls = (currentConfig?.templates || []).filter(t => t.active !== false && t.type === 'tally');
        for (const tt of tallyTpls) {
            const tallyPhones = await getAllTallyPhoneNumbers({ tallyUrl: tt.tallyUrl, companyName: tt.tallyCompany });
            for (const tp of tallyPhones) candidates.add(tp);
        }
    } catch (e) {}

    // Check each candidate on WhatsApp to see whose LID matches cleanLid
    if (sock) {
        for (const num of candidates) {
            if (!num || num.length < 10) continue;
            const fullNum = num.length === 10 ? '91' + num : num;
            try {
                const [waRes] = await sock.onWhatsApp(`${fullNum}@s.whatsapp.net`);
                if (waRes && waRes.lid) {
                    const waLidClean = waRes.lid.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                    lidToPhoneMap.set(waLidClean, fullNum);
                    lidToPhoneMap.set(`${waLidClean}@lid`, fullNum);
                    lidToPhoneMap.set(waRes.lid, fullNum);
                    if (waLidClean === cleanLid) {
                        return fullNum;
                    }
                }
            } catch (e) {}
        }
    }

    return '';
}


// Express setup
const app = express();
const PORT = process.env.PORT || 3005;

// Helper to compute API Endpoint URL based on fixed cortex-ai.in domain
export function getApiEndpointForUser(req, userId) {
    return `https://live-mt-server.cortex-ai.in/${userId}`;
}

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public')); // Serve the web dashboard
app.use('/Google Script', express.static(path.join(__dirname, 'Google Script')));
app.use('/Google Script', express.static(path.join(__dirname, '..', 'Google Script')));

// Filter out noisy internal libsignal & Baileys crypto retry logs to keep CMD completely clean
const originalConsoleError = console.error;
console.error = function (...args) {
    const msg = String(args[0] || '');
    if (msg.includes('Session error') || 
        msg.includes('Failed to decrypt message') ||
        msg.includes('No matching sessions found') ||
        msg.includes('Key used already') ||
        msg.includes('MessageCounterError') ||
        msg.includes('Bad MAC')) {
        return;
    }
    originalConsoleError.apply(console, args);
};

const originalConsoleInfo = console.info;
console.info = function (...args) {
    const msg = String(args[0] || '');
    if (msg.includes('Closing session') || 
        msg.includes('Removing old closed session') ||
        msg.includes('Closing open session') ||
        msg.includes('Decrypted message with closed session')) {
        return;
    }
    originalConsoleInfo.apply(console, args);
};

// Logger (silent prevents internal Baileys/libsignal JSON traces from printing in CMD)
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
        if (message.deviceSentMessage?.message) message = message.deviceSentMessage.message;
        else if (message.ephemeralMessage?.message) message = message.ephemeralMessage.message;
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
    if (message.interactiveResponseMessage?.body?.text) {
        return {
            type: 'text',
            text: message.interactiveResponseMessage.body.text
        };
    }
    if (message.buttonsResponseMessage?.selectedDisplayText || message.buttonsResponseMessage?.selectedButtonId) {
        return {
            type: 'text',
            text: message.buttonsResponseMessage.selectedDisplayText || message.buttonsResponseMessage.selectedButtonId || ''
        };
    }
    if (message.templateButtonReplyMessage?.selectedDisplayText || message.templateButtonReplyMessage?.selectedId) {
        return {
            type: 'text',
            text: message.templateButtonReplyMessage.selectedDisplayText || message.templateButtonReplyMessage.selectedId || ''
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
            browser: Browsers.windows('Chrome'),
            syncFullHistory: false,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 250,
            msgRetryCounterCache,
            getMessage: async (key) => {
                if (!key?.id) return undefined;
                const cached = messageStore.get(key.id);
                if (cached) {
                    if (!key.remoteJid && cached.remoteJid) {
                        key.remoteJid = cached.remoteJid;
                    }
                    const rawMsg = cached.message || cached;
                    try {
                        return proto.Message.fromObject(rawMsg);
                    } catch (e) {
                        return rawMsg;
                    }
                }
                // Fallback: If not found in cache, return an empty conversation placeholder
                // This satisfies WhatsApp's retry receipt and forces immediate decryption on the recipient's phone
                return proto.Message.fromObject({
                    conversation: '✅ Ledger Statement'
                });
            }
        });

        // Automatically store all sent messages into messageStore so retry decryptions succeed instantly
        const rawSendMessage = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options) => {
            const result = await rawSendMessage(jid, content, options);
            if (result?.key?.id && result?.message) {
                storeMessage(result.key.id, {
                    message: result.message,
                    remoteJid: result.key.remoteJid || jid
                });
            }
            return result;
        };

        session.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    session.qrCodeDataUrl = await QRCode.toDataURL(qr);
                    session.connectionStatus = 'qr_ready';
                    session.isConnecting = false;
                    session.addLog("New WhatsApp QR Code generated. View and scan in the Web Dashboard.");
                    console.log(`[User ${session.userEmail || userId}] New WhatsApp QR Code generated. Ready on Web Dashboard.`);
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
                    session.addLog("WhatsApp connection interrupted. Retrying with preserved credentials...");
                    // Permanent linking: Do NOT delete credentials - preserve auth state and auto-reconnect
                    setTimeout(() => connectUserWhatsApp(userId), 3000);
                } else {
                    const isQrTimeout = String(disconnectMessage).includes('QR refs attempts ended');
                    if (isQrTimeout) {
                        session.addLog(`QR code timed out. Click Connect to generate a new QR code.`);
                    } else {
                        session.addLog(`Disconnected: ${disconnectMessage}. Auto-reconnecting in 3 seconds...`);
                        setTimeout(() => connectUserWhatsApp(userId), 3000);
                    }
                }
            } else if (connection === 'open') {
                session.isConnecting = false;
                session.connectionStatus = 'connected';
                session.qrCodeDataUrl = null;
                session.addLog("WhatsApp session connected successfully (24/7 Liveness Active across all templates)!");

                // 24/7 Keep-Alive Presence Heartbeat (every 30s) - keeps WhatsApp account linked permanently
                if (session.heartbeatInterval) clearInterval(session.heartbeatInterval);
                session.heartbeatInterval = setInterval(async () => {
                    try {
                        if (session.sock && session.connectionStatus === 'connected') {
                            await session.sock.sendPresenceUpdate('available');
                        }
                    } catch (e) {
                        // Presence ping fail - socket will auto-reconnect
                    }
                }, 30000);

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

                // Seed bot's own LID and phone into lidToPhoneMap
                if (sock.user?.id) {
                    const myPhone = sock.user.id.split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                    const myLid = (sock.authState?.creds?.me?.lid || '').split('@')[0].split(':')[0].replace(/[^\d]/g, '');
                    if (myPhone) {
                        lidToPhoneMap.set(myPhone, myPhone);
                        if (myLid) {
                            lidToPhoneMap.set(myLid, myPhone);
                            lidToPhoneMap.set(`${myLid}@lid`, myPhone);
                        }
                    }
                }
            }
        });

        // Process all WhatsApp events using Baileys official process pipeline
        sock.ev.process(async (events) => {
            // 1. Contact sync events: dynamically learn contact LIDs and phone numbers
            if (events['contacts.upsert']) {
                for (const c of events['contacts.upsert']) {
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
            }

            if (events['contacts.update']) {
                for (const c of events['contacts.update']) {
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
            }

            // 2. Incoming messages event
            if (events['messages.upsert']) {
                const m = events['messages.upsert'];
                try {
                    if (!m.messages || m.messages.length === 0) return;

                    for (const msg of m.messages) {
                        try {
                            if (msg.key?.id && msg.message) {
                                storeMessage(msg.key.id, {
                                    message: msg.message,
                                    remoteJid: msg.key.remoteJid
                                });
                            }

                            const senderJid = msg.key?.remoteJid || '';
                            if (senderJid === 'status@broadcast') continue;

                            console.log(`[RAW WA EVENT] ID: ${msg.key?.id}, sender: ${senderJid}, fromMe: ${msg.key?.fromMe}, hasMsg: ${Boolean(msg.message)}`);

                            if (!msg.message) continue;

                            const content = extractMessageContent(msg.message);
                            if (!content) continue;

                            const textMsg = (content.text || content.caption || '').trim();
                            const lowerText = textMsg.toLowerCase();

                            // Check if fromMe: allow self-chat / self-testing if message contains Tally keyword or option
                            if (msg.key.fromMe) {
                                const isTallyCommand = /^(ledger|leadger|statement|hisab|khata|1|2|3|4|1\s*m|3\s*m|6\s*m|12\s*m|1\s*month|3\s*months|6\s*months|12\s*months)/i.test(lowerText);
                                if (!isTallyCommand) {
                                    continue;
                                }
                            }

                            const isGroupMsg = senderJid.endsWith('@g.us');
                            const participantJid = msg.key.participant || msg.participant || '';

                            const currentConfig = await getUserBotConfig(userId);
                            session.config = currentConfig;

                            console.log(`[User ${userId}] 📩 Incoming message from ${senderJid}${isGroupMsg ? ` (participant: ${participantJid})` : ''} (${msg.pushName || 'Customer'}): "${textMsg || content.type}" (fromMe: ${msg.key.fromMe})`);
                            session.addLog(`[Incoming] From ${isGroupMsg ? (participantJid || senderJid) : senderJid}: "${textMsg || content.type}"`);

                            // ==============================================================
                            // TALLY INTEGRATION: Automated Ledger Statement Delivery
                            // ==============================================================
                            const activeTallyTemplates = (currentConfig.templates && Array.isArray(currentConfig.templates))
                                ? currentConfig.templates.filter(t => t.active !== false && t.type === 'tally')
                                : [];

                            if (activeTallyTemplates.length > 0) {
                                const effectiveJid = isGroupMsg ? participantJid : senderJid;
                                let senderPhone = await resolveSenderPhone(effectiveJid, msg, sock, currentConfig);
                                const cleanSenderPhone = cleanPhoneNumber(senderPhone);
                                const sessionKey = `${userId}:${cleanSenderPhone || effectiveJid}`;
                                const activeTallySession = tallyUserSessions.get(sessionKey);

                                // Robust helper to send reply directly to the customer's active conversation channel
                                const sendCustomerReply = async (payload) => {
                                    // 1. In group chats, reply directly to the group
                                    if (isGroupMsg) {
                                        return await sock.sendMessage(senderJid, payload, { quoted: msg });
                                    }

                                    // 2. In 1-on-1 direct chats:
                                    // ALWAYS route to the canonical phone JID (@s.whatsapp.net).
                                    // Sending directly to @lid causes Signal ratchet mismatches that show "Waiting for this message".
                                    let targetJid = senderJid;
                                    if (targetJid.endsWith('@lid') || !targetJid.endsWith('@s.whatsapp.net')) {
                                        if (cleanSenderPhone) {
                                            targetJid = `${cleanSenderPhone.length === 10 ? '91' + cleanSenderPhone : cleanSenderPhone}@s.whatsapp.net`;
                                        }
                                    }

                                    // 3. Do not quote if incoming message was fromMe (self-chat) or from an @lid
                                    // Quoting @lid in 1-on-1 chats breaks Signal signature verification on the client phone
                                    const shouldQuote = !msg.key?.fromMe && !msg.key?.remoteJid?.endsWith('@lid');
                                    const options = shouldQuote ? { quoted: msg } : {};

                                    try {
                                        return await sock.sendMessage(targetJid, payload, options);
                                    } catch (eSend) {
                                        console.warn(`[sendCustomerReply] Send to ${targetJid} failed (${eSend.message}), trying raw...`);
                                        try {
                                            return await sock.sendMessage(targetJid, payload);
                                        } catch (e2) {
                                            // Fallback: If canonical phone failed, try original remoteJid
                                            if (msg.key?.remoteJid && msg.key.remoteJid !== targetJid) {
                                                return await sock.sendMessage(msg.key.remoteJid, payload);
                                            }
                                            throw e2;
                                        }
                                    }
                                };

                                // 1. Check if customer is responding to duration prompt
                                if (activeTallySession && activeTallySession.step === 'AWAITING_DURATION') {
                                    // Session expiration check (10 minutes)
                                    const SESSION_EXPIRY_MS = 10 * 60 * 1000;
                                    if (activeTallySession.timestamp && (Date.now() - activeTallySession.timestamp > SESSION_EXPIRY_MS)) {
                                        tallyUserSessions.delete(sessionKey);
                                        // Expired: do not treat as duration reply; fall through to trigger check
                                    } else {
                                        const tpl = activeTallyTemplates.find(t => t.id === activeTallySession.tplId) || activeTallyTemplates[0];

                                        // Cancellation support
                                        if (/^(cancel|exit|stop|close|quit|nahi|no)$/i.test(lowerText.trim())) {
                                            tallyUserSessions.delete(sessionKey);
                                            await sendCustomerReply({ text: '❌ *Ledger request cancelled.* You can request your statement again anytime by typing *ledger*.' });
                                            continue;
                                        }

                                        // If customer types "ledger" or keyword again, re-prompt menu (strictly max 2 times only)
                                        const isKeywordAgain = isTallyTriggerMatch(lowerText, tpl.triggerKeywords);
                                        if (isKeywordAgain) {
                                            activeTallySession.resentCount = (activeTallySession.resentCount || 0) + 1;
                                            if (activeTallySession.resentCount > 2) {
                                                session.addLog(`[Tally Ledger Bot] ⚠️ Duration choices menu already re-sent 2 times to ${formatPhoneDisplay(cleanSenderPhone || senderJid)}. Maximum attempts reached.`);
                                                tallyUserSessions.delete(sessionKey);
                                                await sendCustomerReply({
                                                    text: `⚠️ *Request expired.* Duration choices were re-sent 2 times without selection.\n\nPlease type *ledger* again when you are ready to select a statement duration.`
                                                });
                                                continue;
                                            }
                                            activeTallySession.timestamp = Date.now();
                                            const promptMenu = `*Hello ${activeTallySession.ledgerName}* 👋\n\nPlease select the statement duration for your Ledger Account (Reminder ${activeTallySession.resentCount}/2):\n\n1️⃣ *1 Month* (Last 30 Days)\n2️⃣ *3 Months* (Last 90 Days)\n3️⃣ *6 Months* (Last 180 Days)\n4️⃣ *12 Months* (Last 1 Year)\n\n👉 Reply with *1, 2, 3, or 4* (or type the duration name).`;
                                            await sendCustomerReply({ text: promptMenu });
                                            session.addLog(`[Tally Ledger Bot] 📤 Re-sent duration choices menu (${activeTallySession.resentCount}/2) to ${formatPhoneDisplay(cleanSenderPhone || senderJid)}`);
                                            continue;
                                        }

                                        let selectedMonths = null;
                                        let periodLabel = '';

                                        if (/^(1|1\s*m|1\s*month|one|one\s*month)$/i.test(lowerText) || lowerText.includes('1 month') || lowerText === '1') {
                                            selectedMonths = 1;
                                            periodLabel = 'Last 1 Month';
                                        } else if (/^(2|3\s*m|3\s*month|3\s*months|three|three\s*months)$/i.test(lowerText) || lowerText.includes('3 month') || lowerText === '2') {
                                            selectedMonths = 3;
                                            periodLabel = 'Last 3 Months';
                                        } else if (/^(3|6\s*m|6\s*month|6\s*months|six|six\s*months)$/i.test(lowerText) || lowerText.includes('6 month') || lowerText === '3') {
                                            selectedMonths = 6;
                                            periodLabel = 'Last 6 Months';
                                        } else if (/^(4|12\s*m|12\s*month|12\s*months|1\s*year|year|twelve)$/i.test(lowerText) || lowerText.includes('12 month') || lowerText === '4' || lowerText.includes('1 year')) {
                                            selectedMonths = 12;
                                            periodLabel = 'Last 12 Months';
                                        }

                                        if (!selectedMonths) {
                                            activeTallySession.invalidCount = (activeTallySession.invalidCount || 0) + 1;
                                            if (activeTallySession.invalidCount >= 2) {
                                                // Drop session after 2 invalid attempts so user is not stuck
                                                tallyUserSessions.delete(sessionKey);
                                                session.addLog(`[Tally Ledger Bot] ⚠️ Customer (${formatPhoneDisplay(cleanSenderPhone)}) reached maximum invalid duration attempts (2/2). Session ended.`);
                                                await sendCustomerReply({
                                                    text: `⚠️ *Request expired.* Invalid option entered 2 times.\n\nPlease type *ledger* again when you are ready to select a statement duration.`
                                                });
                                                continue;
                                            }
                                            session.addLog(`[Tally Ledger Bot] ⚠️ Customer (${formatPhoneDisplay(cleanSenderPhone)}) replied "${textMsg}" which is not a valid duration option (${activeTallySession.invalidCount}/2).`);
                                            await sendCustomerReply({
                                                text: `⚠️ *Please choose a valid duration (Attempt ${activeTallySession.invalidCount}/2):*\n\nReply with *1*, *2*, *3*, or *4*:\n1️⃣ *1 Month*\n2️⃣ *3 Months*\n3️⃣ *6 Months*\n4️⃣ *12 Months*`
                                            });
                                            continue;
                                        }

                                        // Update state to prevent duplicate triggers
                                        activeTallySession.step = 'PROCESSING';

                                        // Send INSTANT Waiting Message immediately (< 1 sec)
                                        const waitNotice = tpl.waitMessage || '⏳ *Please wait up to 10 minutes.* Your ledger request is being generated from our accounting system. Once ready, it will be delivered here.';
                                        await sendCustomerReply({ text: waitNotice });
                                        session.addLog(`[Tally Ledger Bot] ⚡ Customer (${formatPhoneDisplay(cleanSenderPhone)}) selected ${periodLabel}. Instant wait message sent!`);

                                        // Async Background Job: Fetch from Tally, Generate PDF, and Send
                                        (async () => {
                                            try {
                                                session.addLog(`[Tally Ledger Bot] 🔄 Connecting to Tally (${tpl.tallyUrl || 'http://localhost:9000'}) for "${activeTallySession.ledgerName}" (${periodLabel})...`);

                                                const data = await fetchLedgerTransactions({
                                                    tallyUrl: tpl.tallyUrl,
                                                    companyName: tpl.tallyCompany,
                                                    ledgerName: activeTallySession.ledgerName,
                                                    months: selectedMonths
                                                });

                                                session.addLog(`[Tally Ledger Bot] 📄 Generating official statement PDF for ${activeTallySession.ledgerName} (${data.vouchers.length} vouchers)...`);

                                                const activeCo = tpl.companyName || (tpl.tallyCompany && tpl.tallyCompany !== 'xyz' ? tpl.tallyCompany : null) || data.companyName || 'Accounts Department';
                                                const pdfBuffer = await generateLedgerPdf({
                                                    companyName: activeCo,
                                                    ledgerName: activeTallySession.ledgerName,
                                                    phoneNumber: cleanSenderPhone,
                                                    periodLabel,
                                                    fromDateStr: data.fromDateStr,
                                                    toDateStr: data.toDateStr,
                                                    openingBalance: data.openingBalance,
                                                    totalDebit: data.totalDebit,
                                                    totalCredit: data.totalCredit,
                                                    closingBalance: data.closingBalance,
                                                    vouchers: data.vouchers
                                                });

                                                const safePartyFilename = activeTallySession.ledgerName.replace(/[^a-zA-Z0-9_-]/g, '_');
                                                const outFileName = `Ledger_${safePartyFilename}_${periodLabel.replace(/\s+/g, '_')}.pdf`;
                                                const balSign = data.closingBalance >= 0 ? 'Dr (Receivable)' : 'Cr (Payable)';
                                                const captionText = `*${activeCo}*\n\n📄 *Statement of Ledger Account*\n👤 *Party:* ${activeTallySession.ledgerName}\n📅 *Period:* ${data.fromDateStr} to ${data.toDateStr}\n💰 *Closing Balance:* Rs. ${formatCurrency(data.closingBalance)} ${balSign}\n\n_Thank you for your business!_`;

                                                await sendCustomerReply({
                                                    document: pdfBuffer,
                                                    mimetype: 'application/pdf',
                                                    fileName: outFileName,
                                                    caption: captionText
                                                });

                                                session.addLog(`[Tally Ledger Bot] ✅ Successfully delivered Ledger PDF (${outFileName}) to ${formatPhoneDisplay(cleanSenderPhone)}!`);
                                                recordUserMessageSent(userId).catch(() => {});
                                            } catch (bgErr) {
                                                session.addLog(`[Tally Ledger Bot] ❌ Error generating statement: ${bgErr.message}`);
                                                await sendCustomerReply({
                                                    text: `⚠️ Our accounting server encountered a delay while generating your statement. Our team has been notified.`
                                                }).catch(() => {});
                                            } finally {
                                                tallyUserSessions.delete(sessionKey);
                                            }
                                        })();

                                        continue;
                                    }
                                }

                                // 2. Check if message is a new keyword trigger for Tally (e.g. "ledger", "leadger", "statement", "hisab", "khata")
                                let tallyTriggerMatched = false;
                                for (const tpl of activeTallyTemplates) {
                                    const isTrigger = isTallyTriggerMatch(textMsg, tpl.triggerKeywords);
                                    if (!isTrigger) continue;

                                    tallyTriggerMatched = true;
                                    session.addLog(`[Tally Ledger Bot] 🔍 Received keyword trigger "${textMsg}" from ${formatPhoneDisplay(cleanSenderPhone || senderJid)}. Verifying registered mobile in Tally...`);

                                    // Verify registered number in Tally (strictly matches 10 digits ignoring country codes)
                                    const checkResult = await findLedgerByPhone({
                                        tallyUrl: tpl.tallyUrl,
                                        companyName: tpl.tallyCompany,
                                        phoneNumber: cleanSenderPhone
                                    });

                                    if (checkResult.tallyUnavailable) {
                                        session.addLog(`[Tally Ledger Bot] ⏳ Tally accounting server is synchronizing/offline. Notifying customer...`);
                                        await sendCustomerReply({
                                            text: `⏳ *Our accounting system is currently synchronizing. Please try later.*`
                                        });
                                        break;
                                    }

                                    if (!checkResult.found) {
                                        session.addLog(`[Tally Ledger Bot] ⚠️ Mobile ${formatPhoneDisplay(cleanSenderPhone || senderJid)} is NOT registered in Tally. Sending notice...`);
                                        const unregMsg = tpl.unregisteredMessage || `❌ *Notice:* Your mobile number (${formatPhoneDisplay(cleanSenderPhone || 'your number')}) is not registered with our accounting records.\n\nPlease contact our accounts department to link your mobile number.`;
                                        await sendCustomerReply({ text: unregMsg });
                                        session.addLog(`[Tally Ledger Bot] 📤 Unregistered notice delivered to ${formatPhoneDisplay(cleanSenderPhone || senderJid)}`);
                                        break;
                                    }

                                    // Verified! Save state and prompt for duration
                                    const partyName = checkResult.ledgerName;
                                    tallyUserSessions.set(sessionKey, {
                                        step: 'AWAITING_DURATION',
                                        ledgerName: partyName,
                                        tplId: tpl.id,
                                        timestamp: Date.now(),
                                        resentCount: 0,
                                        invalidCount: 0
                                    });

                                    session.addLog(`[Tally Ledger Bot] ✅ Verified party "${partyName}". Sending duration choices...`);

                                    const promptMenu = `*Hello ${partyName}* 👋\n\nPlease select the statement duration for your Ledger Account:\n\n1️⃣ *1 Month* (Last 30 Days)\n2️⃣ *3 Months* (Last 90 Days)\n3️⃣ *6 Months* (Last 180 Days)\n4️⃣ *12 Months* (Last 1 Year)\n\n👉 Reply with *1, 2, 3, or 4* (or type the duration name).`;
                                    await sendCustomerReply({ text: promptMenu });
                                    session.addLog(`[Tally Ledger Bot] 📤 Duration choices menu delivered to ${formatPhoneDisplay(cleanSenderPhone)}`);
                                    break;
                                }

                                if (tallyTriggerMatched) {
                                    continue;
                                }
                        }

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

// Middleware for external API calls using the 50-character Access Token
async function authenticateApiAccessToken(req, res, next) {
    let token = null;
    const authHeader = req.headers.authorization;
    const customHeader = req.headers['access-token'] || req.headers['x-api-key'];

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
    } else if (authHeader && !authHeader.includes(' ') && authHeader.length === 50) {
        token = authHeader.trim();
    } else if (customHeader) {
        token = customHeader.trim();
    } else if (req.query && (req.query.token || req.query.access_token || req.query.apiKey)) {
        token = (req.query.token || req.query.access_token || req.query.apiKey).trim();
    }

    if (!token) {
        return res.status(401).json({
            result: false,
            message: 'Access Token is required in Authorization header (Bearer <50-character token>), access-token header, or token query parameter.',
            error: 'Unauthorized'
        });
    }

    const user = await getUserByAccessToken(token);
    if (!user) {
        return res.status(401).json({
            result: false,
            message: 'Invalid or unrecognized 50-character Access Token.',
            error: 'Invalid Token'
        });
    }

    const requestedUserId = req.params.userId || req.body?.userId || req.query?.userId;
    if (requestedUserId && requestedUserId.toString() !== user.id.toString()) {
        return res.status(403).json({
            result: false,
            message: `Forbidden: Provided Access Token is not authorized for user UID ${requestedUserId}.`,
            error: 'Forbidden'
        });
    }

    req.user = user;
    req.apiUser = user;
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

        const apiEndpoint = getApiEndpointForUser(req, user.id);

        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                avatar: user.avatar,
                access_token: user.access_token,
                convert_api_secret: user.convert_api_secret,
                apiEndpoint: apiEndpoint
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Regenerate User 50-Character Access Token
app.post('/api/user/regenerate-token', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const newAccessToken = await regenerateUserAccessToken(userId);
        const apiEndpoint = getApiEndpointForUser(req, userId);
        
        res.json({
            success: true,
            accessToken: newAccessToken,
            apiEndpoint: apiEndpoint,
            message: 'New 50-character Access Token generated successfully!'
        });
    } catch (err) {
        console.error("Error regenerating access token:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Regenerate User 30-Character ConvertAPI Secret
app.post('/api/user/regenerate-convert-secret', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const newSecret = await regenerateUserConvertApiSecret(userId);
        
        res.json({
            success: true,
            convertApiSecret: newSecret,
            message: 'New 30-character ConvertAPI Secret generated successfully!'
        });
    } catch (err) {
        console.error("Error regenerating ConvertAPI secret:", err);
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

// Serve live linked Code.gs file content
app.get('/api/code-gs', (req, res) => {
    try {
        const candidatePaths = [
            path.join(__dirname, 'Google Script', 'Code.gs'),
            path.join(__dirname, '..', 'Google Script', 'Code.gs'),
            path.join(process.cwd(), 'Google Script', 'Code.gs'),
            path.join(process.cwd(), 'github', 'Google Script', 'Code.gs')
        ];
        for (const codeGsPath of candidatePaths) {
            if (fs.existsSync(codeGsPath)) {
                const content = fs.readFileSync(codeGsPath, 'utf8');
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                return res.send(content);
            }
        }
        res.status(404).send('// Code.gs file not found');
    } catch (err) {
        res.status(500).send('// Error reading Code.gs file: ' + err.message);
    }
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
        const fullUser = await getUserById(userId) || req.user;
        const apiEndpoint = getApiEndpointForUser(req, userId);

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
            user: {
                ...req.user,
                access_token: fullUser.access_token,
                apiEndpoint: apiEndpoint
            },
            apiEndpoint: apiEndpoint,
            accessToken: fullUser.access_token,
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

// Test Tally Server Connection & Company Status
app.post('/api/tally/test-connection', authenticateUser, async (req, res) => {
    try {
        const { tallyUrl, companyName } = req.body;
        const result = await testTallyConnection({ tallyUrl, companyName });
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Test Customer Interactive Flow (Simulates or Triggers full Tally bot cycle)
app.post('/api/tally/test-customer-flow', authenticateUser, async (req, res) => {
    try {
        const userId = req.user.id;
        const session = userSessions.get(userId);
        if (!session || session.connectionStatus !== 'connected' || !session.sock) {
            return res.status(400).json({ success: false, error: 'WhatsApp is not connected! Please scan the QR code first.' });
        }

        const { phoneNumber, action = 'trigger', duration = 1 } = req.body;
        const cleanPhone = cleanPhoneNumber(phoneNumber || '919135779897');
        const config = session.config || await getUserBotConfig(userId);
        const activeTallyTemplates = (config.templates || []).filter(t => t.active !== false && t.type === 'tally');

        if (activeTallyTemplates.length === 0) {
            return res.status(400).json({ success: false, error: 'No active Tally Ledger template found. Please create or enable one first.' });
        }

        const tpl = activeTallyTemplates[0];
        const fullPhone = cleanPhone.length === 10 ? ('91' + cleanPhone) : cleanPhone;
        const phoneJid = `${fullPhone}@s.whatsapp.net`;

        if (action === 'trigger') {
            session.addLog(`[Tally Test Flow] 🔍 Testing lookup for +${fullPhone} in Tally...`);
            const check = await findLedgerByPhone({
                tallyUrl: tpl.tallyUrl,
                companyName: tpl.tallyCompany,
                phoneNumber: cleanPhone
            });

            if (check.tallyUnavailable) {
                const syncMsg = `⏳ *Our accounting system is currently synchronizing. Please try later.*`;
                await session.sock.sendMessage(phoneJid, { text: syncMsg });
                session.addLog(`[Tally Test Flow] ⏳ Tally is unreachable/synchronizing. Synchronizing notice sent to +${fullPhone}.`);
                return res.json({
                    success: true,
                    found: false,
                    tallyUnavailable: true,
                    message: `Tally is currently offline or synchronizing. Notice delivered to WhatsApp (+${fullPhone})!`,
                    noticeSent: true
                });
            }

            if (!check.found) {
                const unregMsg = tpl.unregisteredMessage || `❌ Notice: Your mobile number (+${cleanPhone}) is not registered with our accounting records.`;
                await session.sock.sendMessage(phoneJid, { text: unregMsg });
                session.addLog(`[Tally Test Flow] ⚠️ +${fullPhone} is not in Tally. Unregistered notice sent to WhatsApp.`);
                return res.json({
                    success: true,
                    found: false,
                    message: `Mobile +${fullPhone} is not linked to any Tally ledger. Unregistered notice was delivered to WhatsApp!`,
                    noticeSent: true
                });
            }

            const partyName = check.ledgerName;
            const sessionKey = `${userId}:${cleanPhone}`;
            tallyUserSessions.set(sessionKey, {
                step: 'AWAITING_DURATION',
                ledgerName: partyName,
                tplId: tpl.id,
                timestamp: Date.now()
            });

            const promptMenu = `*Hello ${partyName}* 👋\n\nPlease select the statement duration for your Ledger Account:\n\n1️⃣ *1 Month* (Last 30 Days)\n2️⃣ *3 Months* (Last 90 Days)\n3️⃣ *6 Months* (Last 180 Days)\n4️⃣ *12 Months* (Last 1 Year)\n\n👉 Reply with *1, 2, 3, or 4* (or type the duration name).`;
            await session.sock.sendMessage(phoneJid, { text: promptMenu });
            session.addLog(`[Tally Test Flow] ✅ Verified party "${partyName}". Duration menu sent to +${fullPhone}!`);

            return res.json({
                success: true,
                found: true,
                ledgerName: partyName,
                step: 'AWAITING_DURATION',
                message: `Successfully verified party "${partyName}". Duration Selection Menu was sent to WhatsApp (+${fullPhone})! You can now reply 1, 2, 3, or 4 on WhatsApp.`
            });
        } else {
            // Action is send statement PDF directly
            const months = parseInt(duration) || 1;
            const labelMap = { 1: 'Last 1 Month', 3: 'Last 3 Months', 6: 'Last 6 Months', 12: 'Last 12 Months' };
            const periodLabel = labelMap[months] || `Last ${months} Months`;

            session.addLog(`[Tally Test Flow] 📄 Generating statement PDF for +${fullPhone} (${periodLabel})...`);
            const check = await findLedgerByPhone({
                tallyUrl: tpl.tallyUrl,
                companyName: tpl.tallyCompany,
                phoneNumber: cleanPhone
            });
            const ledgerName = check.found ? check.ledgerName : 'Abc';

            const data = await fetchLedgerTransactions({
                tallyUrl: tpl.tallyUrl,
                companyName: tpl.tallyCompany,
                ledgerName,
                months
            });

            const activeCo = tpl.companyName || (tpl.tallyCompany && tpl.tallyCompany !== 'xyz' ? tpl.tallyCompany : null) || data.companyName || 'Accounts Department';
            const pdfBuffer = await generateLedgerPdf({
                companyName: activeCo,
                ledgerName,
                phoneNumber: cleanPhone,
                periodLabel,
                fromDateStr: data.fromDateStr,
                toDateStr: data.toDateStr,
                openingBalance: data.openingBalance,
                totalDebit: data.totalDebit,
                totalCredit: data.totalCredit,
                closingBalance: data.closingBalance,
                vouchers: data.vouchers
            });

            const safePartyFilename = ledgerName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const outFileName = `Ledger_${safePartyFilename}_${periodLabel.replace(/\s+/g, '_')}.pdf`;
            const balSign = data.closingBalance >= 0 ? 'Dr (Receivable)' : 'Cr (Payable)';
            const captionText = `*${tpl.companyName || tpl.tallyCompany || 'Accounts Department'}*\n\n📄 *Statement of Ledger Account*\n👤 *Party:* ${ledgerName}\n📅 *Period:* ${data.fromDateStr} to ${data.toDateStr}\n💰 *Closing Balance:* Rs. ${formatCurrency(data.closingBalance)} ${balSign}\n\n_Thank you for your business!_`;

            await session.sock.sendMessage(phoneJid, {
                document: pdfBuffer,
                mimetype: 'application/pdf',
                fileName: outFileName,
                caption: captionText
            });

            session.addLog(`[Tally Test Flow] ✅ Statement PDF delivered to +${fullPhone}!`);
            await recordUserMessageSent(userId);

            return res.json({
                success: true,
                ledgerName,
                vouchersCount: data.vouchers.length,
                closingBalance: data.closingBalance,
                message: `Successfully generated and delivered Ledger PDF to WhatsApp (+${fullPhone})!`
            });
        }
    } catch (err) {
        console.error('Tally test customer flow error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Download or View Tally Preparation & Setup Guide PDF
app.get('/api/docs/tally-guide', (req, res) => {
    const guidePath = path.join(__dirname, 'public', 'docs', 'What_You_Have_to_Do_Prepare_for_Tally.pdf');
    if (fs.existsSync(guidePath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="What_You_Have_to_Do_Prepare_for_Tally.pdf"');
        fs.createReadStream(guidePath).pipe(res);
    } else {
        res.status(404).json({ success: false, error: 'Tally guide PDF not found.' });
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

        } else if (tplType === 'tally') {
            session.addLog(`[${templateName}] 🔄 Testing Tally connection at ${tpl.tallyUrl || 'http://localhost:9000'}...`);
            const connTest = await testTallyConnection({
                tallyUrl: tpl.tallyUrl,
                companyName: tpl.tallyCompany
            });

            if (!connTest.success) {
                session.addLog(`[${templateName}] ⚠️ Tally connection failed: ${connTest.error}`);
                return res.status(400).json({ success: false, error: connTest.error });
            }

            session.addLog(`[${templateName}] ✅ Tally is online! Verified company "${tpl.tallyCompany || 'Default'}"`);

            // If a notification target is set, send a test statement PDF
            const notifyTarget = session.config?.notificationTargetNumber || tpl.notificationTargetNumber;
            if (notifyTarget) {
                try {
                    const testParty = 'Sample Test Customer';
                    const sampleData = await fetchLedgerTransactions({
                        tallyUrl: tpl.tallyUrl,
                        companyName: tpl.tallyCompany,
                        ledgerName: testParty,
                        months: 3
                    });

                    const activeCo = tpl.companyName || (tpl.tallyCompany && tpl.tallyCompany !== 'xyz' ? tpl.tallyCompany : null) || sampleData.companyName || 'Accounts Department';
                    const pdfBuf = await generateLedgerPdf({
                        companyName: activeCo,
                        ledgerName: testParty,
                        phoneNumber: cleanPhoneNumber(notifyTarget),
                        periodLabel: 'Last 3 Months (Test Verification)',
                        fromDateStr: sampleData.fromDateStr,
                        toDateStr: sampleData.toDateStr,
                        openingBalance: sampleData.openingBalance,
                        totalDebit: sampleData.totalDebit,
                        totalCredit: sampleData.totalCredit,
                        closingBalance: sampleData.closingBalance,
                        vouchers: sampleData.vouchers
                    });

                    const targetJid = formatJid(notifyTarget);
                    await session.sock.sendMessage(targetJid, {
                        document: pdfBuf,
                        mimetype: 'application/pdf',
                        fileName: `Tally_Ledger_Test_${Date.now()}.pdf`,
                        caption: `*${tpl.companyName || 'Tally Bot'}* 🚀\n✅ *Tally Connection Verified!*\nThis is a sample test statement delivered from your Tally Integration template.`
                    });
                    session.addLog(`[${templateName}] 📄 Sample test statement PDF delivered to ${notifyTarget}.`);
                } catch (sendErr) {
                    session.addLog(`[${templateName}] Note: Could not send test PDF to notification number: ${sendErr.message}`);
                }
            }

            return res.json({ 
                success: true, 
                message: `Tally Server verified active! Template "${templateName}" is ready for customer requests.` 
            });

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
// External REST API Endpoints (Wati / Multi-Tenant CRM API Gateway)
// Authenticated with 50-character Access Token
// --------------------------------------------------------------------------

// Health & Status Check via Access Token
const statusApiHandler = async (req, res) => {
    const userId = req.user.id;
    const session = userSessions.get(userId);
    const subscription = await getUserSubscription(userId);
    const apiEndpoint = getApiEndpointForUser(req, userId);

    res.json({
        result: true,
        status: session?.connectionStatus || 'disconnected',
        userId: userId,
        apiEndpoint: apiEndpoint,
        quota: {
            plan: subscription?.planName || 'Free Trial',
            messagesSentToday: subscription?.messagesSentToday || 0,
            dailyLimit: subscription?.dailyLimit || 15,
            remainingToday: subscription?.remainingToday ?? null,
            totalCredits: subscription?.totalCredits || 0
        },
        timestamp: new Date().toISOString()
    });
};

app.get('/api/v1/:userId/status', authenticateApiAccessToken, statusApiHandler);
app.get('/:userId/api/v1/status', authenticateApiAccessToken, statusApiHandler);
app.get('/api/v1/status', authenticateApiAccessToken, statusApiHandler);

// Send WhatsApp Message via Access Token (Compatible with Wati / Custom REST calls)
const sendMessageApiHandler = async (req, res) => {
    const userId = req.user.id;
    const session = userSessions.get(userId);

    if (!session || session.connectionStatus !== 'connected' || !session.sock) {
        return res.status(400).json({
            result: false,
            message: 'WhatsApp session is not connected for this user account. Please scan the QR code first.',
            error: 'Session Disconnected'
        });
    }

    // Check quota
    const quotaCheck = await checkUserCanSendMessage(userId);
    if (!quotaCheck.allowed) {
        return res.status(403).json({
            result: false,
            message: `Message sending blocked: ${quotaCheck.reason}`,
            error: 'Quota Exceeded'
        });
    }

    const { 
        to, 
        phone, 
        whatsappNumber, 
        number, 
        recipient,
        message, 
        text, 
        body, 
        caption, 
        mediaUrl, 
        mediaType,
        fileName,
        image,
        imageBase64,
        file,
        fileBase64,
        mediaBase64
    } = req.body || {};

    const rawTarget = to || phone || whatsappNumber || number || recipient || req.params?.phoneNumber;
    const messageContent = message || text || body || '';
    const rawImage = image || imageBase64 || file || fileBase64 || mediaBase64;

    if (!rawTarget) {
        return res.status(400).json({
            result: false,
            message: 'Recipient number ("to", "phone", or "whatsappNumber") is required.',
            error: 'Missing Recipient'
        });
    }

    if (!messageContent && !mediaUrl && !rawImage) {
        return res.status(400).json({
            result: false,
            message: 'Message content ("message" or "text"), "mediaUrl", or base64 "image" is required.',
            error: 'Missing Message Content'
        });
    }

    try {
        const jid = formatJid(rawTarget);
        session.addLog(`[API Request] Sending message to ${rawTarget}...`);

        let sendResult;
        if (rawImage) {
            let imageBuffer;
            if (typeof rawImage === 'string') {
                const cleanBase64 = rawImage.replace(/^data:image\/[a-z0-9+]+;base64,/, '').trim();
                imageBuffer = Buffer.from(cleanBase64, 'base64');
            } else if (Buffer.isBuffer(rawImage)) {
                imageBuffer = rawImage;
            }
            sendResult = await session.sock.sendMessage(jid, {
                image: imageBuffer,
                caption: caption || messageContent || ''
            });
        } else if (mediaUrl) {
            const mType = mediaType || (mediaUrl.endsWith('.pdf') ? 'document' : 'image');
            if (mType === 'image') {
                sendResult = await session.sock.sendMessage(jid, {
                    image: { url: mediaUrl },
                    caption: caption || messageContent || ''
                });
            } else if (mType === 'document' || mType === 'pdf') {
                sendResult = await session.sock.sendMessage(jid, {
                    document: { url: mediaUrl },
                    fileName: fileName || 'document.pdf',
                    mimetype: 'application/pdf',
                    caption: caption || messageContent || ''
                });
            } else if (mType === 'video') {
                sendResult = await session.sock.sendMessage(jid, {
                    video: { url: mediaUrl },
                    caption: caption || messageContent || ''
                });
            } else {
                sendResult = await session.sock.sendMessage(jid, { text: messageContent });
            }
        } else {
            sendResult = await session.sock.sendMessage(jid, { text: messageContent });
        }

        await recordUserMessageSent(userId);
        session.addLog(`[API Request] Message sent successfully to ${jid}`);

        res.json({
            result: true,
            success: true,
            message: 'Message sent successfully.',
            info: {
                messageId: sendResult?.key?.id || null,
                to: rawTarget,
                timestamp: new Date().toISOString()
            }
        });
    } catch (err) {
        session.addLog(`[API Request] Failed sending message: ${err.message}`);
        console.error(`[API Error User ${userId}]:`, err);
        res.status(500).json({
            result: false,
            success: false,
            message: `Failed to send message: ${err.message}`,
            error: err.message
        });
    }
};

// --------------------------------------------------------------------------
// Official WATI & Meta WhatsApp Template Message Dispatcher
// --------------------------------------------------------------------------
const sendTemplateMessageApiHandler = async (req, res) => {
    const userId = req.user.id;
    const session = userSessions.get(userId);

    if (!session || session.connectionStatus !== 'connected' || !session.sock) {
        return res.status(400).json({
            result: false,
            message: 'WhatsApp session is not connected for this user account. Please scan the QR code first.',
            error: 'Session Disconnected'
        });
    }

    // Check quota
    const quotaCheck = await checkUserCanSendMessage(userId);
    if (!quotaCheck.allowed) {
        return res.status(403).json({
            result: false,
            message: `Message sending blocked: ${quotaCheck.reason}`,
            error: 'Quota Exceeded'
        });
    }

    const {
        template_name,
        templateName,
        broadcast_name,
        whatsappNumber,
        phone,
        to,
        number,
        parameters,
        params
    } = req.body || {};

    const rawTarget = whatsappNumber || req.query.whatsappNumber || phone || req.query.phone || to || req.query.to || number;
    const tplName = (template_name || templateName || req.query.template_name || req.query.templateName || '').toString().trim();

    if (!rawTarget) {
        return res.status(400).json({
            result: false,
            message: 'Recipient whatsappNumber ("whatsappNumber" or "phone") is required.',
            error: 'Missing Recipient'
        });
    }

    if (!tplName) {
        return res.status(400).json({
            result: false,
            message: 'Template name ("template_name") is required.',
            error: 'Missing Template Name'
        });
    }

    try {
        const jid = formatJid(rawTarget);
        session.addLog(`[Template API] Processing template "${tplName}" for ${rawTarget}...`);

        // 1. Fetch template definition from database/local storage
        const templateDef = await getMessageTemplateByName(userId, tplName);

        // Map parameters array [{ name: 'Name', value: 'Chetan' }] or object { Name: 'Chetan' } into key-value map
        const paramMap = {};
        const rawParams = parameters || params || req.body.templateParameters || [];
        if (Array.isArray(rawParams)) {
            rawParams.forEach((p, idx) => {
                if (p && p.name !== undefined) {
                    paramMap[p.name.toString().trim().toLowerCase()] = p.value !== undefined ? p.value : '';
                    paramMap[`{{${p.name.toString().trim().toLowerCase()}}}`] = p.value !== undefined ? p.value : '';
                    paramMap[(idx + 1).toString()] = p.value !== undefined ? p.value : '';
                } else if (typeof p === 'string') {
                    paramMap[(idx + 1).toString()] = p;
                }
            });
        } else if (typeof rawParams === 'object' && rawParams !== null) {
            Object.keys(rawParams).forEach(k => {
                paramMap[k.toLowerCase()] = rawParams[k];
                paramMap[`{{${k.toLowerCase()}}}`] = rawParams[k];
            });
        }

        // Helper to replace {{var}} or {{1}} in text
        function substituteTemplateVars(text) {
            if (!text) return '';
            return text.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (match, p1) => {
                const lower = p1.toLowerCase();
                if (paramMap[lower] !== undefined) return paramMap[lower];
                if (paramMap[p1] !== undefined) return paramMap[p1];
                return match;
            });
        }

        let bodyText = templateDef ? templateDef.bodyText : (req.body.body || req.body.message || `Template: ${tplName}`);
        let formattedBody = substituteTemplateVars(bodyText);

        let headerType = templateDef ? (templateDef.headerType || 'none') : (req.body.headerType || 'none');
        let headerContent = templateDef ? (templateDef.headerContent || '') : (req.body.headerContent || req.body.mediaUrl || '');
        let formattedHeader = substituteTemplateVars(headerContent);

        let footerText = templateDef ? (templateDef.footerText || '') : (req.body.footerText || req.body.footer || '');
        let formattedFooter = substituteTemplateVars(footerText);

        // Attach footer if present
        let finalCaption = formattedBody;
        if (formattedFooter) {
            finalCaption += `\n\n_${formattedFooter}_`;
        }

        let sendResult;
        const lowerHeader = (headerType || 'none').toLowerCase();

        if (lowerHeader === 'document' || lowerHeader === 'pdf' || (formattedHeader && formattedHeader.toLowerCase().includes('.pdf'))) {
            let docUrl = formattedHeader;
            let fileName = 'document.pdf';
            if (templateDef && templateDef.name) {
                fileName = `${templateDef.name}.pdf`;
            }
            if (/^https?:\/\//i.test(docUrl)) {
                sendResult = await session.sock.sendMessage(jid, {
                    document: { url: docUrl },
                    fileName: fileName,
                    mimetype: 'application/pdf',
                    caption: finalCaption
                });
            } else {
                sendResult = await session.sock.sendMessage(jid, { text: `*${formattedHeader}*\n\n${finalCaption}` });
            }
        } else if (lowerHeader === 'image' || (formattedHeader && /\.(png|jpe?g|webp)/i.test(formattedHeader))) {
            if (/^https?:\/\//i.test(formattedHeader)) {
                sendResult = await session.sock.sendMessage(jid, {
                    image: { url: formattedHeader },
                    caption: finalCaption
                });
            } else {
                sendResult = await session.sock.sendMessage(jid, { text: finalCaption });
            }
        } else if (lowerHeader === 'video' || (formattedHeader && /\.(mp4|mov|avi)/i.test(formattedHeader))) {
            if (/^https?:\/\//i.test(formattedHeader)) {
                sendResult = await session.sock.sendMessage(jid, {
                    video: { url: formattedHeader },
                    caption: finalCaption
                });
            } else {
                sendResult = await session.sock.sendMessage(jid, { text: finalCaption });
            }
        } else if (lowerHeader === 'text' && formattedHeader) {
            sendResult = await session.sock.sendMessage(jid, { text: `*${formattedHeader}*\n\n${finalCaption}` });
        } else {
            sendResult = await session.sock.sendMessage(jid, { text: finalCaption });
        }

        await recordUserMessageSent(userId);
        session.addLog(`[Template API] Template "${tplName}" sent successfully to ${jid}`);

        res.json({
            result: true,
            success: true,
            message: 'Template message sent successfully.',
            info: {
                messageId: sendResult?.key?.id || null,
                template: tplName,
                to: rawTarget,
                timestamp: new Date().toISOString()
            }
        });
    } catch (err) {
        session.addLog(`[Template API] Failed sending template "${tplName}": ${err.message}`);
        console.error(`[Template API Error User ${userId}]:`, err);
        res.status(500).json({
            result: false,
            success: false,
            message: `Failed to send template message: ${err.message}`,
            error: err.message
        });
    }
};

// --------------------------------------------------------------------------
// User Message Templates Management CRUD Routes (For Dashboard)
// --------------------------------------------------------------------------
app.get('/api/message-templates', authenticateUser, async (req, res) => {
    try {
        const templates = await getMessageTemplates(req.user.id);
        res.json({ success: true, templates });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/message-templates', authenticateUser, async (req, res) => {
    try {
        const saved = await saveMessageTemplate(req.user.id, req.body);
        res.json({ success: true, message: 'Template saved successfully!', template: saved });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/message-templates/:id', authenticateUser, async (req, res) => {
    try {
        await deleteMessageTemplate(req.user.id, req.params.id);
        res.json({ success: true, message: 'Template deleted successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/v1/:userId/messages', authenticateApiAccessToken, sendMessageApiHandler);
app.post('/:userId/api/v1/messages', authenticateApiAccessToken, sendMessageApiHandler);
app.post('/:userId/api/v1/send-message', authenticateApiAccessToken, sendMessageApiHandler);
app.post('/api/v1/:userId/send-message', authenticateApiAccessToken, sendMessageApiHandler);
app.post('/api/v1/send-message', authenticateApiAccessToken, sendMessageApiHandler);

// WATI / Meta Template API Endpoints
app.post('/api/v1/:userId/sendTemplateMessage', authenticateApiAccessToken, sendTemplateMessageApiHandler);
app.post('/:userId/api/v1/sendTemplateMessage', authenticateApiAccessToken, sendTemplateMessageApiHandler);
app.post('/api/v1/sendTemplateMessage', authenticateApiAccessToken, sendTemplateMessageApiHandler);
app.post('/:userId/api/v1/sendSessionMessage', authenticateApiAccessToken, sendMessageApiHandler);
app.post('/api/v1/:userId/sendSessionMessage', authenticateApiAccessToken, sendMessageApiHandler);
app.post('/api/v1/sendSessionMessage', authenticateApiAccessToken, sendMessageApiHandler);
app.post('/:userId/api/v1/sendSessionFile/:phoneNumber', authenticateApiAccessToken, sendMessageApiHandler);
app.post('/api/v1/:userId/sendSessionFile/:phoneNumber', authenticateApiAccessToken, sendMessageApiHandler);
app.post('/api/v1/sendSessionFile/:phoneNumber', authenticateApiAccessToken, sendMessageApiHandler);

// --------------------------------------------------------------------------
// ConvertAPI Microservice Routes (Self-Hosted ConvertAPI Engine)
// --------------------------------------------------------------------------
app.use('/convert', convertApiRouter);
app.use('/:userId/convert', convertApiRouter);
app.use('/api/convert', convertApiRouter);
app.use('/api/v1/convert', convertApiRouter);

// --------------------------------------------------------------------------
// Server Initialization
// --------------------------------------------------------------------------
async function startServer() {
    await initDatabase();

    // Auto-restore WhatsApp sessions only for users who have saved credentials
    try {
        const users = await getAllUsers();
        let connectedAny = false;
        for (const u of users) {
            const sessionFolder = path.join('auth_info', `session_user_${u.id}`);
            const credsFile = path.join(sessionFolder, 'creds.json');
            if (fs.existsSync(credsFile)) {
                getOrCreateUserSession(u.id, u.email);
                connectedAny = true;
            }
        }
        // If no session exists yet, start session for default primary admin (100000000001) to display QR code
        if (!connectedAny) {
            const primaryUser = users.find(u => u.id === '100000000001') || users[0];
            if (primaryUser) {
                getOrCreateUserSession(primaryUser.id, primaryUser.email);
            }
        }
    } catch (e) {
        console.error('Failed to auto-restore user sessions on startup:', e);
    }
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Cortex WA AutoBot Multi-Tenant Engine running on port ${PORT}`);
    });
}

startServer();
