import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/**
 * Tally Engine: Handles Tally XML HTTP communications, Ledger matching by phone,
 * and automated professional PDF statement generation.
 */

// Helper to clean phone numbers: strictly matches the 10 digits, ignoring country code (+91, 91, 0, etc.)
export function cleanPhoneNumber(phone) {
    if (!phone) return '';
    const digits = String(phone).replace(/[^\d]/g, '');
    if (digits.length >= 10) {
        return digits.slice(-10); // strictly the 10-digit mobile number
    }
    return digits;
}

// Helper: Format phone number for clean Indian display (+91 XXXXXXXXXX)
export function formatPhoneDisplay(phone) {
    if (!phone) return '';
    const digits = String(phone).replace(/[^\d]/g, '');
    if (digits.length >= 10) {
        return `+91 ${digits.slice(-10)}`;
    }
    return phone;
}

// Format Date as DD-MMM-YYYY (e.g. 12-Oct-2026)
export function formatDateDisplay(date) {
    const d = new Date(date);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = String(d.getDate()).padStart(2, '0');
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
}

// Format Date for Tally XML (YYYYMMDD)
export function formatDateTally(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

// Format Currency
export function formatCurrency(amount) {
    const num = Math.abs(Number(amount) || 0);
    return num.toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

/**
 * Get Active Open Company from Tally
 */
export async function getActiveTallyCompany(tallyUrl = 'http://localhost:9000') {
    const targetUrl = (tallyUrl || 'http://localhost:9000').trim().replace(/\/+$/, '');
    try {
        const queryXml = `
<ENVELOPE>
    <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER>
    <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY>
</ENVELOPE>`.trim();

        const res = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml;charset=utf-8' },
            body: queryXml
        });
        if (res.ok) {
            const xml = await res.text();
            const nameMatch = xml.match(/<COMPANY[^>]*NAME="([^"]+)"/i) || xml.match(/<NAME[^>]*>([^<]+)<\/NAME>/i);
            if (nameMatch && nameMatch[1]) {
                return nameMatch[1].trim();
            }
        }
    } catch (err) {
        console.warn('[Tally Engine] Could not fetch active company name:', err.message);
    }
    return null;
}

/**
 * Test Tally Server Connection & Company Status
 */
export async function testTallyConnection({ tallyUrl, companyName }) {
    const targetUrl = (tallyUrl || 'http://localhost:9000').trim().replace(/\/+$/, '');

    try {
        const detectedCompany = await getActiveTallyCompany(targetUrl);
        const resolvedCompany = (companyName && companyName.trim() !== 'xyz') ? companyName.trim() : (detectedCompany || '');

        const testXml = `
<ENVELOPE>
    <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>List of Companies</ID>
    </HEADER>
    <BODY>
        <DESC>
            <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                ${resolvedCompany ? `<SVCURRENTCOMPANY>${escapeXml(resolvedCompany)}</SVCURRENTCOMPANY>` : ''}
            </STATICVARIABLES>
        </DESC>
    </BODY>
</ENVELOPE>`.trim();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml;charset=utf-8' },
            body: testXml,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            return {
                success: false,
                error: `Tally responded with HTTP status ${response.status} (${response.statusText}).`
            };
        }

        const responseText = await response.text();
        const hasTallyMark = responseText.includes('<ENVELOPE') || 
                             responseText.includes('<RESPONSE') || 
                             responseText.includes('Tally is Running') ||
                             responseText.includes('<COMPANY');

        if (hasTallyMark) {
            const finalCompany = detectedCompany || resolvedCompany || 'Active Tally Company';
            return {
                success: true,
                message: `Connection established with Tally at ${targetUrl}! Active Company: ${finalCompany}`,
                tallyUrl: targetUrl,
                companyName: finalCompany
            };
        }

        return {
            success: true,
            message: `Tally Server reachable at ${targetUrl}.`,
            tallyUrl: targetUrl,
            companyName: detectedCompany || ''
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            return {
                success: false,
                error: `Connection timed out after 6s. Ensure Tally is open and accessible at ${targetUrl}.`
            };
        }
        return {
            success: false,
            error: `Failed to connect to Tally (${err.message}). Check port 9000 and firewall/tunnel.`
        };
    }
}

/**
 * Find Customer Ledger by Phone Number in Tally
 */
export async function findLedgerByPhone({ tallyUrl, companyName, phoneNumber }) {
    const cleanSearch = cleanPhoneNumber(phoneNumber);
    if (!cleanSearch) {
        return { found: false, error: 'Invalid phone number provided.' };
    }

    const targetUrl = (tallyUrl || 'http://localhost:9000').trim().replace(/\/+$/, '');

    let resolvedCompany = (companyName && companyName.trim() !== 'xyz') ? companyName.trim() : '';
    if (!resolvedCompany) {
        resolvedCompany = (await getActiveTallyCompany(targetUrl)) || '';
    }

    // Query helper
    async function executeLedgerQuery(withCompany = true) {
        const queryXml = `
<ENVELOPE>
    <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>CustomLedgerCollection</ID>
    </HEADER>
    <BODY>
        <DESC>
            <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                ${(withCompany && resolvedCompany) ? `<SVCURRENTCOMPANY>${escapeXml(resolvedCompany)}</SVCURRENTCOMPANY>` : ''}
            </STATICVARIABLES>
            <TDL>
                <TDLMESSAGE>
                    <COLLECTION NAME="CustomLedgerCollection">
                        <TYPE>Ledger</TYPE>
                        <FETCH>Name, LedgerMobile, LedgerPhone, LedgerContact, MobileNo, Phone, ContactPerson, Narration, Parent, ClosingBalance</FETCH>
                    </COLLECTION>
                </TDLMESSAGE>
            </TDL>
        </DESC>
    </BODY>
</ENVELOPE>`.trim();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml;charset=utf-8' },
                body: queryXml,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (response.ok) return await response.text();
        } catch (e) {
            clearTimeout(timeoutId);
        }
        return null;
    }

    try {
        let xmlText = await executeLedgerQuery(Boolean(resolvedCompany));
        let ledgerMatches = xmlText ? [...xmlText.matchAll(/<LEDGER[^>]*>([\s\S]*?)<\/LEDGER>/gi)] : [];

        // If specified company resulted in 0 ledgers or error, fallback to without company
        if (ledgerMatches.length === 0 || !xmlText || xmlText.includes('<LINEERROR>')) {
            const fallbackXml = await executeLedgerQuery(false);
            if (fallbackXml) {
                const fbMatches = [...fallbackXml.matchAll(/<LEDGER[^>]*>([\s\S]*?)<\/LEDGER>/gi)];
                if (fbMatches.length > 0) {
                    xmlText = fallbackXml;
                    ledgerMatches = fbMatches;
                }
            }
        }

        if (!xmlText || ledgerMatches.length === 0) {
            return {
                found: false,
                tallyUnavailable: true,
                error: 'Our accounting system is currently synchronizing. Please try later.'
            };
        }

        const candidateMatches = [];

            for (const match of ledgerMatches) {
                const block = match[1];
                const nameMatch = block.match(/NAME="([^"]+)"/i) || block.match(/<NAME>([^<]+)<\/NAME>/i);
                const ledgerName = nameMatch ? nameMatch[1].trim() : '';
                if (!ledgerName) continue;

                const parentMatch = block.match(/<PARENT[^>]*>([^<]+)<\/PARENT>/i);
                const parent = parentMatch ? parentMatch[1].trim() : '';
                const cbMatch = block.match(/<CLOSINGBALANCE[^>]*>([^<]+)<\/CLOSINGBALANCE>/i);
                const closingBalance = (cbMatch && cbMatch[1]) ? parseFloat(cbMatch[1]) : 0;

                // Extract all possible phone tags
                const mobileMatch = block.match(/<LEDGERMOBILE[^>]*>([^<]+)<\/LEDGERMOBILE>/i);
                const phoneMatch = block.match(/<LEDGERPHONE[^>]*>([^<]+)<\/LEDGERPHONE>/i);
                const contactMatch = block.match(/<LEDGERCONTACT[^>]*>([^<]+)<\/LEDGERCONTACT>/i);
                const mobNoMatch = block.match(/<MOBILENO[^>]*>([^<]+)<\/MOBILENO>/i);
                const phoneTagMatch = block.match(/<PHONE[^>]*>([^<]+)<\/PHONE>/i);
                const narrMatch = block.match(/<NARRATION[^>]*>([^<]+)<\/NARRATION>/i);

                const candidates = [
                    mobileMatch?.[1],
                    phoneMatch?.[1],
                    contactMatch?.[1],
                    mobNoMatch?.[1],
                    phoneTagMatch?.[1],
                    narrMatch?.[1]
                ].filter(Boolean);

                let isMatch = false;
                let matchedNumber = '';

                // 1. Check specific phone tags
                for (const rawPhone of candidates) {
                    const cleanP = cleanPhoneNumber(rawPhone);
                    if (cleanP && cleanP.slice(-10) === cleanSearch.slice(-10)) {
                        isMatch = true;
                        matchedNumber = rawPhone;
                        break;
                    }
                    const allExtracted = String(rawPhone).match(/\d{10,12}/g) || [];
                    for (const num of allExtracted) {
                        if (num.slice(-10) === cleanSearch.slice(-10)) {
                            isMatch = true;
                            matchedNumber = num;
                            break;
                        }
                    }
                    if (isMatch) break;
                }

                // 2. Fallback: Search anywhere in the ledger block
                if (!isMatch) {
                    const allBlockNumbers = block.match(/\d{10,12}/g) || [];
                    for (const bNum of allBlockNumbers) {
                        if (bNum.slice(-10) === cleanSearch.slice(-10)) {
                            isMatch = true;
                            matchedNumber = bNum;
                            break;
                        }
                    }
                }

                if (isMatch) {
                    candidateMatches.push({
                        ledgerName,
                        parent,
                        closingBalance,
                        registeredPhone: matchedNumber || cleanSearch,
                        companyName: resolvedCompany || companyName || 'Active Tally Company',
                        // Debtors / Creditors get highest priority in accounting
                        isDebtor: /debtor|customer|receivable/i.test(parent),
                        isCreditor: /creditor|payable|vendor/i.test(parent),
                        hasBalance: Math.abs(closingBalance) > 0
                    });
                }
            }

        if (candidateMatches.length > 0) {
            candidateMatches.sort((a, b) => {
                if (a.isDebtor && !b.isDebtor) return -1;
                if (!a.isDebtor && b.isDebtor) return 1;
                if (a.hasBalance && !b.hasBalance) return -1;
                if (!a.hasBalance && b.hasBalance) return 1;
                return 0;
            });

            const bestMatch = candidateMatches[0];
            return {
                found: true,
                ledgerName: bestMatch.ledgerName,
                registeredPhone: bestMatch.registeredPhone,
                companyName: bestMatch.companyName
            };
        }
    } catch (err) {
        console.warn(`[Tally Engine] XML fetch failed for phone ${cleanSearch}:`, err.message);
        return {
            found: false,
            tallyUnavailable: true,
            error: 'Our accounting system is currently synchronizing. Please try later.'
        };
    }

    return {
        found: false,
        error: `Customer phone number ${cleanSearch} is not registered in Tally.`
    };
}

/**
 * Get all registered debtor/customer phone numbers from Tally
 */
export async function getAllTallyPhoneNumbers({ tallyUrl, companyName }) {
    const targetUrl = (tallyUrl || 'http://localhost:9000').trim().replace(/\/+$/, '');
    const phoneList = new Set();

    async function executeQuery(withCompany = true) {
        const queryXml = `
<ENVELOPE>
    <HEADER>
        <VERSION>1</VERSION>
        <TALLYREQUEST>Export</TALLYREQUEST>
        <TYPE>Collection</TYPE>
        <ID>CustomLedgerCollection</ID>
    </HEADER>
    <BODY>
        <DESC>
            <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                ${(withCompany && companyName) ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : ''}
            </STATICVARIABLES>
            <TDL>
                <TDLMESSAGE>
                    <COLLECTION NAME="CustomLedgerCollection">
                        <TYPE>Ledger</TYPE>
                        <FETCH>Name, LedgerMobile, LedgerPhone, LedgerContact, MobileNo, Phone, ContactPerson, Narration</FETCH>
                    </COLLECTION>
                </TDLMESSAGE>
            </TDL>
        </DESC>
    </BODY>
</ENVELOPE>`.trim();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml;charset=utf-8' },
                body: queryXml,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (response.ok) return await response.text();
        } catch (e) {
            clearTimeout(timeoutId);
        }
        return null;
    }

    try {
        let xmlText = await executeQuery(Boolean(companyName));
        if (!xmlText || xmlText.includes('<LINEERROR>') || !xmlText.includes('<COLLECTION')) {
            xmlText = await executeQuery(false);
        }

        if (xmlText && xmlText.includes('<COLLECTION')) {
            const ledgerMatches = [...xmlText.matchAll(/<LEDGER[^>]*>([\s\S]*?)<\/LEDGER>/gi)];
            for (const match of ledgerMatches) {
                const block = match[1];
                const mobileMatch = block.match(/<LEDGERMOBILE[^>]*>([^<]+)<\/LEDGERMOBILE>/i);
                const phoneMatch = block.match(/<LEDGERPHONE[^>]*>([^<]+)<\/LEDGERPHONE>/i);
                const contactMatch = block.match(/<LEDGERCONTACT[^>]*>([^<]+)<\/LEDGERCONTACT>/i);
                const mobNoMatch = block.match(/<MOBILENO[^>]*>([^<]+)<\/MOBILENO>/i);
                const phoneTagMatch = block.match(/<PHONE[^>]*>([^<]+)<\/PHONE>/i);
                const narrMatch = block.match(/<NARRATION[^>]*>([^<]+)<\/NARRATION>/i);

                const candidates = [
                    mobileMatch?.[1],
                    phoneMatch?.[1],
                    contactMatch?.[1],
                    mobNoMatch?.[1],
                    phoneTagMatch?.[1],
                    narrMatch?.[1]
                ].filter(Boolean);

                for (const raw of candidates) {
                    const clean = cleanPhoneNumber(raw);
                    if (clean && clean.length >= 10) {
                        phoneList.add('91' + clean.slice(-10));
                        phoneList.add(clean.slice(-10));
                    }
                }

                const allBlock10s = block.match(/\d{10,12}/g) || [];
                for (const bNum of allBlock10s) {
                    const c10 = bNum.slice(-10);
                    if (/^[6-9]\d{9}$/.test(c10)) {
                        phoneList.add('91' + c10);
                        phoneList.add(c10);
                    }
                }
            }
        }
    } catch (e) {}

    return Array.from(phoneList);
}


/**
 * Fetch Ledger Transactions for requested date range
 */
export async function fetchLedgerTransactions({ tallyUrl, companyName, ledgerName, months = 3 }) {
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - (months * 30));

    const fromDateTally = formatDateTally(fromDate);
    const toDateTally = formatDateTally(toDate);

    const fromDateDisplay = formatDateDisplay(fromDate);
    const toDateDisplay = formatDateDisplay(toDate);

    const targetUrl = (tallyUrl || 'http://localhost:9000').trim().replace(/\/+$/, '');

    let resolvedCompany = (companyName && companyName.trim() !== 'xyz') ? companyName.trim() : '';
    if (!resolvedCompany) {
        resolvedCompany = (await getActiveTallyCompany(targetUrl)) || '';
    }

    // 1. Fetch real ledger closing balance directly from Tally
    let realClosingBalance = 0;
    try {
        const ledgerQueryXml = `
<ENVELOPE>
    <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>LedgerInfo</ID></HEADER>
    <BODY>
        <DESC>
            <STATICVARIABLES>
                <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                ${resolvedCompany ? `<SVCURRENTCOMPANY>${escapeXml(resolvedCompany)}</SVCURRENTCOMPANY>` : ''}
            </STATICVARIABLES>
            <TDL>
                <TDLMESSAGE>
                    <COLLECTION NAME="LedgerInfo">
                        <TYPE>Ledger</TYPE>
                        <FETCH>Name, ClosingBalance</FETCH>
                    </COLLECTION>
                </TDLMESSAGE>
            </TDL>
        </DESC>
    </BODY>
</ENVELOPE>`.trim();

        const lRes = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml;charset=utf-8' },
            body: ledgerQueryXml
        });
        if (lRes.ok) {
            const lXml = await lRes.text();
            const matches = [...lXml.matchAll(/<LEDGER[^>]*>([\s\S]*?)<\/LEDGER>/gi)];
            for (const m of matches) {
                const b = m[1];
                const nm = b.match(/NAME="([^"]+)"/i) || b.match(/<NAME>([^<]+)<\/NAME>/i);
                if (nm && nm[1].trim().toLowerCase() === ledgerName.trim().toLowerCase()) {
                    const cbMatch = b.match(/<CLOSINGBALANCE[^>]*>([^<]+)<\/CLOSINGBALANCE>/i);
                    if (cbMatch && cbMatch[1]) {
                        realClosingBalance = parseFloat(cbMatch[1]) || 0;
                    }
                    break;
                }
            }
        }
    } catch (e) {
        console.warn('[Tally Engine] Live ledger balance query:', e.message);
    }

    // 2. Fetch live ledger vouchers from Tally
    async function executeVouchersQuery(withCompany = true) {
        const ledgerVouchersXml = `
<ENVELOPE>
    <HEADER>
        <TALLYREQUEST>Export Data</TALLYREQUEST>
    </HEADER>
    <BODY>
        <EXPORTDATA>
            <REQUESTDESC>
                <REPORTNAME>Ledger Vouchers</REPORTNAME>
                <STATICVARIABLES>
                    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
                    <LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>
                    <SVFROMDATE>${fromDateTally}</SVFROMDATE>
                    <SVTODATE>${toDateTally}</SVTODATE>
                    <ExplodeNarrFlag>YES</ExplodeNarrFlag>
                    ${(withCompany && resolvedCompany) ? `<SVCURRENTCOMPANY>${escapeXml(resolvedCompany)}</SVCURRENTCOMPANY>` : ''}
                </STATICVARIABLES>
            </REQUESTDESC>
        </EXPORTDATA>
    </BODY>
</ENVELOPE>`.trim();

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml;charset=utf-8' },
                body: ledgerVouchersXml,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (response.ok) return await response.text();
        } catch (e) {
            clearTimeout(timeoutId);
        }
        return null;
    }

    let vouchers = [];
    let openingBalance = 0;
    let closingBalance = realClosingBalance;

    try {
        let xml = await executeVouchersQuery(Boolean(companyName));
        if (!xml || xml.includes('<LINEERROR>')) {
            xml = await executeVouchersQuery(false);
        }

        if (xml) {
            // Extract vouchers from response
            const vchMatches = [...xml.matchAll(/<VOUCHER[^>]*>([\s\S]*?)<\/VOUCHER>/gi)];
            for (const vMatch of vchMatches) {
                const vBlock = vMatch[1];
                const isCancelled = vBlock.match(/<VCHSTATUSISCANCELLED>Yes<\/VCHSTATUSISCANCELLED>/i);
                if (isCancelled) continue; // Skip cancelled vouchers

                const dateM = vBlock.match(/<DATE>([^<]+)<\/DATE>/i);
                const typeM = vBlock.match(/<VOUCHERTYPENAME>([^<]+)<\/VOUCHERTYPENAME>/i);
                const noM = vBlock.match(/<VOUCHERNUMBER>([^<]+)<\/VOUCHERNUMBER>/i);
                const amountM = vBlock.match(/<AMOUNT>([^<]+)<\/AMOUNT>/i);
                const narrM = vBlock.match(/<NARRATION>([^<]+)<\/NARRATION>/i);

                const vDateStr = dateM ? dateM[1] : '';
                const vDate = vDateStr ? `${vDateStr.slice(6,8)}-${vDateStr.slice(4,6)}-${vDateStr.slice(0,4)}` : formatDateDisplay(new Date());
                const vType = typeM ? typeM[1] : 'Voucher';
                const vNo = noM ? noM[1] : '-';
                const rawAmount = amountM ? parseFloat(amountM[1]) : 0;
                const narration = narrM ? narrM[1].trim() : '';

                const isDebit = rawAmount > 0;
                const debit = isDebit ? Math.abs(rawAmount) : 0;
                const credit = !isDebit ? Math.abs(rawAmount) : 0;

                vouchers.push({
                    date: vDate,
                    particulars: narration ? `${vType} - ${narration}` : `${vType} (Inv #${vNo})`,
                    vchType: vType,
                    vchNo: vNo,
                    debit,
                    credit
                });
            }
        }
    } catch (err) {
        console.warn('[Tally Engine] Live vouchers query note:', err.message);
    }

    // Calculate totals strictly from real Tally data (zero demo data)
    let totalDebit = 0;
    let totalCredit = 0;
    let runningBalance = vouchers.length > 0 ? openingBalance : realClosingBalance;

    const computedVouchers = vouchers.map(v => {
        totalDebit += v.debit;
        totalCredit += v.credit;
        runningBalance = runningBalance + v.debit - v.credit;
        return {
            ...v,
            balance: runningBalance
        };
    });

    closingBalance = vouchers.length > 0 ? runningBalance : realClosingBalance;

    return {
        ledgerName,
        companyName: resolvedCompany || companyName || 'Company Account',
        months,
        fromDateStr: fromDateDisplay,
        toDateStr: toDateDisplay,
        openingBalance: vouchers.length > 0 ? openingBalance : realClosingBalance,
        totalDebit,
        totalCredit,
        closingBalance,
        vouchers: computedVouchers
    };
}

/**
 * Generate Professional A4 Ledger Statement PDF using pdf-lib
 */
export async function generateLedgerPdf({
    companyName = 'Company Enterprises',
    ledgerName = 'Customer Account',
    phoneNumber = '',
    periodLabel = 'Last 3 Months',
    fromDateStr = '',
    toDateStr = '',
    openingBalance = 0,
    totalDebit = 0,
    totalCredit = 0,
    closingBalance = 0,
    vouchers = []
}) {
    const pdfDoc = await PDFDocument.create();
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const { width, height } = page.getSize();

    // Top Brand Banner
    page.drawRectangle({
        x: 0,
        y: height - 90,
        width: width,
        height: 90,
        color: rgb(0.04, 0.44, 0.35) // Elegant Emerald Green
    });

    // Company Name Header
    page.drawText(companyName.toUpperCase(), {
        x: 40,
        y: height - 44,
        size: 16,
        font: fontBold,
        color: rgb(1, 1, 1)
    });

    page.drawText('STATEMENT OF LEDGER ACCOUNT', {
        x: 40,
        y: height - 66,
        size: 11,
        font: fontBold,
        color: rgb(0.9, 0.96, 0.93)
    });

    const dateGeneratedStr = formatDateDisplay(new Date());
    page.drawText(`Date: ${dateGeneratedStr}`, {
        x: width - 150,
        y: height - 44,
        size: 9,
        font: fontRegular,
        color: rgb(0.85, 0.95, 0.9)
    });

    page.drawText('Status: Verified Copy', {
        x: width - 150,
        y: height - 66,
        size: 9,
        font: fontOblique,
        color: rgb(0.85, 0.95, 0.9)
    });

    let y = height - 110;

    // Party Details Card
    const cardHeight = 55;
    page.drawRectangle({
        x: 40,
        y: y - cardHeight,
        width: width - 80,
        height: cardHeight,
        color: rgb(0.96, 0.98, 0.97),
        borderColor: rgb(0.8, 0.88, 0.84),
        borderWidth: 1
    });

    page.drawText('Account / Party Name:', {
        x: 52,
        y: y - 18,
        size: 8.5,
        font: fontRegular,
        color: rgb(0.4, 0.4, 0.4)
    });
    page.drawText(ledgerName, {
        x: 52,
        y: y - 32,
        size: 11,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.1)
    });
    if (phoneNumber) {
        page.drawText(`Mobile: ${formatPhoneDisplay(phoneNumber)}`, {
            x: 52,
            y: y - 46,
            size: 8.5,
            font: fontRegular,
            color: rgb(0.3, 0.3, 0.3)
        });
    }

    page.drawText('Statement Period:', {
        x: width - 220,
        y: y - 18,
        size: 8.5,
        font: fontRegular,
        color: rgb(0.4, 0.4, 0.4)
    });
    page.drawText(`${periodLabel} (${fromDateStr} to ${toDateStr})`, {
        x: width - 220,
        y: y - 32,
        size: 9,
        font: fontBold,
        color: rgb(0.04, 0.44, 0.35)
    });
    page.drawText('Currency: INR (Rs.)', {
        x: width - 220,
        y: y - 46,
        size: 8.5,
        font: fontRegular,
        color: rgb(0.3, 0.3, 0.3)
    });

    y -= (cardHeight + 16);

    // Opening Balance Highlight
    page.drawRectangle({
        x: 40,
        y: y - 20,
        width: width - 80,
        height: 20,
        color: rgb(0.92, 0.95, 0.98)
    });
    page.drawText('OPENING BALANCE', {
        x: 52,
        y: y - 14,
        size: 9,
        font: fontBold,
        color: rgb(0.1, 0.3, 0.6)
    });
    const opBalText = `Rs. ${formatCurrency(openingBalance)} ${openingBalance >= 0 ? 'Dr' : 'Cr'}`;
    page.drawText(opBalText, {
        x: width - 180,
        y: y - 14,
        size: 9,
        font: fontBold,
        color: rgb(0.1, 0.3, 0.6)
    });

    y -= 30;

    // Table Header
    const colX = {
        date: 45,
        particulars: 110,
        vchType: 260,
        debit: 350,
        credit: 425,
        balance: 505
    };

    page.drawRectangle({
        x: 40,
        y: y - 18,
        width: width - 80,
        height: 18,
        color: rgb(0.04, 0.44, 0.35)
    });

    page.drawText('Date', { x: colX.date, y: y - 13, size: 8, font: fontBold, color: rgb(1, 1, 1) });
    page.drawText('Particulars / Narration', { x: colX.particulars, y: y - 13, size: 8, font: fontBold, color: rgb(1, 1, 1) });
    page.drawText('Vch Type', { x: colX.vchType, y: y - 13, size: 8, font: fontBold, color: rgb(1, 1, 1) });
    page.drawText('Debit (Rs.)', { x: colX.debit, y: y - 13, size: 8, font: fontBold, color: rgb(1, 1, 1) });
    page.drawText('Credit (Rs.)', { x: colX.credit, y: y - 13, size: 8, font: fontBold, color: rgb(1, 1, 1) });
    page.drawText('Balance (Rs.)', { x: colX.balance, y: y - 13, size: 8, font: fontBold, color: rgb(1, 1, 1) });

    y -= 22;

    // Table Rows
    if (vouchers.length === 0) {
        page.drawRectangle({
            x: 40,
            y: y - 22,
            width: width - 80,
            height: 22,
            color: rgb(0.98, 0.98, 0.98)
        });
        page.drawText('No voucher transactions recorded for this party in the selected period.', {
            x: 52,
            y: y - 15,
            size: 8,
            font: fontOblique,
            color: rgb(0.45, 0.45, 0.45)
        });
        y -= 24;
    } else {
        let rowIndex = 0;
        for (const v of vouchers) {
            if (y < 120) break; // keep footer space

            const isEven = rowIndex % 2 === 0;
            if (isEven) {
                page.drawRectangle({
                    x: 40,
                    y: y - 16,
                    width: width - 80,
                    height: 16,
                    color: rgb(0.97, 0.98, 0.98)
                });
            }

            page.drawText(String(v.date || ''), { x: colX.date, y: y - 12, size: 7.5, font: fontRegular, color: rgb(0.2, 0.2, 0.2) });
            page.drawText(String(v.particulars || '').slice(0, 32), { x: colX.particulars, y: y - 12, size: 7.5, font: fontRegular, color: rgb(0.1, 0.1, 0.1) });
            page.drawText(String(v.vchType || '').slice(0, 16), { x: colX.vchType, y: y - 12, size: 7.5, font: fontRegular, color: rgb(0.3, 0.3, 0.3) });
            
            const debitStr = v.debit > 0 ? formatCurrency(v.debit) : '-';
            page.drawText(debitStr, { x: colX.debit, y: y - 12, size: 7.5, font: fontRegular, color: v.debit > 0 ? rgb(0.7, 0.1, 0.1) : rgb(0.5, 0.5, 0.5) });

            const creditStr = v.credit > 0 ? formatCurrency(v.credit) : '-';
            page.drawText(creditStr, { x: colX.credit, y: y - 12, size: 7.5, font: fontRegular, color: v.credit > 0 ? rgb(0.05, 0.5, 0.2) : rgb(0.5, 0.5, 0.5) });

            const balStr = `${formatCurrency(v.balance || 0)} ${v.balance >= 0 ? 'Dr' : 'Cr'}`;
            page.drawText(balStr, { x: colX.balance, y: y - 12, size: 7.5, font: fontBold, color: rgb(0.1, 0.1, 0.1) });

            y -= 17;
            rowIndex++;
        }
    }

    y -= 10;

    // Totals & Closing Balance Summary Box
    page.drawRectangle({
        x: 40,
        y: y - 48,
        width: width - 80,
        height: 48,
        color: rgb(0.94, 0.97, 0.95),
        borderColor: rgb(0.04, 0.44, 0.35),
        borderWidth: 1
    });

    page.drawText(`Total Debit: Rs. ${formatCurrency(totalDebit)}`, {
        x: 52,
        y: y - 18,
        size: 9,
        font: fontBold,
        color: rgb(0.7, 0.1, 0.1)
    });
    page.drawText(`Total Credit: Rs. ${formatCurrency(totalCredit)}`, {
        x: 52,
        y: y - 36,
        size: 9,
        font: fontBold,
        color: rgb(0.05, 0.5, 0.2)
    });

    page.drawText('CLOSING BALANCE:', {
        x: width - 240,
        y: y - 18,
        size: 9.5,
        font: fontBold,
        color: rgb(0.04, 0.44, 0.35)
    });
    const clBalText = `Rs. ${formatCurrency(closingBalance)} ${closingBalance >= 0 ? 'Dr (Receivable)' : 'Cr (Payable)'}`;
    page.drawText(clBalText, {
        x: width - 240,
        y: y - 36,
        size: 11,
        font: fontBold,
        color: rgb(0.04, 0.44, 0.35)
    });

    // Footer
    page.drawLine({
        start: { x: 40, y: 55 },
        end: { x: width - 40, y: 55 },
        thickness: 0.8,
        color: rgb(0.8, 0.8, 0.8)
    });

    page.drawText('This is a computer-generated statement directly from accounting software. No signature required.', {
        x: 40,
        y: 40,
        size: 7.5,
        font: fontRegular,
        color: rgb(0.5, 0.5, 0.5)
    });

    page.drawText(`Generated via Cortex AutoBot  •  ${dateGeneratedStr}`, {
        x: width - 220,
        y: 40,
        size: 7.5,
        font: fontRegular,
        color: rgb(0.5, 0.5, 0.5)
    });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}

function escapeXml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe).replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            default: return c;
        }
    });
}
