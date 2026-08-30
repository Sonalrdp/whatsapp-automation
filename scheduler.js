import cron from 'node-cron';
import { getBotConfig, formatJid } from './database.js';

let activeCronJob = null;
let currentSock = null;

// Keep track of the active socket
export function setSchedulerSocket(sock) {
    currentSock = sock;
}

// Set up or update the cron job
export async function setupScheduledMessage() {
    // Cancel existing job if active
    if (activeCronJob) {
        activeCronJob.stop();
        activeCronJob = null;
        console.log("Scheduler: Stopped existing cron job.");
    }

    if (!currentSock) {
        console.log("Scheduler: No active WhatsApp socket connection. Cannot schedule.");
        return;
    }

    const config = await getBotConfig();
    const targetNumber = config.targetNumber;
    const morningMessage = config.morningMessage || 'hlo';
    const scheduleTime = config.scheduleTime || '09:00'; // HH:MM format (24h)

    if (!targetNumber) {
        console.log("Scheduler: No target number configured yet. Cron job will not be started.");
        return;
    }

    const [hourStr, minuteStr] = scheduleTime.split(':');
    const hour = parseInt(hourStr, 10) ?? 9;
    const minute = parseInt(minuteStr, 10) ?? 0;

    // Cron expression: minute hour day-of-month month day-of-week
    const cronExpression = `${minute} ${hour} * * *`;

    console.log(`Scheduler: Scheduling morning message to "${targetNumber}" at ${scheduleTime} IST (Asia/Kolkata). Cron: "${cronExpression}"`);

    activeCronJob = cron.schedule(cronExpression, async () => {
        try {
            if (!currentSock) {
                console.warn("Scheduler: Cron triggered but no active socket exists!");
                return;
            }

            console.log(`Scheduler: Cron triggered! Sending morning message to ${targetNumber}...`);
            const jid = formatJid(targetNumber);
            
            await currentSock.sendMessage(jid, { text: morningMessage });
            console.log(`Scheduler: Successfully sent morning message to ${jid}`);
        } catch (err) {
            console.error("Scheduler: Error executing scheduled morning message:", err);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });
}
