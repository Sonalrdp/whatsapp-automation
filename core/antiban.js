// =========================================================================
// ANTI-BAN HUMANIZER & PRESENCE DISPATCHER
// =========================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AntiBanManager {
    constructor() {
        this.cache = new Map();
    }

    static getInstance() {
        if (!AntiBanManager.instance) {
            AntiBanManager.instance = new AntiBanManager();
        }
        return AntiBanManager.instance;
    }

    calculateTypingDelay(text, minDelay = 800, maxDelay = 2500) {
        if (!text) return minDelay;
        const length = typeof text === 'string' ? text.length : 20;
        const base = Math.min(length * 35, maxDelay);
        const jitter = Math.floor(Math.random() * 400);
        return Math.max(minDelay, Math.min(base + jitter, maxDelay));
    }

    async humanizeSend(sock, jid, content, options = {}) {
        if (!sock || !jid) return;

        const {
            antiBanTyping = true,
            antiBanReadFirst = false,
            minDelay = 600,
            maxDelay = 2200
        } = options;

        try {
            // 1. Mark as read before replying if requested
            if (antiBanReadFirst && options.messageKey) {
                await sock.readMessages([options.messageKey]).catch(() => {});
            }

            // 2. Presence subscribe to chat target
            await sock.presenceSubscribe(jid).catch(() => {});
            await sleep(150);

            // 3. Send typing/composing presence
            if (antiBanTyping) {
                const text = typeof content === 'string' ? content : (content?.text || '');
                const typingMs = this.calculateTypingDelay(text, minDelay, maxDelay);

                await sock.sendPresenceUpdate('composing', jid).catch(() => {});
                await sleep(typingMs);
                await sock.sendPresenceUpdate('paused', jid).catch(() => {});
            }
        } catch (e) {
            // Best effort humanizer: never block message transmission on presence failure
        }
    }
}

export const antiBan = AntiBanManager.getInstance();
