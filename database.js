import pg from 'pg';
import crypto from 'crypto';
import { initAuthCreds, BufferJSON, proto, useMultiFileAuthState } from '@whiskeysockets/baileys';
import fs from 'fs/promises';
import path from 'path';

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

// In-Memory OTP store for quick lookups & fallback
const otpStore = new Map();

// --------------------------------------------------------------------------
// 12-Digit Numeric User ID Generator
// --------------------------------------------------------------------------
export function generate12DigitId() {
    // Generate a random 12-digit number (100000000000 - 999999999999)
    const firstDigit = Math.floor(1 + Math.random() * 9).toString();
    const remainingDigits = crypto.randomInt(10000000000, 99999999999).toString().padStart(11, '0');
    return `${firstDigit}${remainingDigits}`;
}

// --------------------------------------------------------------------------
// Password Hashing & Verification
// --------------------------------------------------------------------------
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

export function verifyPasswordHash(password, storedHash) {
    if (!storedHash || !storedHash.includes(':')) return false;
    const [salt, originalHash] = storedHash.split(':');
    const hashToVerify = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return originalHash === hashToVerify;
}

// --------------------------------------------------------------------------
// JWT Token Helpers
// --------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || 'cortex_wa_default_jwt_secret_2026';

export function createToken(payload, expiresInHours = 72) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const exp = Math.floor(Date.now() / 1000) + (expiresInHours * 60 * 60);
    const fullPayload = { ...payload, exp };

    const base64UrlEncode = (str) => Buffer.from(JSON.stringify(str)).toString('base64url');
    const encodedHeader = base64UrlEncode(header);
    const encodedPayload = base64UrlEncode(fullPayload);

    const signature = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyToken(token) {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    const expectedSignature = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url');

    if (signature !== expectedSignature) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf-8'));
        if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
            return null;
        }
        return payload;
    } catch {
        return null;
    }
}

// --------------------------------------------------------------------------
// Subscription Plans & Quotas Matrix
// --------------------------------------------------------------------------
export const SUBSCRIPTION_PLANS = {
    trial: {
        id: 'trial',
        name: 'Free Trial',
        price: 0,
        period: '7 Days',
        durationDays: 7,
        dailyLimit: 15,
        totalLimit: 105,
        description: '7-Day Free Trial with 15 fixed messages every day'
    },
    starter_monthly: {
        id: 'starter_monthly',
        name: 'Starter Monthly',
        price: 399,
        period: '1 Month',
        durationDays: 30,
        dailyLimit: null,
        totalLimit: 1000,
        description: '1,000 messages / month • High-speed delivery'
    },
    pro_monthly: {
        id: 'pro_monthly',
        name: 'Pro Monthly',
        price: 499,
        period: '1 Month',
        durationDays: 30,
        dailyLimit: null,
        totalLimit: 1500,
        description: '1,500 messages / month • Priority WhatsApp socket'
    },
    starter_3m: {
        id: 'starter_3m',
        name: 'Starter 3 Months',
        price: 1099,
        period: '3 Months',
        durationDays: 90,
        dailyLimit: null,
        totalLimit: 3000,
        description: '3,000 messages (3 Months) • Save ₹98'
    },
    pro_3m: {
        id: 'pro_3m',
        name: 'Pro 3 Months',
        price: 1349,
        period: '3 Months',
        durationDays: 90,
        dailyLimit: null,
        totalLimit: 4500,
        description: '4,500 messages (3 Months) • Save ₹148'
    },
    starter_6m: {
        id: 'starter_6m',
        name: 'Starter 6 Months',
        price: 1999,
        period: '6 Months',
        durationDays: 180,
        dailyLimit: null,
        totalLimit: 6000,
        description: '6,000 messages (6 Months) • Save ₹395'
    },
    pro_6m: {
        id: 'pro_6m',
        name: 'Pro 6 Months',
        price: 2499,
        period: '6 Months',
        durationDays: 180,
        dailyLimit: null,
        totalLimit: 9000,
        description: '9,000 messages (6 Months) • Save ₹495'
    },
    starter_12m: {
        id: 'starter_12m',
        name: 'Starter 12 Months',
        price: 3599,
        period: '12 Months',
        durationDays: 365,
        dailyLimit: null,
        totalLimit: 12000,
        description: '12,000 messages (1 Year) • Save ₹1,189'
    },
    pro_12m: {
        id: 'pro_12m',
        name: 'Pro 12 Months',
        price: 4499,
        period: '12 Months',
        durationDays: 365,
        dailyLimit: null,
        totalLimit: 18000,
        description: '18,000 messages (1 Year) • Save ₹1,489'
    },
    addon_300: {
        id: 'addon_300',
        name: '300 Messages Booster Add-on',
        price: 50,
        period: 'Never Expires',
        durationDays: 365,
        dailyLimit: null,
        totalLimit: 300,
        isAddon: true,
        description: '300 Extra Messages Booster (₹50) • Never Expires'
    }
};

export function getTodayIST() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// --------------------------------------------------------------------------
// Database & Tables Initialization
// --------------------------------------------------------------------------
export async function initDatabase() {
    if (pool) {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS whatsapp_sessions (
                    session_id VARCHAR(100) NOT NULL,
                    key VARCHAR(255) NOT NULL,
                    value TEXT NOT NULL,
                    PRIMARY KEY (session_id, key)
                );
            `);

            await pool.query(`
                CREATE TABLE IF NOT EXISTS cortex_users (
                    id VARCHAR(64) PRIMARY KEY,
                    email VARCHAR(255) UNIQUE NOT NULL,
                    name VARCHAR(255) NOT NULL,
                    password_hash VARCHAR(255),
                    role VARCHAR(50) DEFAULT 'user',
                    avatar TEXT,
                    plan VARCHAR(50) DEFAULT 'trial',
                    plan_expires_at TIMESTAMP,
                    messages_sent_today INT DEFAULT 0,
                    last_message_date VARCHAR(20),
                    messages_sent_total INT DEFAULT 0,
                    addon_credits INT DEFAULT 0,
                    claimed_addon BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            `);

            // Apply column migrations if table already existed
            await pool.query(`ALTER TABLE cortex_users ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'trial'`);
            await pool.query(`ALTER TABLE cortex_users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMP`);
            await pool.query(`ALTER TABLE cortex_users ADD COLUMN IF NOT EXISTS messages_sent_today INT DEFAULT 0`);
            await pool.query(`ALTER TABLE cortex_users ADD COLUMN IF NOT EXISTS last_message_date VARCHAR(20)`);
            await pool.query(`ALTER TABLE cortex_users ADD COLUMN IF NOT EXISTS messages_sent_total INT DEFAULT 0`);
            await pool.query(`ALTER TABLE cortex_users ADD COLUMN IF NOT EXISTS addon_credits INT DEFAULT 0`);
            await pool.query(`ALTER TABLE cortex_users ADD COLUMN IF NOT EXISTS claimed_addon BOOLEAN DEFAULT FALSE`);

            console.log("PostgreSQL database initialized successfully (tables verified).");
        } catch (err) {
            console.error("Failed to initialize database tables:", err);
        }
    }

    try {
        await fs.mkdir('auth_info', { recursive: true });
        await fs.mkdir('bot_configs', { recursive: true });
    } catch {}

    await seedDefaultUsers();
}

// --------------------------------------------------------------------------
// Users Store & Management
// --------------------------------------------------------------------------
const LOCAL_USERS_FILE = 'users.json';

async function readLocalUsers() {
    try {
        const data = await fs.readFile(LOCAL_USERS_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

async function saveLocalUsers(users) {
    try {
        await fs.writeFile(LOCAL_USERS_FILE, JSON.stringify(users, null, 2));
    } catch (err) {
        console.error("Error saving local users file:", err);
    }
}

export async function seedDefaultUsers() {
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin.demo@gmail.com').toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || 'Avoid@123';
    const userEmail = (process.env.DEMO_USER_EMAIL || 'user.demo@gmail.com').toLowerCase();
    const userPassword = process.env.DEMO_USER_PASSWORD || 'Avoid@123';

    // Seed Admin with fixed 12-digit ID: 100000000001
    let admin = await getUserByEmail(adminEmail);
    if (!admin) {
        await createUser({
            id: '100000000001',
            email: adminEmail,
            name: 'Cortex Administrator',
            password: adminPassword,
            role: 'admin',
            avatar: 'assets/images/avatar/avatar-1.jpg'
        });
        console.log(`Default Admin seeded with 12-digit UID [100000000001]: ${adminEmail}`);
    } else if (!/^\d{12}$/.test(admin.id)) {
        // Ensure 12-digit numeric UID format
        admin.id = '100000000001';
        if (!pool) {
            const users = await readLocalUsers();
            const idx = users.findIndex(u => u.email.toLowerCase() === adminEmail);
            if (idx >= 0) { users[idx].id = '100000000001'; await saveLocalUsers(users); }
        }
    }

    // Seed Regular Demo User with fixed 12-digit ID: 200000000002
    let demoUser = await getUserByEmail(userEmail);
    if (!demoUser) {
        await createUser({
            id: '200000000002',
            email: userEmail,
            name: 'Demo Standard User',
            password: userPassword,
            role: 'user',
            avatar: 'assets/images/avatar/avatar-2.jpg'
        });
        console.log(`Default Demo User seeded with 12-digit UID [200000000002]: ${userEmail}`);
    } else if (!/^\d{12}$/.test(demoUser.id)) {
        demoUser.id = '200000000002';
        if (!pool) {
            const users = await readLocalUsers();
            const idx = users.findIndex(u => u.email.toLowerCase() === userEmail);
            if (idx >= 0) { users[idx].id = '200000000002'; await saveLocalUsers(users); }
        }
    }

    // Migration: ensure all existing local users have a 12-digit numeric UID
    if (!pool) {
        const users = await readLocalUsers();
        let changed = false;
        users.forEach(u => {
            if (!u.id || !/^\d{12}$/.test(u.id)) {
                u.id = generate12DigitId();
                changed = true;
            }
        });
        if (changed) {
            await saveLocalUsers(users);
        }
    }
}

export async function getUserByEmail(email) {
    if (!email) return null;
    const normalizedEmail = email.toLowerCase().trim();

    if (pool) {
        try {
            const res = await pool.query(
                `SELECT id, email, name, password_hash, role, avatar, plan, plan_expires_at, 
                        messages_sent_today, last_message_date, messages_sent_total, addon_credits, claimed_addon, 
                        created_at, last_login 
                 FROM cortex_users WHERE email = $1`,
                [normalizedEmail]
            );
            return res.rows[0] || null;
        } catch (err) {
            console.error("Error fetching user from DB:", err);
            return null;
        }
    } else {
        const users = await readLocalUsers();
        return users.find(u => u.email.toLowerCase() === normalizedEmail) || null;
    }
}

export async function getUserById(id) {
    if (!id) return null;

    if (pool) {
        try {
            const res = await pool.query(
                `SELECT id, email, name, role, avatar, plan, plan_expires_at, 
                        messages_sent_today, last_message_date, messages_sent_total, addon_credits, claimed_addon, 
                        created_at, last_login 
                 FROM cortex_users WHERE id = $1`,
                [id]
            );
            return res.rows[0] || null;
        } catch (err) {
            console.error("Error fetching user by ID:", err);
            return null;
        }
    } else {
        const users = await readLocalUsers();
        return users.find(u => u.id === id) || null;
    }
}

export async function getAllUsers() {
    if (pool) {
        try {
            const res = await pool.query(`SELECT id, email, name, role, avatar, plan, plan_expires_at, messages_sent_today, messages_sent_total, addon_credits, created_at, last_login FROM cortex_users ORDER BY created_at ASC`);
            return res.rows;
        } catch {
            return [];
        }
    } else {
        return readLocalUsers();
    }
}

export async function createUser({ id, email, name, password, role = 'user', avatar = '', plan = null }) {
    const normalizedEmail = email.toLowerCase().trim();
    const userId = (id && /^\d{12}$/.test(id)) ? id : generate12DigitId();
    const password_hash = password ? hashPassword(password) : null;
    const userAvatar = avatar || (role === 'admin' ? 'assets/images/avatar/avatar-1.jpg' : 'assets/images/avatar/avatar-2.jpg');
    const userRole = role;

    const userPlan = plan || (role === 'admin' ? 'pro_12m' : 'trial');
    const planDurationDays = SUBSCRIPTION_PLANS[userPlan]?.durationDays || (role === 'admin' ? 365 : 7);
    const plan_expires_at = new Date(Date.now() + planDurationDays * 24 * 60 * 60 * 1000).toISOString();
    const messages_sent_today = 0;
    const last_message_date = getTodayIST();
    const messages_sent_total = 0;
    const addon_credits = role === 'admin' ? 999999 : 0;
    const claimed_addon = role === 'admin';

    if (pool) {
        try {
            const res = await pool.query(
                `INSERT INTO cortex_users (
                    id, email, name, password_hash, role, avatar, 
                    plan, plan_expires_at, messages_sent_today, last_message_date, 
                    messages_sent_total, addon_credits, claimed_addon, created_at, last_login
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 RETURNING id, email, name, role, avatar, plan, plan_expires_at, messages_sent_today, messages_sent_total, addon_credits, claimed_addon, created_at, last_login`,
                [
                    userId, normalizedEmail, name || normalizedEmail.split('@')[0], password_hash, userRole, userAvatar,
                    userPlan, plan_expires_at, messages_sent_today, last_message_date,
                    messages_sent_total, addon_credits, claimed_addon
                ]
            );
            return res.rows[0];
        } catch (err) {
            console.error("Error creating user in DB:", err);
            throw err;
        }
    } else {
        const users = await readLocalUsers();
        const existingIdx = users.findIndex(u => u.email.toLowerCase() === normalizedEmail);
        const newUser = {
            id: userId,
            email: normalizedEmail,
            name: name || normalizedEmail.split('@')[0],
            password_hash,
            role: userRole,
            avatar: userAvatar,
            plan: userPlan,
            plan_expires_at,
            messages_sent_today,
            last_message_date,
            messages_sent_total,
            addon_credits,
            claimed_addon,
            created_at: new Date().toISOString(),
            last_login: new Date().toISOString()
        };

        if (existingIdx >= 0) {
            users[existingIdx] = { ...users[existingIdx], ...newUser };
        } else {
            users.push(newUser);
        }

        await saveLocalUsers(users);
        return newUser;
    }
}

export async function updateUserRole(userId, newRole) {
    if (!['admin', 'user'].includes(newRole)) throw new Error('Invalid role');

    if (pool) {
        await pool.query(`UPDATE cortex_users SET role = $1 WHERE id = $2`, [newRole, userId]);
    } else {
        const users = await readLocalUsers();
        const idx = users.findIndex(u => u.id === userId);
        if (idx >= 0) {
            users[idx].role = newRole;
            await saveLocalUsers(users);
        }
    }
}

// --------------------------------------------------------------------------
// Subscription Quota & Billing Management
// --------------------------------------------------------------------------
export async function getUserSubscription(userId) {
    const user = await getUserById(userId);
    if (!user) return null;

    const isAdmin = user.role === 'admin';
    const planKey = user.plan || (isAdmin ? 'pro_12m' : 'trial');
    const planMeta = SUBSCRIPTION_PLANS[planKey] || SUBSCRIPTION_PLANS.trial;

    const now = Date.now();
    const expiresAt = user.plan_expires_at ? new Date(user.plan_expires_at).getTime() : (now + 7 * 24 * 60 * 60 * 1000);
    const isExpired = !isAdmin && now > expiresAt;
    const daysLeft = isAdmin ? 365 : Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)));

    const todayIST = getTodayIST();
    let sentToday = user.messages_sent_today || 0;
    if (user.last_message_date !== todayIST) {
        sentToday = 0;
        // Reset today counter in DB
        if (pool) {
            await pool.query(`UPDATE cortex_users SET messages_sent_today = 0, last_message_date = $1 WHERE id = $2`, [todayIST, userId]);
        } else {
            const users = await readLocalUsers();
            const idx = users.findIndex(u => u.id === userId);
            if (idx >= 0) {
                users[idx].messages_sent_today = 0;
                users[idx].last_message_date = todayIST;
                await saveLocalUsers(users);
            }
        }
    }

    const sentTotal = user.messages_sent_total || 0;
    const addonCredits = user.addon_credits || 0;
    const claimedAddon = !!user.claimed_addon;

    // Daily limit calculation
    const dailyLimit = isAdmin ? null : planMeta.dailyLimit; // 15 for trial, null for paid
    const dailyRemaining = dailyLimit ? Math.max(0, dailyLimit - sentToday) : 'Unlimited';

    // Total limit calculation
    const totalLimit = isAdmin ? 999999 : planMeta.totalLimit;
    const totalRemaining = isAdmin ? 'Unlimited' : Math.max(0, totalLimit - sentTotal);

    return {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        plan: planKey,
        planName: planMeta.name,
        planPrice: planMeta.price,
        planPeriod: planMeta.period,
        planDescription: planMeta.description,
        isTrial: planKey === 'trial',
        isExpired,
        expiresAt: new Date(expiresAt).toISOString(),
        daysLeft,
        dailyLimit,
        messagesSentToday: sentToday,
        dailyRemaining,
        totalLimit,
        messagesSentTotal: sentTotal,
        totalRemaining,
        addonCredits,
        claimedAddon,
        canClaimFreeAddon: !claimedAddon
    };
}

export async function checkUserCanSendMessage(userId) {
    const sub = await getUserSubscription(userId);
    if (!sub) return { allowed: false, reason: 'User account not found.' };

    if (sub.role === 'admin') {
        return { allowed: true };
    }

    if (sub.isExpired) {
        return { 
            allowed: false, 
            reason: `Your ${sub.planName} has expired. Please upgrade your plan in Subscription & Billing to continue automation.` 
        };
    }

    // Check Daily Limit (For 7-Day Free Trial: 15 msgs/day fix)
    if (sub.dailyLimit && sub.messagesSentToday >= sub.dailyLimit) {
        if (sub.addonCredits > 0) {
            return { allowed: true, usingAddon: true };
        }
        return { 
            allowed: false, 
            reason: `Daily quota limit reached (15/15 messages today for Free Trial). Upgrade to a paid plan (₹399 / ₹499) for higher volume or claim the free ₹0 / 300 msgs Add-on!` 
        };
    }

    // Check Total Monthly/Plan Limit (For Paid Plans)
    if (sub.totalLimit && sub.messagesSentTotal >= sub.totalLimit) {
        if (sub.addonCredits > 0) {
            return { allowed: true, usingAddon: true };
        }
        return { 
            allowed: false, 
            reason: `Plan message quota exhausted (${sub.messagesSentTotal}/${sub.totalLimit} messages). Please renew or upgrade your plan in Subscription & Billing.` 
        };
    }

    return { allowed: true };
}

export async function recordUserMessageSent(userId) {
    const todayIST = getTodayIST();
    const sub = await getUserSubscription(userId);
    if (!sub) return;

    if (sub.role === 'admin') return;

    let useAddon = false;
    if (sub.dailyLimit && sub.messagesSentToday >= sub.dailyLimit && sub.addonCredits > 0) {
        useAddon = true;
    } else if (sub.totalLimit && sub.messagesSentTotal >= sub.totalLimit && sub.addonCredits > 0) {
        useAddon = true;
    }

    if (pool) {
        if (useAddon) {
            await pool.query(
                `UPDATE cortex_users 
                 SET addon_credits = GREATEST(0, addon_credits - 1),
                     messages_sent_today = messages_sent_today + 1,
                     messages_sent_total = messages_sent_total + 1,
                     last_message_date = $1 
                 WHERE id = $2`,
                [todayIST, userId]
            );
        } else {
            await pool.query(
                `UPDATE cortex_users 
                 SET messages_sent_today = messages_sent_today + 1,
                     messages_sent_total = messages_sent_total + 1,
                     last_message_date = $1 
                 WHERE id = $2`,
                [todayIST, userId]
            );
        }
    } else {
        const users = await readLocalUsers();
        const idx = users.findIndex(u => u.id === userId);
        if (idx >= 0) {
            users[idx].messages_sent_today = (users[idx].messages_sent_today || 0) + 1;
            users[idx].messages_sent_total = (users[idx].messages_sent_total || 0) + 1;
            users[idx].last_message_date = todayIST;
            if (useAddon) {
                users[idx].addon_credits = Math.max(0, (users[idx].addon_credits || 0) - 1);
            }
            await saveLocalUsers(users);
        }
    }
}

export async function claimUserFreeAddon(userId) {
    const sub = await getUserSubscription(userId);
    if (!sub) throw new Error('User not found');
    if (sub.claimedAddon) throw new Error('You have already claimed your free 300 messages add-on booster.');

    if (pool) {
        await pool.query(
            `UPDATE cortex_users 
             SET addon_credits = addon_credits + 300, claimed_addon = TRUE 
             WHERE id = $1`,
            [userId]
        );
    } else {
        const users = await readLocalUsers();
        const idx = users.findIndex(u => u.id === userId);
        if (idx >= 0) {
            users[idx].addon_credits = (users[idx].addon_credits || 0) + 300;
            users[idx].claimed_addon = true;
            await saveLocalUsers(users);
        }
    }

    return { success: true, message: 'Free 300 messages add-on credited successfully!' };
}

export async function upgradeUserSubscription(userId, planId, transactionRef = '') {
    const planMeta = SUBSCRIPTION_PLANS[planId];
    if (!planMeta) throw new Error('Invalid plan selected.');

    if (planMeta.isAddon || planId === 'addon_300') {
        if (pool) {
            await pool.query(
                `UPDATE cortex_users 
                 SET addon_credits = addon_credits + 300 
                 WHERE id = $1`,
                [userId]
            );
        } else {
            const users = await readLocalUsers();
            const idx = users.findIndex(u => u.id === userId);
            if (idx >= 0) {
                users[idx].addon_credits = (users[idx].addon_credits || 0) + 300;
                await saveLocalUsers(users);
            }
        }
        return {
            success: true,
            message: '300 Messages Booster (+300 credits) added to your account for ₹50!',
            plan: planMeta
        };
    }

    const now = Date.now();
    const expiresAt = new Date(now + planMeta.durationDays * 24 * 60 * 60 * 1000).toISOString();

    if (pool) {
        await pool.query(
            `UPDATE cortex_users 
             SET plan = $1, plan_expires_at = $2, messages_sent_today = 0, messages_sent_total = 0 
             WHERE id = $3`,
            [planId, expiresAt, userId]
        );
    } else {
        const users = await readLocalUsers();
        const idx = users.findIndex(u => u.id === userId);
        if (idx >= 0) {
            users[idx].plan = planId;
            users[idx].plan_expires_at = expiresAt;
            users[idx].messages_sent_today = 0;
            users[idx].messages_sent_total = 0;
            await saveLocalUsers(users);
        }
    }

    return { 
        success: true, 
        message: `Plan successfully upgraded to ${planMeta.name}! Active for ${planMeta.period}.`,
        plan: planMeta
    };
}

export async function deleteUser(userId) {
    if (pool) {
        await pool.query(`DELETE FROM cortex_users WHERE id = $1`, [userId]);
    } else {
        const users = await readLocalUsers();
        const filtered = users.filter(u => u.id !== userId);
        await saveLocalUsers(filtered);
    }

    // Clean up user auth credentials and bot configs
    await clearAuthState(`session_user_${userId}`);
    try {
        const configFile = path.join('bot_configs', `config_${userId}.json`);
        await fs.rm(configFile, { force: true });
    } catch {}
}

export async function findOrCreateGoogleUser({ email, name, avatar }) {
    const normalizedEmail = email.toLowerCase().trim();
    const adminEmail = (process.env.ADMIN_EMAIL || 'admin.demo@gmail.com').toLowerCase();
    
    let user = await getUserByEmail(normalizedEmail);
    if (!user) {
        const role = (normalizedEmail === adminEmail) ? 'admin' : 'user';
        user = await createUser({
            id: generate12DigitId(),
            email: normalizedEmail,
            name: name || normalizedEmail.split('@')[0],
            role,
            avatar: avatar || 'assets/images/avatar/avatar-3.jpg'
        });
    } else {
        if (!user.id || !/^\d{12}$/.test(user.id)) {
            user.id = generate12DigitId();
        }

        if (pool) {
            await pool.query(
                `UPDATE cortex_users SET last_login = CURRENT_TIMESTAMP, avatar = COALESCE($2, avatar), name = COALESCE($3, name), id = $4 WHERE email = $1`,
                [normalizedEmail, avatar, name, user.id]
            );
        } else {
            const users = await readLocalUsers();
            const idx = users.findIndex(u => u.email.toLowerCase() === normalizedEmail);
            if (idx >= 0) {
                users[idx].last_login = new Date().toISOString();
                users[idx].id = user.id;
                if (avatar) users[idx].avatar = avatar;
                if (name) users[idx].name = name;
                await saveLocalUsers(users);
            }
        }
    }

    return user;
}

// --------------------------------------------------------------------------
// OTP Management
// --------------------------------------------------------------------------
export function saveOtp(email, otp, expiryMinutes = 10) {
    const normalizedEmail = email.toLowerCase().trim();
    const expiresAt = Date.now() + (expiryMinutes * 60 * 1000);
    otpStore.set(normalizedEmail, { otp: String(otp), expiresAt });
}

export function verifyOtp(email, enteredOtp) {
    const normalizedEmail = email.toLowerCase().trim();
    const demoOtp = process.env.DEMO_OTP || '123456';

    if (enteredOtp && String(enteredOtp) === String(demoOtp)) {
        return true;
    }

    const record = otpStore.get(normalizedEmail);
    if (!record) return false;

    if (Date.now() > record.expiresAt) {
        otpStore.delete(normalizedEmail);
        return false;
    }

    if (String(record.otp) === String(enteredOtp).trim()) {
        otpStore.delete(normalizedEmail);
        return true;
    }

    return false;
}

// --------------------------------------------------------------------------
// Multi-Tenant Baileys Session & Configuration Storage
// --------------------------------------------------------------------------
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
        console.error(`Error writing data for session ${sessionId}, key ${key}:`, err);
    }
}

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
        console.error(`Error reading data for session ${sessionId}, key ${key}:`, err);
        return null;
    }
}

async function removeData(sessionId, key) {
    if (!pool) return;
    try {
        await pool.query(
            `DELETE FROM whatsapp_sessions WHERE session_id = $1 AND key = $2`,
            [sessionId, key]
        );
    } catch (err) {
        console.error(`Error removing data for session ${sessionId}, key ${key}:`, err);
    }
}

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

export async function getAuthState(sessionId) {
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (pool) {
        return useDbAuthState(safeSessionId);
    } else {
        const sessionFolder = path.join('auth_info', safeSessionId);
        await fs.mkdir(sessionFolder, { recursive: true });

        // Auto-heal Signal ratchet desynchronization (Bad MAC) by clearing stale session ratchets
        // while preserving creds.json (login state remains intact with NO re-scan needed)
        try {
            const rootFiles = await fs.readdir('auth_info');
            for (const file of rootFiles) {
                if (file.startsWith('session-') || file.startsWith('sender-key-')) {
                    await fs.unlink(path.join('auth_info', file)).catch(() => {});
                }
            }
            const files = await fs.readdir(sessionFolder);
            for (const file of files) {
                if (file.startsWith('session-') || file.startsWith('sender-key-')) {
                    await fs.unlink(path.join(sessionFolder, file)).catch(() => {});
                }
            }
        } catch (err) {
            console.warn(`[Auth Self-Heal] Could not prune stale sessions for ${safeSessionId}:`, err.message);
        }

        return useMultiFileAuthState(sessionFolder);
    }
}

export async function clearAuthState(sessionId) {
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (pool) {
        try {
            await pool.query(
                `DELETE FROM whatsapp_sessions WHERE session_id = $1`,
                [safeSessionId]
            );
            console.log(`Cleared DB auth state for session: ${safeSessionId}`);
        } catch (err) {
            console.error(`Error clearing DB auth state for ${safeSessionId}:`, err);
        }
    } else {
        try {
            const sessionFolder = path.join('auth_info', safeSessionId);
            await fs.rm(sessionFolder, { recursive: true, force: true });
            console.log(`Deleted local auth folder for session: ${safeSessionId}`);
        } catch (err) {
            console.error(`Error deleting auth folder for ${safeSessionId}:`, err);
        }
    }
}

export async function getUserBotConfig(userId) {
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (pool) {
        const config = await readData(`config_${safeUserId}`, 'bot_settings');
        return config || {
            targetNumber: '',
            targetGroup: '',
            morningMessage: '',
            scheduleTime: '09:00'
        };
    } else {
        try {
            const configFile = path.join('bot_configs', `config_${safeUserId}.json`);
            const data = await fs.readFile(configFile, 'utf-8');
            return JSON.parse(data);
        } catch {
            return {
                targetNumber: '',
                targetGroup: '',
                morningMessage: '',
                scheduleTime: '09:00'
            };
        }
    }
}

export async function saveUserBotConfig(userId, config) {
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (pool) {
        await writeData(`config_${safeUserId}`, 'bot_settings', config);
    } else {
        await fs.mkdir('bot_configs', { recursive: true });
        const configFile = path.join('bot_configs', `config_${safeUserId}.json`);
        await fs.writeFile(configFile, JSON.stringify(config, null, 2));
    }
}

export function formatJid(number) {
    if (!number) return '';
    if (number.includes('@')) return number;
    const cleanNumber = number.replace(/[^\d]/g, '');
    return `${cleanNumber}@s.whatsapp.net`;
}

// --------------------------------------------------------------------------
// Database Stats & Storage Diagnostics
// --------------------------------------------------------------------------
export async function getDatabaseStats() {
    const isPostgres = !!pool;
    let stats = {
        engine: isPostgres ? 'PostgreSQL' : 'Local File Storage (JSON/FS)',
        mode: isPostgres ? 'Production Managed Relational DB' : 'Local Filesystem Storage (Fallback)',
        status: 'Connected & Active',
        host: isPostgres ? (process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : 'Remote PostgreSQL') : 'Localhost Storage',
        databaseName: isPostgres ? (process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).pathname.replace('/', '') : 'whatsapp_sessions') : 'Local Workspace',
        sslEnabled: isPostgres,
        tables: [],
        totalUsers: 0,
        totalSessions: 0,
        totalConfigs: 0,
        checkedAt: new Date().toISOString()
    };

    if (pool) {
        try {
            const usersCountRes = await pool.query('SELECT COUNT(*) FROM cortex_users');
            const sessionsCountRes = await pool.query('SELECT COUNT(DISTINCT session_id) FROM whatsapp_sessions');
            const keysCountRes = await pool.query('SELECT COUNT(*) FROM whatsapp_sessions');

            stats.totalUsers = parseInt(usersCountRes.rows[0].count, 10);
            stats.totalSessions = parseInt(sessionsCountRes.rows[0].count, 10);

            stats.tables = [
                { 
                    name: 'cortex_users', 
                    type: 'Relational Table (SQL)',
                    records: stats.totalUsers, 
                    purpose: 'Stores registered user accounts, 12-digit numeric IDs, PBKDF2 password hashes, and roles' 
                },
                { 
                    name: 'whatsapp_sessions', 
                    type: 'Key-Value Table (SQL)',
                    records: parseInt(keysCountRes.rows[0].count, 10), 
                    purpose: 'Stores isolated Baileys Multi-Device WhatsApp authentication tokens & session keys per user' 
                }
            ];
        } catch (err) {
            stats.status = 'Error';
            stats.error = err.message;
        }
    } else {
        try {
            const users = await readLocalUsers();
            stats.totalUsers = users.length;

            let authFoldersCount = 0;
            try {
                const folders = await fs.readdir('auth_info');
                authFoldersCount = folders.length;
            } catch {}

            let configFilesCount = 0;
            try {
                const configs = await fs.readdir('bot_configs');
                configFilesCount = configs.length;
            } catch {}

            stats.totalSessions = authFoldersCount;
            stats.totalConfigs = configFilesCount;

            stats.tables = [
                { 
                    name: 'users.json', 
                    type: 'JSON Document Store',
                    records: stats.totalUsers, 
                    purpose: 'Stores registered user accounts, 12-digit numeric IDs, PBKDF2 password hashes, and roles' 
                },
                { 
                    name: 'auth_info/*', 
                    type: 'Multi-Folder Auth Store',
                    records: authFoldersCount, 
                    purpose: 'Stores isolated Baileys Multi-Device WhatsApp credentials and auth state keys per user' 
                },
                { 
                    name: 'bot_configs/*', 
                    type: 'JSON Config Store',
                    records: configFilesCount, 
                    purpose: 'Stores per-user automation target phone numbers, groups, morning messages, and IST schedules' 
                }
            ];
        } catch (err) {
            stats.status = 'Error';
            stats.error = err.message;
        }
    }

    return stats;
}
