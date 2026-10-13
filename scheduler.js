import cron from 'node-cron';
import { formatJid, checkUserCanSendMessage, recordUserMessageSent } from './database.js';
import { dispatchGoogleSheetAutomation } from './sheets_engine.js';

// Map of active cron jobs per user ID: userId -> Array of ScheduledTasks
const userCronJobs = new Map();

// Set up or update the cron jobs for a specific user
export async function setupUserScheduledMessage(userId, sock, config, addLogFn) {
    if (!userId) return;

    // 1. Cancel existing jobs for this user if active
    if (userCronJobs.has(userId)) {
        try {
            const existingTasks = userCronJobs.get(userId);
            if (Array.isArray(existingTasks)) {
                existingTasks.forEach(task => task.stop());
            } else if (existingTasks?.stop) {
                existingTasks.stop();
            }
            userCronJobs.delete(userId);
            if (addLogFn) addLogFn("Scheduler: Refreshed existing cron schedules.");
        } catch (e) {
            console.error(`Error stopping cron jobs for user ${userId}:`, e);
        }
    }

    if (!sock) {
        if (addLogFn) addLogFn("Scheduler: WhatsApp socket not connected. Waiting for connection...");
        return;
    }

    if (!config) return;

    const scheduledTemplates = (config.templates && Array.isArray(config.templates))
        ? config.templates.filter(t => t.active !== false && t.dispatchMode === 'scheduled')
        : ((config.targetNumber || config.targetGroup) ? [{
            name: 'Daily Morning Message',
            morningMessage: config.morningMessage || 'Good morning!',
            scheduleTime: config.scheduleTime || '09:00',
            scheduleFrequency: 'daily',
            destinations: config.targetGroup || config.targetNumber
        }] : []);

    if (scheduledTemplates.length === 0) {
        if (addLogFn) addLogFn("Scheduler: No active scheduled templates found. Cron idle.");
        return;
    }

    const activeTasks = [];

    for (const tpl of scheduledTemplates) {
        // Special Handling for Google Sheets Automation
        if (tpl.type === 'sheets') {
            const templateName = tpl.name || 'Google Sheets Automation';
            const scheduleTime = tpl.scheduleTime || '09:00';
            const [hourStr, minuteStr] = scheduleTime.split(':');
            const hour = parseInt(hourStr, 10) ?? 9;
            const minute = parseInt(minuteStr, 10) ?? 0;

            let cronExpression = `${minute} ${hour} * * *`;
            if (tpl.scheduleFrequency === 'weekly') {
                const day = tpl.scheduleDay || '1';
                cronExpression = `${minute} ${hour} * * ${day}`;
            } else if (tpl.scheduleFrequency === 'hourly') {
                cronExpression = `0 */${hour || 1} * * *`;
            }

            const logMsg = `Scheduler: Active Google Sheets rule "${templateName}" scheduled at ${scheduleTime} IST (Cron: "${cronExpression}").`;
            console.log(`[User ${userId}] ${logMsg}`);
            if (addLogFn) addLogFn(logMsg);

            const task = cron.schedule(cronExpression, async () => {
                try {
                    if (!sock) {
                        if (addLogFn) addLogFn(`Scheduler: [${templateName}] Trigger failed - WhatsApp socket is disconnected.`);
                        return;
                    }
                    await dispatchGoogleSheetAutomation(userId, sock, tpl, addLogFn);
                } catch (err) {
                    console.error(`[User ${userId}] Google Sheet scheduler error for ${templateName}:`, err);
                    if (addLogFn) addLogFn(`Scheduler: [${templateName}] Google Sheet error: ${err.message}`);
                }
            }, {
                scheduled: true,
                timezone: "Asia/Kolkata"
            });

            activeTasks.push(task);
            continue;
        }

        const destString = tpl.destinations || tpl.targetGroup || tpl.targetNumber || '';
        const targetDestinations = destString
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(dest => dest.includes('@') ? dest : formatJid(dest));

        if (targetDestinations.length === 0) continue;

        const templateName = tpl.name || 'Scheduled Broadcast';
        const morningMessage = tpl.morningMessage || 'Good morning! Here is today\'s scheduled update.';
        const scheduleTime = tpl.scheduleTime || '09:00';
        const [hourStr, minuteStr] = scheduleTime.split(':');
        const hour = parseInt(hourStr, 10) ?? 9;
        const minute = parseInt(minuteStr, 10) ?? 0;

        let cronExpression = `${minute} ${hour} * * *`;
        if (tpl.scheduleFrequency === 'weekly') {
            const day = tpl.scheduleDay || '1';
            cronExpression = `${minute} ${hour} * * ${day}`;
        } else if (tpl.scheduleFrequency === 'hourly') {
            cronExpression = `0 */${hour || 1} * * *`;
        }

        const logMsg = `Scheduler: Active rule "${templateName}" -> ${targetDestinations.length} destination(s) at ${scheduleTime} IST (Cron: "${cronExpression}").`;
        console.log(`[User ${userId}] ${logMsg}`);
        if (addLogFn) addLogFn(logMsg);

        const task = cron.schedule(cronExpression, async () => {
            try {
                if (!sock) {
                    if (addLogFn) addLogFn(`Scheduler: [${templateName}] Trigger failed - WhatsApp socket is disconnected.`);
                    return;
                }

                const quotaCheck = await checkUserCanSendMessage(userId);
                if (!quotaCheck.allowed) {
                    const limitMsg = `Scheduler: [${templateName}] Message not sent. ${quotaCheck.reason}`;
                    if (addLogFn) addLogFn(limitMsg);
                    return;
                }

                if (addLogFn) addLogFn(`Scheduler: [${templateName}] Triggered! Delivering to ${targetDestinations.length} destination(s)...`);

                let deliveredCount = 0;
                for (const jid of targetDestinations) {
                    const qCheck = await checkUserCanSendMessage(userId);
                    if (!qCheck.allowed) {
                        const limitMsg = `Scheduler: [${templateName}] Quota limit reached: ${qCheck.reason}`;
                        if (addLogFn) addLogFn(limitMsg);
                        break;
                    }
                    await sock.sendMessage(jid, { text: morningMessage });
                    await recordUserMessageSent(userId);
                    deliveredCount++;
                }

                if (deliveredCount > 0) {
                    const successMsg = `Scheduler: [${templateName}] Successfully delivered scheduled message to ${deliveredCount} destination(s).`;
                    console.log(`[User ${userId}] ${successMsg}`);
                    if (addLogFn) addLogFn(successMsg);

                    const notifyTarget = tpl.notificationTargetNumber || config.notificationTargetNumber;
                    if (notifyTarget) {
                        try {
                            const notifyJid = formatJid(notifyTarget);
                            const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                            const auditText = `🔔 *[Cortex AutoBot Alert]*\n✅ *Action:* Scheduled Broadcast Delivered\n📋 *Rule:* "${templateName}"\n👥 *Delivered To:* ${deliveredCount} destination(s)\n⏰ *Time:* ${timeIST} IST`;
                            sock.sendMessage(notifyJid, { text: auditText }).catch(() => {});
                        } catch (e) {}
                    }
                }
            } catch (err) {
                console.error(`[User ${userId}] Scheduler execution error for ${templateName}:`, err);
                if (addLogFn) addLogFn(`Scheduler: [${templateName}] Error sending: ${err.message}`);
            }
        }, {
            scheduled: true,
            timezone: "Asia/Kolkata"
        });

        activeTasks.push(task);
    }

    userCronJobs.set(userId, activeTasks);
}

// Stop scheduled messages for a user
export function stopUserScheduledMessage(userId) {
    if (userCronJobs.has(userId)) {
        try {
            const tasks = userCronJobs.get(userId);
            if (Array.isArray(tasks)) {
                tasks.forEach(t => t.stop());
            } else if (tasks?.stop) {
                tasks.stop();
            }
            userCronJobs.delete(userId);
            console.log(`Scheduler: Stopped cron jobs for user ${userId}`);
        } catch (e) {
            console.error(`Error stopping scheduler for ${userId}:`, e);
        }
    }
}
