import pg from 'pg';
import { initAuthCreds, BufferJSON, proto, useMultiFileAuthState } from '@whiskeysockets/baileys';

const { Pool } = pg;

let pool = null;

if (process.env.DATABASE_URL) {
    console.log("Database URL detected. Initializing PostgreSQL pool...");
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('localhost') ? false : {
            rejectUnauthorized: false // Required for Render Postgres connections
        }
    });
} else {
    console.log("No DATABASE_URL found. Fallback to local file storage will be used.");
}

// Ensure database table exists
export async function initDatabase() {
    if (!pool) return;
    try {
        const query = `
            CREATE TABLE IF NOT EXISTS whatsapp_sessions (
                session_id VARCHAR(100) NOT NULL,
                key VARCHAR(255) NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (session_id, key)
            );
        `;
        await pool.query(query);
        console.log("PostgreSQL database initialized successfully (whatsapp_sessions table verified).");
    } catch (err) {
        console.error("Failed to initialize database table:", err);
    }
}

// Write key-value to DB
async function writeData(sessionId, key, data) {
    if (!pool) return;
    try {
        const json = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(
            `INSERT INTO whatsapp_sessions (session_id, key, value) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (session_id, key) 
             DO UPDATE SET value = EXCLUDED.value`,
            [sessionId, key, json]
        );
    } catch (err) {
        console.error(`Error writing data for key ${key}:`, err);
    }
}

// Read key-value from DB
async function readData(sessionId, key) {
    if (!pool) return null;
    try {
        const res = await pool.query(
            `SELECT value FROM whatsapp_sessions WHERE session_id = $1 AND key = $2`,
            [sessionId, key]
        );
        if (res.rows.length === 0) return null;
        return JSON.parse(res.rows[0].value, BufferJSON.reviver);
    } catch (err) {
        console.error(`Error reading data for key ${key}:`, err);
        return null;
    }
}

// Remove key-value from DB
async function removeData(sessionId, key) {
    if (!pool) return;
    try {
        await pool.query(
            `DELETE FROM whatsapp_sessions WHERE session_id = $1 AND key = $2`,
            [sessionId, key]
        );
    } catch (err) {
        console.error(`Error removing data for key ${key}:`, err);
    }
}

// Custom DB auth state
async function useDbAuthState(sessionId) {
    const credsKey = 'creds';
    let creds = await readData(sessionId, credsKey);
    if (!creds) {
        creds = initAuthCreds();
        await writeData(sessionId, credsKey, creds);
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(sessionId, `${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const keyName = `${category}-${id}`;
                            tasks.push(value ? writeData(sessionId, keyName, value) : removeData(sessionId, keyName));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData(sessionId, credsKey, creds);
        }
    };
}

// Get Auth State (either DB or Multi File)
export async function getAuthState(sessionId) {
    if (pool) {
        return useDbAuthState(sessionId);
    } else {
        return useMultiFileAuthState('auth_info');
    }
}

// Clear Auth State (either DB or Multi File)
export async function clearAuthState(sessionId) {
    if (pool) {
        try {
            await pool.query(
                `DELETE FROM whatsapp_sessions WHERE session_id = $1`,
                [sessionId]
            );
            console.log(`Cleared database auth state for session: ${sessionId}`);
        } catch (err) {
            console.error(`Error clearing DB auth state:`, err);
        }
    } else {
        try {
            const fs = await import('fs/promises');
            await fs.rm('auth_info', { recursive: true, force: true });
            console.log(`Deleted auth_info folder for session: ${sessionId}`);
        } catch (err) {
            console.error(`Error deleting auth_info folder:`, err);
        }
    }
}

// Get Bot Configuration
export async function getBotConfig() {
    if (pool) {
        const config = await readData('global_config', 'bot_settings');
        return config || {};
    } else {
        try {
            const fs = await import('fs/promises');
            const data = await fs.readFile('bot_config.json', 'utf-8');
            return JSON.parse(data);
        } catch {
            return {};
        }
    }
}

// Save Bot Configuration
export async function saveBotConfig(config) {
    if (pool) {
        await writeData('global_config', 'bot_settings', config);
    } else {
        const fs = await import('fs/promises');
        await fs.writeFile('bot_config.json', JSON.stringify(config, null, 2));
    }
}

// Format phone number to WhatsApp JID safely (strips +, spaces, hyphens, etc.)
export function formatJid(number) {
    if (!number) return '';
    if (number.includes('@')) return number;
    const cleanNumber = number.replace(/[^\d]/g, '');
    return `${cleanNumber}@s.whatsapp.net`;
}
