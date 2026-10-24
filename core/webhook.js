// =========================================================================
// OUTBOUND WEBHOOK DISPATCHER
// =========================================================================

import crypto from 'crypto';

class WebhookDispatcher {
    constructor() {
        this.failures = new Map();
        this.MAX_FAILURES = 10;
    }

    static getInstance() {
        if (!WebhookDispatcher.instance) {
            WebhookDispatcher.instance = new WebhookDispatcher();
        }
        return WebhookDispatcher.instance;
    }

    generateSignature(payload, secret) {
        if (!secret) return '';
        return crypto
            .createHmac('sha256', secret)
            .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
            .digest('hex');
    }

    async dispatch(url, secret, eventType, data = {}, userId = '') {
        if (!url || typeof url !== 'string' || !url.startsWith('http')) return;

        const failCount = this.failures.get(url) || 0;
        if (failCount >= this.MAX_FAILURES) {
            return; // Temporarily circuit-break failed URLs
        }

        const payload = {
            event: eventType,
            userId,
            timestamp: new Date().toISOString(),
            data
        };

        const signature = this.generateSignature(payload, secret);
        const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Cortex-WA-AutoBot-Webhook/2.0'
        };
        if (signature) {
            headers['X-Hub-Signature-256'] = `sha256=${signature}`;
            headers['X-Webhook-Signature'] = signature;
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (res.ok) {
                this.failures.delete(url);
            } else {
                this.failures.set(url, failCount + 1);
            }
        } catch (err) {
            this.failures.set(url, failCount + 1);
        }
    }
}

export const webhookDispatcher = WebhookDispatcher.getInstance();
