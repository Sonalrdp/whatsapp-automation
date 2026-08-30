import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import pino from 'pino';
import makeWASocket, { DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

import { initDatabase, getAuthState, clearAuthState, getBotConfig, saveBotConfig, formatJid } from './database.js';
import { setSchedulerSocket, setupScheduledMessage } from './scheduler.js';

// Express setup
const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static('public')); // Serve the web dashboard

// State variables
let connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'qr_ready', 'connected'
let qrCodeDataUrl = null;
let groupsList = [];
let recentLogs = [];
let sock = null;

// Logger
const pinoLogger = pino({ level: 'silent' });

// Add helper to log bot events
function addLog(text) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const logItem = `[${timestamp}] ${text}`;
    console.log(logItem);
    recentLogs.unshift(logItem);
    if (recentLogs.length > 50) {
        recentLogs.pop();
    }
}

// Fetch participating groups
async function loadGroups() {
    if (!sock) return;
    try {
        addLog("Fetching participating groups list...");
        const groups = await sock.groupFetchAllParticipating();
        groupsList = Object.entries(groups).map(([jid, meta]) => ({
            jid: jid,
            name: meta.subject || 'Unnamed Group'
        }));
        addLog(`Found ${groupsList.length} groups.`);
    } catch (err) {
        console.error("Failed to fetch groups:", err);
        addLog(`Error fetching groups: ${err.message}`);
    }
}

// Main connection function
async function connectToWhatsApp() {
    connectionStatus = 'connecting';
    addLog("Connecting to WhatsApp Web API...");
    
    try {
        const { state, saveCreds } = await getAuthState('whatsapp_bot_session');
        
        sock = makeWASocket({
            auth: state,
            logger: pinoLogger
        });
        
        setSchedulerSocket(sock);
        
        // Listen for credential updates to save
        sock.ev.on('creds.update', saveCreds);
        
        // Listen for connection changes
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                try {
                    qrCodeDataUrl = await QRCode.toDataURL(qr);
                    connectionStatus = 'qr_ready';
                    addLog("New QR Code generated. Scan it on the Web Dashboard.");
                } catch (err) {
                    console.error("Error generating QR code data URL:", err);
                }
            }
            
            if (connection === 'close') {
                const isLoggedOut = lastDisconnect.error?.output?.statusCode === DisconnectReason.loggedOut;
                const disconnectMessage = lastDisconnect.error?.message || lastDisconnect.error || 'unknown reason';
                
                console.log(`Connection closed: ${disconnectMessage}. Reconnecting: ${!isLoggedOut}`);
                
                connectionStatus = 'disconnected';
                qrCodeDataUrl = null;
                groupsList = [];
                
                if (isLoggedOut) {
                    addLog("Logged out from WhatsApp session. Clearing auth credentials and generating a new QR code...");
                    await clearAuthState('whatsapp_bot_session');
                    setTimeout(connectToWhatsApp, 2000);
                } else {
                    addLog(`Disconnected: ${disconnectMessage}. Reconnecting in 5 seconds...`);
                    setTimeout(connectToWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                qrCodeDataUrl = null;
                addLog("WhatsApp connection established successfully!");
                
                // Fetch groups list
                await loadGroups();
                
                // Set up the scheduled morning message
                await setupScheduledMessage();
            }
        });
        
        // Listen for incoming messages
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            
            for (const msg of m.messages) {
                // Avoid processing messages sent by the bot itself
                if (msg.key.fromMe) continue;
                
                if (!msg.message) continue;
                
                const senderJid = msg.key.remoteJid;
                
                // Fetch latest config to verify targets
                const config = await getBotConfig();
                const targetNumber = config.targetNumber;
                
                if (!targetNumber) continue;
                
                // Check if message sender is the target phone number
                const formattedTarget = formatJid(targetNumber);
                
                if (senderJid !== formattedTarget) continue;
                
                // Extract document message if present
                let documentMessage = msg.message.documentMessage;
                if (msg.message.ephemeralMessage?.message?.documentMessage) {
                    documentMessage = msg.message.ephemeralMessage.message.documentMessage;
                }
                if (msg.message.viewOnceMessage?.message?.documentMessage) {
                    documentMessage = msg.message.viewOnceMessage.message.documentMessage;
                }
                
                if (documentMessage) {
                    const mimeType = documentMessage.mimetype || '';
                    const fileName = documentMessage.fileName || 'file';
                    
                    addLog(`Received document from target number: "${fileName}" (${mimeType})`);
                    
                    // Check if it's a PDF
                    if (mimeType.toLowerCase() === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
                        const targetGroup = config.targetGroup;
                        
                        if (!targetGroup) {
                            addLog("Error: Received PDF from target contact but no forwarding group JID is configured!");
                            continue;
                        }
                        
                        addLog(`PDF detected: "${fileName}". Downloading...`);
                        
                        try {
                            // Download media buffer
                            const buffer = await downloadMediaMessage(
                                msg,
                                'buffer',
                                {},
                                {
                                    logger: pinoLogger,
                                    reuploadRequest: sock.updateMediaMessage
                                }
                            );
                            
                            addLog(`PDF downloaded (${buffer.length} bytes). Forwarding to group...`);
                            
                            // Send document to group
                            await sock.sendMessage(targetGroup, {
                                document: buffer,
                                mimetype: 'application/pdf',
                                fileName: fileName,
                                caption: `Forwarded PDF from target: ${fileName}`
                            });
                            
                            addLog(`Successfully forwarded "${fileName}" to the target group.`);
                        } catch (err) {
                            addLog(`Failed to process/forward PDF: ${err.message}`);
                            console.error("PDF download/forward error:", err);
                        }
                    }
                }
            }
        });
        
    } catch (err) {
        addLog(`Initialization error: ${err.message}`);
        console.error("WhatsApp connection initialization error:", err);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// REST API Endpoints

// Liveness/Ping endpoint for UptimeRobot / Keep-Alive
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Retrieve status, QR code, configurations, logs, and groups
app.get('/api/status', async (req, res) => {
    try {
        const config = await getBotConfig();
        res.json({
            connectionStatus,
            qrCode: qrCodeDataUrl,
            config: {
                targetNumber: config.targetNumber || '',
                targetGroup: config.targetGroup || '',
                morningMessage: config.morningMessage || 'hlo',
                scheduleTime: config.scheduleTime || '09:00'
            },
            groups: groupsList,
            logs: recentLogs,
            isDatabase: !!process.env.DATABASE_URL
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save configuration and trigger scheduler update
app.post('/api/config', async (req, res) => {
    const { targetNumber, targetGroup, morningMessage, scheduleTime } = req.body;
    
    try {
        const config = {
            targetNumber: targetNumber || '',
            targetGroup: targetGroup || '',
            morningMessage: morningMessage || 'hlo',
            scheduleTime: scheduleTime || '09:00'
        };
        
        await saveBotConfig(config);
        addLog("Bot settings updated successfully.");
        
        // Re-setup scheduler
        await setupScheduledMessage();
        
        res.json({ success: true, message: 'Configuration saved and scheduler updated.' });
    } catch (err) {
        console.error("Error saving config:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Send a test message immediately to target number
app.post('/api/test-message', async (req, res) => {
    if (connectionStatus !== 'connected' || !sock) {
        return res.status(400).json({ success: false, error: 'WhatsApp is not connected!' });
    }
    
    try {
        const config = await getBotConfig();
        const targetNumber = config.targetNumber;
        const morningMessage = config.morningMessage || 'hlo';
        
        if (!targetNumber) {
            return res.status(400).json({ success: false, error: 'No target phone number configured!' });
        }
        
        const jid = formatJid(targetNumber);
        addLog(`Sending test message to "${targetNumber}"...`);
        
        await sock.sendMessage(jid, { text: `${morningMessage} (Test Message)` });
        addLog(`Test message sent successfully to ${jid}`);
        
        res.json({ success: true, message: 'Test message sent successfully.' });
    } catch (err) {
        addLog(`Error sending test message: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Initialize and Start Server
async function startServer() {
    // 1. Initialize PostgreSQL (if applicable)
    await initDatabase();
    
    // 2. Start Express Web server
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Web server running on port ${PORT}`);
        addLog(`Web server started on port ${PORT}`);
    });
    
    // 3. Start WhatsApp connection
    connectToWhatsApp();
}

startServer();
