import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

async function generateTallyGuidePdf() {
    const pdfDoc = await PDFDocument.create();
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

    function createA4Page() {
        return pdfDoc.addPage([595.28, 841.89]); // Standard A4 points
    }

    // ==========================================
    // PAGE 1
    // ==========================================
    let page = createA4Page();
    const { width, height } = page.getSize();

    // Top Header Banner
    page.drawRectangle({
        x: 0,
        y: height - 110,
        width: width,
        height: 110,
        color: rgb(0.04, 0.44, 0.35) // Elegant Emerald WhatsApp Green
    });

    page.drawText('Tally Integration & WhatsApp Automation', {
        x: 40,
        y: height - 52,
        size: 20,
        font: fontBold,
        color: rgb(1, 1, 1)
    });

    page.drawText('Complete Preparation & Setup Guide for Automated Ledger Delivery', {
        x: 40,
        y: height - 76,
        size: 11,
        font: fontRegular,
        color: rgb(0.88, 0.96, 0.92)
    });

    page.drawText('Multi-Tenant Cloud & Localhost Ready • Instant Verification & PDF Dispatch', {
        x: 40,
        y: height - 94,
        size: 8.5,
        font: fontOblique,
        color: rgb(0.75, 0.90, 0.85)
    });

    let y = height - 140;

    function drawSectionHeader(title) {
        page.drawRectangle({
            x: 40,
            y: y - 6,
            width: width - 80,
            height: 25,
            color: rgb(0.92, 0.96, 0.94)
        });
        page.drawRectangle({
            x: 40,
            y: y - 6,
            width: 4,
            height: 25,
            color: rgb(0.04, 0.44, 0.35)
        });
        page.drawText(title, {
            x: 52,
            y: y + 2,
            size: 11.5,
            font: fontBold,
            color: rgb(0.04, 0.44, 0.35)
        });
        y -= 26;
    }

    function drawTextLine(text, font = fontRegular, size = 9.5, color = rgb(0.2, 0.2, 0.2), indent = 45) {
        page.drawText(text, {
            x: indent,
            y: y,
            size: size,
            font: font,
            color: color
        });
        y -= 14;
    }

    function drawBox(title, lines, boxColor = rgb(0.96, 0.98, 1.0), borderColor = rgb(0.2, 0.45, 0.8)) {
        const boxHeight = 22 + (lines.length * 13);
        page.drawRectangle({
            x: 40,
            y: y - boxHeight + 12,
            width: width - 80,
            height: boxHeight,
            color: boxColor,
            borderColor: borderColor,
            borderWidth: 1
        });
        page.drawText(title, {
            x: 50,
            y: y - 2,
            size: 9.5,
            font: fontBold,
            color: borderColor
        });
        let lineY = y - 16;
        for (const line of lines) {
            page.drawText(line, {
                x: 50,
                y: lineY,
                size: 8.5,
                font: fontRegular,
                color: rgb(0.2, 0.2, 0.2)
            });
            lineY -= 12;
        }
        y -= (boxHeight + 8);
    }

    // SECTION 1: WORKFLOW
    drawSectionHeader('1. OVERVIEW: THE 6-STEP AUTOMATION FLOW');
    drawTextLine('This feature connects your WhatsApp Bot with TallyPrime / Tally.ERP 9 so clients can get instant ledgers.');
    y -= 3;
    drawBox('CUSTOMER JOURNEY IN WHATSAPP', [
        '1. Trigger Message: Customer sends "ledger" (or "hisab", "statement", etc.) to your WhatsApp bot.',
        '2. Phone Verification: Bot reads the sender phone and checks if registered in Tally Debtor ledgers.',
        '3. Duration Menu: If found, bot asks: [1] 1 Month  |  [2] 3 Months  |  [3] 6 Months  |  [4] 12 Months',
        '4. Instant Response: Customer taps/types choice -> Bot replies in 1 sec: "Please wait up to 10 min..."',
        '5. Background Extraction: Server queries Tally via XML, calculates debits, credits, and closing balance.',
        '6. Delivery: Server generates a branded PDF Statement and sends it directly to the customer on WhatsApp.'
    ], rgb(0.95, 0.98, 0.96), rgb(0.04, 0.44, 0.35));

    // SECTION 2: TALLY PREPARATION
    drawSectionHeader('2. STEP 1: ENABLE TALLY XML / HTTP SERVER');
    drawTextLine('Tally has a built-in XML Server used by third-party systems to read ledger statements safely.');
    y -= 3;
    drawTextLine('1. Open TallyPrime or Tally.ERP 9 on your computer or office server.', fontBold, 9.5);
    drawTextLine('2. Press F1 (Help) in the top menu -> Go to Settings -> Connectivity.', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('3. Open "Client/Server Configuration" and configure:', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('     • Tally acts as:  Both  (or Server)', fontBold, 9.5, rgb(0.04, 0.44, 0.35), 65);
    drawTextLine('     • Enable ODBC / XML:  Yes', fontBold, 9.5, rgb(0.04, 0.44, 0.35), 65);
    drawTextLine('     • Port:  9000  (Default port recommended)', fontBold, 9.5, rgb(0.04, 0.44, 0.35), 65);
    drawTextLine('4. Press Ctrl + A to accept and save settings.', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('5. Close and RESTART Tally for the XML Server to activate.', fontBold, 9.5, rgb(0.8, 0.1, 0.1), 55);
    y -= 4;

    drawBox('HOW TO VERIFY TALLY SERVER IS RUNNING ON PORT 9000', [
        'Open any web browser (Google Chrome, Edge) on your Tally PC and open: http://localhost:9000',
        'If Tally is active, your browser will show a plain white screen with the text: "Tally is Running!"'
    ], rgb(0.95, 0.99, 0.95), rgb(0.1, 0.5, 0.2));

    // SECTION 3: PHONE NUMBER MAPPING IN TALLY
    drawSectionHeader('3. STEP 2: CONFIGURE CUSTOMER PHONE NUMBERS IN TALLY');
    drawTextLine('The bot identifies incoming customers by matching their WhatsApp number with Tally ledger records:');
    y -= 3;
    drawTextLine('1. In Tally Gateway, go to Alter -> Ledger (or Accounts Info -> Ledgers -> Alter).', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('2. Select your Customer (Sundry Debtors) Ledger.', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('3. Under Mailing Details / Contact Details, find the Mobile No or Phone field.', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('4. Enter the customer mobile number (10 digits or with 91 prefix, e.g. 9876543210).', fontBold, 9.5, rgb(0.04, 0.44, 0.35), 55);
    drawTextLine('5. Press Ctrl + A to save the ledger.', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('Note: If a customer has multiple branches or phone numbers, comma-separate them or add in contact.', fontOblique, 8.5, rgb(0.4, 0.4, 0.4), 55);

    // Page 1 Footer
    page.drawText('Page 1 of 2  •  Cortex WA AutoBot - Tally Integration Guide', {
        x: 40,
        y: 22,
        size: 8,
        font: fontRegular,
        color: rgb(0.5, 0.5, 0.5)
    });

    // ==========================================
    // PAGE 2
    // ==========================================
    page = createA4Page();
    y = height - 50;

    page.drawText('Tally Integration & WhatsApp Automation Guide (Page 2)', {
        x: 40,
        y: y,
        size: 13,
        font: fontBold,
        color: rgb(0.04, 0.44, 0.35)
    });
    page.drawLine({
        start: { x: 40, y: y - 8 },
        end: { x: width - 40, y: y - 8 },
        thickness: 1.5,
        color: rgb(0.04, 0.44, 0.35)
    });
    y -= 32;

    // SECTION 4: NETWORKING
    drawSectionHeader('4. STEP 3: CONNECTING TALLY (LOCALHOST VS REMOTE CLOUD)');
    drawTextLine('Any user can hook up their own Tally instance based on where their bot runs:');
    y -= 4;

    drawTextLine('CASE A: Bot and Tally are on the Same Local Machine / Office PC', fontBold, 9.5, rgb(0.1, 0.3, 0.6));
    drawTextLine('• Server URL to use in Dashboard: http://127.0.0.1:9000 or http://localhost:9000', fontRegular, 9, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('• No external networking or router changes needed. Immediate plug & play.', fontRegular, 9, rgb(0.2, 0.2, 0.2), 55);
    y -= 8;

    drawTextLine('CASE B: Bot is on Cloud Server / VPS, Tally is at Your Office / Home PC', fontBold, 9.5, rgb(0.1, 0.3, 0.6));
    drawTextLine('Because Tally runs behind your home/office router, create a secure tunnel so your cloud bot can query it:', fontRegular, 9, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('Option 1 (Recommended & 100% Free): Cloudflare Tunnel', fontBold, 9, rgb(0.04, 0.44, 0.35), 55);
    drawTextLine('   1. Download "cloudflared" for Windows: https://developers.cloudflare.com/cloudflare-one/', fontRegular, 8.5, rgb(0.3, 0.3, 0.3), 65);
    drawTextLine('   2. Open PowerShell / Command Prompt on your Tally PC and execute:', fontRegular, 8.5, rgb(0.3, 0.3, 0.3), 65);
    drawTextLine('        cloudflared tunnel --url http://localhost:9000', fontBold, 9, rgb(0.8, 0.2, 0.1), 75);
    drawTextLine('   3. It will give you a public secure URL like: https://company-tally.trycloudflare.com', fontRegular, 8.5, rgb(0.3, 0.3, 0.3), 65);
    drawTextLine('   4. Paste that URL into the Tally Server URL field in your Bot Dashboard!', fontBold, 9, rgb(0.04, 0.44, 0.35), 65);
    y -= 4;
    drawTextLine('Option 2: Ngrok (Command: ngrok http 9000)', fontRegular, 8.5, rgb(0.3, 0.3, 0.3), 55);
    drawTextLine('Option 3: Static Public IP & Router Port Forwarding on Port 9000.', fontRegular, 8.5, rgb(0.3, 0.3, 0.3), 55);
    y -= 8;

    // SECTION 5: CREATING TEMPLATE IN DASHBOARD
    drawSectionHeader('5. STEP 4: ADDING TALLY TEMPLATE IN THE BOT DASHBOARD');
    drawTextLine('1. Log in to your Cortex AutoBot Dashboard and click Bot Configurations & Templates.', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('2. Click "+ Create Template" and choose "Tally Ledger Bot" from the template picker.', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('3. Fill in your Tally parameters:', fontRegular, 9.5, rgb(0.2, 0.2, 0.2), 55);
    drawTextLine('     • Template Name: e.g. "Customer Ledger Bot"', fontRegular, 9, rgb(0.2, 0.2, 0.2), 65);
    drawTextLine('     • Tally Server URL: http://localhost:9000 (or your Cloudflare Tunnel URL)', fontRegular, 9, rgb(0.2, 0.2, 0.2), 65);
    drawTextLine('     • Company Name: Exact name open in Tally (e.g. "Acme Traders Pvt Ltd")', fontRegular, 9, rgb(0.2, 0.2, 0.2), 65);
    drawTextLine('     • Trigger Keywords: ledger, leadger, statement, hisab, khata', fontRegular, 9, rgb(0.2, 0.2, 0.2), 65);
    drawTextLine('     • Durations: 1 Month, 3 Months, 6 Months, 12 Months', fontRegular, 9, rgb(0.2, 0.2, 0.2), 65);
    drawTextLine('     • Wait Message: "Please wait up to 10 min, your ledger is being generated..."', fontRegular, 9, rgb(0.2, 0.2, 0.2), 65);
    drawTextLine('4. Click "Test Connection" -> A green badge confirms active communication with Tally.', fontBold, 9.5, rgb(0.04, 0.44, 0.35), 55);
    drawTextLine('5. Click "Save Template & Apply" -> Your 24/7 Tally WhatsApp bot is now live!', fontBold, 9.5, rgb(0.04, 0.44, 0.35), 55);
    y -= 8;

    // SECTION 6: FAQ
    drawSectionHeader('6. FREQUENTLY ASKED QUESTIONS & TROUBLESHOOTING');
    drawBox('TALLY BOT CHECKLIST', [
        'Q1: What happens if Tally is closed or the PC is turned off?',
        '-> The bot will respond: "Our accounting system is currently synchronizing. Please try later."',
        'Q2: Can different users connect to different Tally companies?',
        '-> YES. Each registered user has their own isolated config, company name, and WhatsApp session.',
        'Q3: Does the customer get an official PDF statement?',
        '-> YES. The PDF includes voucher dates, particulars, debit, credit, opening balance, and closing balance.',
        'Q4: What if Tally is running in Cloud and the Cloud server is closed/offline?',
        '-> The bot detects the timeout and safely replies: "Our accounting cloud server is currently undergoing',
        '   scheduled maintenance. Please try later." To ensure 24/7 uptime, keep the Cloud VM running.'
    ], rgb(1.0, 0.98, 0.93), rgb(0.8, 0.5, 0.1));

    // Page 2 Footer
    page.drawText('Page 2 of 2  •  Cortex WA AutoBot - Multi-User Engine  •  Confidential & Proprietary', {
        x: 40,
        y: 22,
        size: 8,
        font: fontRegular,
        color: rgb(0.5, 0.5, 0.5)
    });

    const pdfBytes = await pdfDoc.save();

    const outputDir = path.resolve('public', 'docs');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const publicPath = path.join(outputDir, 'What_You_Have_to_Do_Prepare_for_Tally.pdf');
    const rootPath = path.resolve('What_You_Have_to_Do_Prepare_for_Tally.pdf');

    fs.writeFileSync(publicPath, pdfBytes);
    fs.writeFileSync(rootPath, pdfBytes);

    console.log(`[OK] PDF Generated successfully! Bytes: ${pdfBytes.length}`);
    console.log(`Saved to: ${publicPath}`);
    console.log(`Saved to: ${rootPath}`);
}

generateTallyGuidePdf().catch(console.error);
