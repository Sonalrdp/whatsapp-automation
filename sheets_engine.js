import { formatJid, checkUserCanSendMessage, recordUserMessageSent } from './database.js';

/**
 * Extract the main spreadsheet ID from any Google Sheets URL.
 * Works for /d/ID, /d/e/ID (published), and existing export URLs.
 */
export function extractSheetId(rawUrl) {
    if (!rawUrl) return null;
    const u = rawUrl.trim();
    // Pattern /d/e/{ID} (published)
    const pubMatch = u.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/);
    if (pubMatch) return { type: 'pub', id: pubMatch[1] };
    // Pattern /d/{ID}
    const docMatch = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (docMatch) return { type: 'doc', id: docMatch[1] };
    return null;
}

/**
 * List all sheet (tab) names from a Google Spreadsheet using the
 * public gviz/tq JSON endpoint. Returns array of { name, gid } objects.
 * Works only when the sheet is shared "Anyone with the link can view".
 */
export async function listGoogleSheetNames(rawUrl) {
    const parsed = extractSheetId(rawUrl);
    if (!parsed) throw new Error('Invalid Google Sheet URL. Could not extract spreadsheet ID.');

    if (parsed.type === 'pub') {
        // Published sheets: no gviz support; return single default sheet
        return [{ name: 'Sheet1', gid: '0' }];
    }

    const { id } = parsed;
    // gviz/tq returns JSON with metadata including sheet names
    const metaUrl = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json`;

    const res = await fetch(metaUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        redirect: 'follow'
    });

    if (!res.ok) {
        throw new Error(`Google Sheet returned HTTP ${res.status}. Ensure it is shared publicly ("Anyone with the link can view").`);
    }

    const text = await res.text();

    // gviz returns: google.visualization.Query.setResponse({...})
    // Extract the JSON payload
    const jsonMatch = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]+)\);?\s*$/);
    if (!jsonMatch) {
        if (text.includes('<!DOCTYPE html>') || text.includes('<html')) {
            throw new Error('Sheet returned a login page. Please set sharing to "Anyone with the link can view".');
        }
        throw new Error('Unexpected response from Google Sheet metadata API. Please check the URL.');
    }

    let parsed2;
    try {
        parsed2 = JSON.parse(jsonMatch[1]);
    } catch (e) {
        throw new Error('Failed to parse Google Sheet metadata response.');
    }

    // The metadata contains sheet name in parsed2.table but not all sheets.
    // Use the undocumented gviz url with &sheet=<sheetname> trick:
    // We actually need another approach - use the HTML page to extract sheet names.
    // Better: fetch the spreadsheet HTML and parse sheet names from tab buttons.
    const htmlUrl = `https://docs.google.com/spreadsheets/d/${id}/pubhtml`;
    try {
        const htmlRes = await fetch(htmlUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            redirect: 'follow'
        });
        if (htmlRes.ok) {
            const html = await htmlRes.text();
            // Match <li class="..."> sheet tab names
            const sheetMatches = [...html.matchAll(/data-sheet-id="([0-9]+)"[^>]*>([^<]+)<\/li>/gi)];
            if (sheetMatches.length > 0) {
                return sheetMatches.map(m => ({ gid: m[1], name: m[2].trim() }));
            }
            // Try alternative pattern: sheet buttons in exported HTML
            const altMatches = [...html.matchAll(/<li[^>]+id="s([0-9]+)"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi)];
            if (altMatches.length > 0) {
                return altMatches.map(m => ({ gid: m[1], name: m[2].trim() }));
            }
        }
    } catch (e) {}

    // Fallback: single default sheet from gviz
    const sheetName = parsed2?.table?.cols?.[0] ? 'Sheet1' : 'Sheet1';
    return [{ name: sheetName, gid: '0' }];
}

export function getGoogleSheetCsvUrls(rawUrl, gidOverride = null) {
    if (!rawUrl) return [];
    let u = rawUrl.trim();

    // If it's already an explicit CSV export URL
    if (u.includes('export?format=csv') || u.includes('output=csv')) {
        return [u];
    }

    const urls = [];
    const buildGidParam = (urlStr) => {
        if (gidOverride !== null && gidOverride !== undefined && gidOverride !== '') {
            return `&gid=${gidOverride}`;
        }
        const gidMatch = urlStr.match(/[?&#]gid=([0-9]+)/);
        return gidMatch ? `&gid=${gidMatch[1]}` : '';
    };

    // Pattern 1: /spreadsheets/d/e/{ID}/pubhtml or pub
    const pubMatch = u.match(/\/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/);
    if (pubMatch) {
        const id = pubMatch[1];
        const gidParam = buildGidParam(u);
        urls.push(`https://docs.google.com/spreadsheets/d/e/${id}/pub?output=csv${gidParam}`);
    }

    // Pattern 2: /spreadsheets/d/{ID}
    const docMatch = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (docMatch) {
        const id = docMatch[1];
        const gidParam = buildGidParam(u);
        // Primary export URL
        urls.push(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gidParam}`);
        // Fallback gviz URL
        urls.push(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${gidParam}`);
    }

    if (urls.length === 0) {
        urls.push(u);
    }

    return urls;
}

export function parseCSV(text) {
    const lines = [];
    let row = [];
    let inQuotes = false;
    let currentCell = '';

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                currentCell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            row.push(currentCell.trim());
            currentCell = '';
        } else if ((char === '\r' || char === '\n') && !inQuotes) {
            if (char === '\r' && nextChar === '\n') {
                i++;
            }
            row.push(currentCell.trim());
            if (row.some(c => c.length > 0)) {
                lines.push(row);
            }
            row = [];
            currentCell = '';
        } else {
            currentCell += char;
        }
    }
    if (currentCell.length > 0 || row.length > 0) {
        row.push(currentCell.trim());
        if (row.some(c => c.length > 0)) {
            lines.push(row);
        }
    }
    return lines;
}

export function resolveColumnIndex(rows, colSetting, defaultIdx) {
    if (!rows || rows.length === 0) return defaultIdx;
    const firstRow = rows[0];
    const s = String(colSetting || '').trim();

    // 1. Check if it matches a header name in the first row
    const headerIdx = firstRow.findIndex(h => h.trim().toLowerCase() === s.toLowerCase());
    if (headerIdx !== -1) return headerIdx;

    // 2. Check if it's a number (1-based: "1" => 0, "2" => 1)
    if (/^\d+$/.test(s)) {
        return Math.max(0, parseInt(s, 10) - 1);
    }

    // 3. Convert A-Z column letter to 0-based index (e.g. A => 0, B => 1, C => 2, AA => 26)
    if (/^[A-Za-z]+$/.test(s)) {
        const letters = s.toUpperCase();
        let idx = 0;
        for (let i = 0; i < letters.length; i++) {
            idx = idx * 26 + (letters.charCodeAt(i) - 64);
        }
        return Math.max(0, idx - 1);
    }

    return defaultIdx;
}

export async function fetchGoogleSheetCsv(sheetUrl, gidOverride = null) {
    const candidateUrls = getGoogleSheetCsvUrls(sheetUrl, gidOverride);
    let lastError = null;

    for (const url of candidateUrls) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                redirect: 'follow'
            });

            if (!res.ok) {
                lastError = new Error(`Google Sheet returned HTTP ${res.status}. Ensure sharing is set to "Anyone with the link can view".`);
                continue;
            }

            const text = await res.text();
            if (text.includes('<!DOCTYPE html>') || text.includes('<html')) {
                lastError = new Error('Sheet returned a login page. Sharing must be set to "Anyone with the link can view".');
                continue;
            }

            if (!text.trim()) {
                lastError = new Error('Selected sheet tab returned empty data. Check the sheet has data rows.');
                continue;
            }

            return text;
        } catch (err) {
            lastError = err;
        }
    }

    throw lastError || new Error('Failed to fetch Google Sheet. Please check the URL and sharing setting.');
}

export async function previewGoogleSheetRows(sheetUrl, phoneCol = 'A', msgCol = 'B', gidOverride = null) {
    const csvText = await fetchGoogleSheetCsv(sheetUrl, gidOverride);
    const rows = parseCSV(csvText);

    if (!rows || rows.length === 0) {
        throw new Error('Google Sheet appears to be empty.');
    }

    const phoneIdx = resolveColumnIndex(rows, phoneCol, 0);
    const msgIdx = resolveColumnIndex(rows, msgCol, 1);

    let startRow = 0;
    if (rows.length > 1) {
        const firstPhone = String(rows[0][phoneIdx] || '').toLowerCase();
        const firstMsg = String(rows[0][msgIdx] || '').toLowerCase();
        if (firstPhone.includes('phone') || firstPhone.includes('mobile') || firstPhone.includes('number') || firstPhone.includes('contact') ||
            firstMsg.includes('message') || firstMsg.includes('msg') || isNaN(firstPhone.replace(/[^\d]/g, '')) || firstPhone.replace(/[^\d]/g, '').length < 7) {
            startRow = 1;
        }
    }

    const dataRows = rows.slice(startRow);
    const previewList = [];

    for (let i = 0; i < dataRows.length; i++) {
        const r = dataRows[i];
        const rawPhone = String(r[phoneIdx] || '').trim();
        const rawMsg = String(r[msgIdx] || '').trim();
        const digits = rawPhone.replace(/[^\d]/g, '');

        if (digits.length >= 7) {
            previewList.push({
                rowNumber: startRow + i + 1,
                phone: digits,
                message: rawMsg || '(Default Template Message)'
            });
        }
    }

    return {
        totalRowsDetected: dataRows.length,
        validRecipientCount: previewList.length,
        phoneColumnIndex: phoneIdx,
        messageColumnIndex: msgIdx,
        previewRows: previewList.slice(0, 5)
    };
}

export async function dispatchGoogleSheetAutomation(userId, sock, tpl, addLogFn) {
    const templateName = tpl.name || 'Google Sheets Automation';
    const sheetUrl = (tpl.sheetUrl || '').trim();

    if (!sheetUrl) {
        throw new Error('No Google Sheet URL provided in template settings.');
    }

    if (addLogFn) addLogFn(`[${templateName}] Fetching Google Sheet spreadsheet...`);

    const gidOverride = tpl.sheetGid || null;
    const csvText = await fetchGoogleSheetCsv(sheetUrl, gidOverride);
    const rows = parseCSV(csvText);

    if (!rows || rows.length === 0) {
        throw new Error('Google Sheet returned empty data.');
    }

    const phoneColSetting = tpl.sheetColPhone || 'A';
    const msgColSetting = tpl.sheetColMsg || 'B';

    const phoneColIdx = resolveColumnIndex(rows, phoneColSetting, 0);
    const msgColIdx = resolveColumnIndex(rows, msgColSetting, 1);

    let startRow = 0;
    if (rows.length > 1) {
        const firstPhone = String(rows[0][phoneColIdx] || '').toLowerCase();
        const firstMsg = String(rows[0][msgColIdx] || '').toLowerCase();
        if (firstPhone.includes('phone') || firstPhone.includes('mobile') || firstPhone.includes('number') || firstPhone.includes('contact') ||
            firstMsg.includes('message') || firstMsg.includes('msg') || isNaN(firstPhone.replace(/[^\d]/g, '')) || firstPhone.replace(/[^\d]/g, '').length < 7) {
            startRow = 1;
        }
    }

    const candidateRows = rows.slice(startRow);
    if (candidateRows.length === 0) {
        throw new Error('No data rows found below sheet headers.');
    }

    if (addLogFn) addLogFn(`[${templateName}] Found ${candidateRows.length} row(s). Preparing WhatsApp delivery...`);

    let sentCount = 0;
    let failedCount = 0;

    for (let r = 0; r < candidateRows.length; r++) {
        const row = candidateRows[r];
        const rawPhone = String(row[phoneColIdx] || '').trim();
        const rawMsg = String(row[msgColIdx] || '').trim();

        const cleanDigits = rawPhone.replace(/[^\d]/g, '');
        if (!cleanDigits || cleanDigits.length < 7) {
            continue;
        }

        const msgToSend = rawMsg || tpl.morningMessage || tpl.bulkMessage || `Update from ${templateName}`;

        const qCheck = await checkUserCanSendMessage(userId);
        if (!qCheck.allowed) {
            if (addLogFn) addLogFn(`[${templateName}] 🛑 Quota limit reached: ${qCheck.reason}`);
            break;
        }

        try {
            const jid = formatJid(cleanDigits);
            await sock.sendMessage(jid, { text: msgToSend });
            await recordUserMessageSent(userId);
            sentCount++;
            if (addLogFn) addLogFn(`[${templateName}] (${sentCount}) Sent message to +${cleanDigits}: "${msgToSend.substring(0, 32)}..."`);
            // Safe throttle interval
            await new Promise(res => setTimeout(res, 1200));
        } catch (sendErr) {
            failedCount++;
            console.error(`[${templateName}] Failed to send to ${cleanDigits}:`, sendErr.message);
            if (addLogFn) addLogFn(`[${templateName}] Failed sending to +${cleanDigits}: ${sendErr.message}`);
        }
    }

    if (sentCount === 0) {
        throw new Error(`No messages could be sent. Ensure column "${phoneColSetting}" contains phone numbers with country code.`);
    }

    if (addLogFn) addLogFn(`[${templateName}] ✅ Complete! Delivered ${sentCount} message(s) from Google Sheet.`);

    // Real-time Audit Notification Target
    const notifyTarget = tpl.notificationTargetNumber;
    if (notifyTarget && sock) {
        try {
            const notifyJid = formatJid(notifyTarget);
            const timeIST = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const auditText = `🔔 *[Cortex AutoBot Alert]*\n📊 *Action:* Google Sheet Sync Completed\n📋 *Rule:* "${templateName}"\n📤 *Messages Delivered:* ${sentCount}\n⏰ *Time:* ${timeIST} IST`;
            sock.sendMessage(notifyJid, { text: auditText }).catch(() => {});
        } catch (e) {}
    }

    return { sentCount, totalRows: candidateRows.length };
}
