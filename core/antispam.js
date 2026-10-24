// =========================================================================
// ANTI-SPAM QUEUE & RATE-LIMIT SCHEDULER
// =========================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AntiSpamManager {
    constructor() {
        this.sessionHistory = new Map();
        this.queues = new Map();
        this.processing = new Map();
    }

    static getInstance() {
        if (!AntiSpamManager.instance) {
            AntiSpamManager.instance = new AntiSpamManager();
        }
        return AntiSpamManager.instance;
    }

    async enqueue(userId, jid, config = {}) {
        const {
            antiSpamEnabled = true,
            spamLimit = 30, // max messages per interval
            spamInterval = 60000, // 60s
            spamDelayMin = 1000,
            spamDelayMax = 3000
        } = config;

        if (!antiSpamEnabled) return;

        return new Promise((resolve, reject) => {
            if (!this.queues.has(userId)) {
                this.queues.set(userId, []);
            }
            this.queues.get(userId).push({
                jid,
                queuedAt: Date.now(),
                resolve,
                reject
            });

            this.processQueue(userId, { spamLimit, spamInterval, spamDelayMin, spamDelayMax });
        });
    }

    async processQueue(userId, config) {
        if (this.processing.get(userId)) return;
        this.processing.set(userId, true);

        const queue = this.queues.get(userId);
        if (!queue) {
            this.processing.set(userId, false);
            return;
        }

        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;

            // Check rate window
            const now = Date.now();
            let history = this.sessionHistory.get(userId) || [];
            history = history.filter(t => now - t < config.spamInterval);

            if (history.length >= config.spamLimit) {
                const oldest = history[0];
                const waitTime = config.spamInterval - (now - oldest) + 500;
                await sleep(waitTime);
            }

            // Jitter delay between messages
            const jitter = config.spamDelayMin + Math.floor(Math.random() * (config.spamDelayMax - config.spamDelayMin));
            await sleep(jitter);

            history.push(Date.now());
            this.sessionHistory.set(userId, history);

            item.resolve();
        }

        this.processing.set(userId, false);
    }
}

export const antiSpam = AntiSpamManager.getInstance();
