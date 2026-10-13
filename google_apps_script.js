/**
 * ==============================================================================
 * Cortex WA AutoBot - Google Apps Script (Code.gs)
 * ==============================================================================
 * Features:
 * 1. Email OTP Service:
 *    Sends a high-converting, professional, branded HTML email containing the
 *    6-digit verification OTP, 10-minute expiry warning, and security notice.
 * 
 * 2. Google Sheet User Sync:
 *    Maintains the "User" sheet tab, automatically creating headers if missing:
 *    [User ID, Full Name, Email, Role, Subscription Plan, Messages Today, Total Sent, Target Contact, WhatsApp State, Auth Provider, Created Date, Last Active]
 *    Dynamically updates existing rows by User ID or Email, or appends new rows.
 * ==============================================================================
 * Deployment Instructions:
 * 1. Open your Google Sheet.
 * 2. Click "Extensions" > "Apps Script".
 * 3. Delete any code in Code.gs and paste this ENTIRE file.
 * 4. Click "Deploy" > "New deployment".
 * 5. Select type: "Web app".
 * 6. Set Description: "Cortex AutoBot User Sync & OTP Service".
 * 7. Set "Execute as": "Me" (your Google account).
 * 8. Set "Who has access": "Anyone" (allows your Node.js backend to call it).
 * 9. Click "Deploy", authorize permissions when prompted.
 * 10. Copy the Web App URL and set it in your .env file:
 *     GOOGLE_SHEET_WEBAPP_URL=https://script.google.com/macros/s/.../exec
 * ==============================================================================
 */

const SHEET_NAME_USERS = "User";

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: "No POST body provided." });
    }

    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    if (action === "sendOtp") {
      return handleSendOtp(data);
    } else if (action === "saveUser" || action === "syncUser") {
      return handleSaveUser(data);
    } else {
      return jsonResponse({ success: false, error: "Unknown action: " + action });
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

function doGet(e) {
  return jsonResponse({
    status: "active",
    service: "Cortex WA AutoBot Google Sheet & OTP Webhook",
    timestamp: new Date().toISOString()
  });
}

/**
 * --------------------------------------------------------------------------
 * 1. HTML Email OTP Dispatcher
 * --------------------------------------------------------------------------
 */
function handleSendOtp(data) {
  var recipientEmail = data.email;
  var otp = data.otp;
  var userName = data.name || "Valued User";
  var appName = data.appName || "Cortex WA AutoBot";

  if (!recipientEmail || !otp) {
    return jsonResponse({ success: false, error: "Email and OTP are required." });
  }

  var subject = "🔐 " + otp + " is your " + appName + " Verification Code";

  var htmlTemplate = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verification Code</title>
  </head>
  <body style="margin: 0; padding: 0; background-color: #f4f6f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f6f9; padding: 30px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" max-width="540" style="max-width: 540px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid #e5e7eb;">
            <!-- Brand Header -->
            <tr>
              <td style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px 24px; text-align: center;">
                <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">
                  💬 ${appName}
                </h1>
                <p style="margin: 6px 0 0 0; color: rgba(255,255,255,0.9); font-size: 13px; font-weight: 500;">
                  Multi-User WhatsApp Automation Platform
                </p>
              </td>
            </tr>

            <!-- Content Body -->
            <tr>
              <td style="padding: 32px 28px;">
                <p style="margin: 0 0 16px 0; color: #1f2937; font-size: 16px; font-weight: 600;">
                  Hello ${userName},
                </p>
                <p style="margin: 0 0 24px 0; color: #4b5563; font-size: 14px; line-height: 1.6;">
                  Thank you for registering with <strong>${appName}</strong>. To verify your email address and activate your 7-Day Free Trial, please use the 6-digit verification code below:
                </p>

                <!-- OTP Code Display Card -->
                <div style="background-color: #f8fafc; border: 2px dashed #10b981; border-radius: 12px; padding: 22px 16px; text-align: center; margin-bottom: 24px;">
                  <span style="display: block; font-size: 12px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">
                    Your One-Time Verification Code
                  </span>
                  <span style="font-family: 'Courier New', Courier, monospace; font-size: 34px; font-weight: 800; color: #047857; letter-spacing: 8px; display: inline-block;">
                    ${otp}
                  </span>
                </div>

                <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 6px; margin-bottom: 24px;">
                  <p style="margin: 0; color: #92400e; font-size: 13px; line-height: 1.5;">
                    ⏰ <strong>Valid for 10 minutes:</strong> This code will expire in 10 minutes. If you did not request this registration, please ignore this email.
                  </p>
                </div>

                <p style="margin: 0 0 8px 0; color: #6b7280; font-size: 13px;">
                  🔒 <strong>Security Tip:</strong> Never share your verification code with anyone, including our support team.
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color: #f9fafb; padding: 20px 24px; text-align: center; border-top: 1px solid #f3f4f6;">
                <p style="margin: 0; color: #9ca3af; font-size: 12px;">
                  © ${new Date().getFullYear()} ${appName}. All rights reserved.
                </p>
                <p style="margin: 4px 0 0 0; color: #9ca3af; font-size: 11px;">
                  Automated Security Notification • Do not reply to this email
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;

  MailApp.sendEmail({
    to: recipientEmail,
    subject: subject,
    htmlBody: htmlTemplate
  });

  return jsonResponse({
    success: true,
    message: "OTP successfully sent to " + recipientEmail
  });
}

/**
 * --------------------------------------------------------------------------
 * 2. Google Sheet "User" Tab Synchronization
 * --------------------------------------------------------------------------
 */
function handleSaveUser(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME_USERS);

  // Headers matching dashboard table
  var headers = [
    "User ID",
    "Full Name",
    "Email Address",
    "Role",
    "Subscription Plan",
    "Messages Today",
    "Total Messages Sent",
    "Target Contact Number",
    "WhatsApp State",
    "Auth Provider",
    "Created Date",
    "Last Active"
  ];

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME_USERS);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#e2e8f0");
    sheet.setFrozenRows(1);
  } else {
    // If sheet exists but is empty, add headers
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#e2e8f0");
      sheet.setFrozenRows(1);
    }
  }

  var userId = data.id || data.userId || "";
  var name = data.name || "";
  var email = (data.email || "").toLowerCase().trim();
  var role = (data.role || "user").toUpperCase();
  var plan = data.plan || "Free Trial (15 msgs/day)";
  var sentToday = (data.messages_sent_today !== undefined) ? data.messages_sent_today : 0;
  var sentTotal = (data.messages_sent_total !== undefined) ? data.messages_sent_total : 0;
  var targetContact = data.targetContact || data.notificationTargetNumber || "Not Set";
  var waState = data.waState || data.status || "Offline";
  var authProvider = data.authProvider || "Email";
  var createdAt = data.created_at ? formatReadableDate(data.created_at) : formatReadableDate(new Date());
  var lastActive = formatReadableDate(new Date());

  var rowData = [
    userId,
    name,
    email,
    role,
    plan,
    sentToday,
    sentTotal,
    targetContact,
    waState,
    authProvider,
    createdAt,
    lastActive
  ];

  var lastRow = sheet.getLastRow();
  var existingRowIndex = -1;

  if (lastRow > 1) {
    // Column 1 is User ID, Column 3 is Email Address
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    var emails = sheet.getRange(2, 3, lastRow - 1, 1).getValues();

    for (var i = 0; i < emails.length; i++) {
      var sheetEmail = (emails[i][0] || "").toString().toLowerCase().trim();
      var sheetId = (ids[i][0] || "").toString().trim();

      if ((email && sheetEmail === email) || (userId && sheetId === userId.toString())) {
        existingRowIndex = i + 2; // 1-indexed including header
        break;
      }
    }
  }

  if (existingRowIndex > 0) {
    // Preserve existing Created Date if available
    var currentCreatedAt = sheet.getRange(existingRowIndex, 11).getValue();
    if (currentCreatedAt) {
      rowData[10] = currentCreatedAt;
    }
    sheet.getRange(existingRowIndex, 1, 1, rowData.length).setValues([rowData]);
    return jsonResponse({ success: true, updated: true, row: existingRowIndex, message: "User updated in Google Sheet." });
  } else {
    sheet.appendRow(rowData);
    return jsonResponse({ success: true, created: true, row: sheet.getLastRow(), message: "New user added to Google Sheet." });
  }
}

function formatReadableDate(d) {
  try {
    var dateObj = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dateObj.getTime())) return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    return dateObj.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST";
  } catch (e) {
    return new Date().toISOString();
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
