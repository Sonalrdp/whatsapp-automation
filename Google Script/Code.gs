/**
 * ==============================================================================
 * CORTEX WA AUTOBOT + GOOGLE SHEETS - MULTI-IMAGE SENDER
 * ==============================================================================
 * - Converts specific Google Sheet ranges or charts to PNG using ConvertAPI
 * - Sends multiple formatted screenshot images via your Cortex WA AutoBot REST API
 * - Authenticated with 50-character Access Token
 * - Includes manual test and daily automatic scheduled trigger
 * ==============================================================================
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("🚀 Cortex WA AutoBot")
    .addItem("⚙️ Initialize Setup", "initializeSpreadsheet")
    .addSeparator()
    .addItem("⏰ Add Daily Trigger at 7 PM", "setupDailyTrigger")
    .addSeparator()
    .addItem("⚡ Send Now (Manual Test)", "sendMultipleImages")
    .addToUi();
}

// ==========================================
// 1. INITIALIZATION
// ==========================================

function initializeSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let setup = ss.getSheetByName("SETUP");
  if (!setup) {
    setup = ss.insertSheet("SETUP");
  }
  setup.clear();
  
  // Setup Global Config
  setup.getRange("A1:B1").setValues([["⚙️ GLOBAL CONFIG", ""]]).setBackground("#10b981").setFontColor("white").setFontWeight("bold");
  setup.getRange("A2:B4").setValues([
    ["Cortex WA API Endpoint", "https://live-mt-server.ready-doodles-study.loca.lt/100000000001"],
    ["Cortex WA Access Token", "aK8mN2vP9qL4wX1yT7bN5mC3jH6fG0dE8sA1xK9qW2vL5tY7pB"],
    ["ConvertAPI Secret", "kL9mN2vP4qW1xT7bN5mC3jH6fG0dE8"]
  ]);
  
  // Setup Task List Config (Row-wise)
  setup.getRange("A6:E6").setValues([["📋 TASK LIST (MULTITASKING)", "", "", "", ""]]).setBackground("#059669").setFontColor("white").setFontWeight("bold");
  setup.getRange("A7:E7").setValues([
    ["Target Sheet Name", "Target Range (e.g. A1:F5 / CHART1)", "Target Phone Number", "Msg Caption", "Log Status"]
  ]).setBackground("#f3f3f3").setFontWeight("bold");
  
  setup.getRange("A8:E8").setValues([
    ["Sheet2", "A1:G10", "919876543211", "Here is your automated report", ""]
  ]);
  
  setup.setColumnWidth(1, 200);
  setup.setColumnWidth(2, 250);
  setup.setColumnWidth(3, 200);
  setup.setColumnWidth(4, 250);
  setup.setColumnWidth(5, 150);
  
  // Conditional formatting for Log column (Pass = Green, Failed = Red)
  const logRange = setup.getRange("E8:E1000");
  const rulePass = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo("Pass")
    .setBackground("#b7e1cd") // light green
    .setRanges([logRange])
    .build();
    
  const ruleFailed = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo("Failed")
    .setBackground("#f4c7c3") // light red
    .setRanges([logRange])
    .build();
    
  setup.setConditionalFormatRules([rulePass, ruleFailed]);
  
  // Initialize LOG Sheet
  let logSheet = ss.getSheetByName("LOG");
  if (!logSheet) {
    logSheet = ss.insertSheet("LOG");
  }
  logSheet.clear();
  logSheet.getRange("A1:F1").setValues([["Timestamp", "Target Sheet", "Target Range", "Phone Number", "Status", "Details"]])
    .setBackground("#f3f3f3").setFontWeight("bold");
  logSheet.setColumnWidth(1, 150);
  logSheet.setColumnWidth(6, 400);
  
  Browser.msgBox("✅ Cortex WA AutoBot Setup Sheet Initialized!\n\nYour API Endpoint and 50-character Access Token have been configured in rows B2 and B3.\n\nList your tasks starting from row 8.");
}

// ==========================================
// 2. TRIGGER MANAGEMENT
// ==========================================

function setupDailyTrigger() {
  ScriptApp.newTrigger('sendMultipleImages')
    .timeBased()
    .everyDays(1)
    .atHour(19) // 7:00 PM
    .nearMinute(0)
    .create();
    
  Browser.msgBox("✅ Daily Trigger scheduled for 7:00 PM successfully!");
}

// ==========================================
// 3. CORE SENDING LOGIC (MULTITASKING)
// ==========================================

function sendMultipleImages() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const setupSheet = ss.getSheetByName("SETUP");
  
  if (!setupSheet) {
    console.log("Error: SETUP sheet missing.");
    return;
  }

  // Read Global Config
  const apiEndpoint = setupSheet.getRange("B2").getValue().toString().trim();
  const accessToken = setupSheet.getRange("B3").getValue().toString().trim();
  const convertApiSecret = setupSheet.getRange("B4").getValue().toString().trim();

  if (!apiEndpoint || !accessToken || !convertApiSecret || convertApiSecret.includes("Your_ConvertAPI")) {
    console.log("Error: Missing API configuration in SETUP sheet (API Endpoint, Access Token, or ConvertAPI Secret).");
    return;
  }

  // Read Task List (Starts from Row 8)
  const lastRow = setupSheet.getLastRow();
  if (lastRow < 8) {
    console.log("No tasks found in SETUP sheet.");
    return;
  }
  
  const tasks = setupSheet.getRange(8, 1, lastRow - 7, 4).getValues();
  
  // Setup Log Sheet
  let logSheet = ss.getSheetByName("LOG");
  if (!logSheet) {
    logSheet = ss.insertSheet("LOG");
    logSheet.getRange("A1:F1").setValues([["Timestamp", "Target Sheet", "Target Range", "Phone Number", "Status", "Details"]])
      .setBackground("#f3f3f3").setFontWeight("bold");
  }

  // Loop through all tasks (Multitasking)
  for (let i = 0; i < tasks.length; i++) {
    const targetSheetName = tasks[i][0].toString().trim();
    const targetRangeRaw = tasks[i][1].toString().trim();
    const phoneNumber = tasks[i][2].toString().replace(/[^\d]/g, '');
    const messageText = tasks[i][3] ? tasks[i][3].toString().trim() : "";
    
    if (!targetSheetName || !targetRangeRaw || !phoneNumber) {
      continue; // Skip empty rows
    }
    
    // Split by slash or comma to handle multiple targets per row (e.g. "A21:I42 / CHART1")
    const targets = targetRangeRaw.split(/\s*[\/,]\s*/).filter(t => t.length > 0);
    
    setupSheet.getRange(i + 8, 5).setValue("Processing...");
    SpreadsheetApp.flush(); // Update UI
    
    let overallStatus = "Pass";
    
    for (let target of targets) {
      console.log(`Processing Task ${i+1}: ${targetSheetName}!${target} to ${phoneNumber}`);
      
      const result = processAndSendImageTask(ss, apiEndpoint, accessToken, convertApiSecret, targetSheetName, target, phoneNumber, messageText);
      
      if (result.status !== "Pass") {
        overallStatus = "Failed";
      }
      
      logSheet.appendRow([new Date(), targetSheetName, target, phoneNumber, result.status, result.message]);
    }
    
    setupSheet.getRange(i + 8, 5).setValue(overallStatus);
  }
}

// ==========================================
// 4. IMAGE CONVERSION & CORTEX BOT UPLOAD
// ==========================================

function isUrlOrAppSheet(str) {
  if (!str) return false;
  const s = str.toString().trim();
  return /^https?:\/\//i.test(s) || 
         s.startsWith('gettablefileurl?') || 
         s.startsWith('/Template/gettablefileurl') || 
         s.startsWith('Template/gettablefileurl') ||
         s.includes('gettablefileurl?') ||
         s.includes('appsheet.com') ||
         s.includes('drive.google.com');
}

function normalizeFileUrl(str) {
  let s = str.toString().trim();
  if (s.startsWith('gettablefileurl?') || s.startsWith('Template/gettablefileurl?') || s.startsWith('/Template/gettablefileurl?')) {
    s = s.replace(/^\/?(Template\/)?/i, '');
    return `https://www.appsheet.com/Template/${s}`;
  }
  return s;
}

function processAndSendImageTask(ss, apiEndpoint, accessToken, convertApiSecret, sheetName, rangeA1, phoneNumber, messageText) {
  try {
    // -------------------------------------------------------------
    // CASE A: Direct AppSheet URL, Remote PDF/Image, or Webpage URL
    // -------------------------------------------------------------
    const isRangeUrl = isUrlOrAppSheet(rangeA1);
    const isSheetUrl = isUrlOrAppSheet(sheetName);

    if (isRangeUrl || isSheetUrl) {
      const rawUrl = isRangeUrl ? rangeA1 : sheetName;
      const fileUrl = normalizeFileUrl(rawUrl);
      console.log(`Processing URL Conversion Task: ${fileUrl} to ${phoneNumber}`);

      // Resolve ConvertAPI Endpoint URL (Defaults to self-hosted server)
      let cleanEndpoint = (apiEndpoint || "").toString().trim().replace(/\/+$/, '');
      let convertBaseUrl = cleanEndpoint.replace(/\/api\/v1.*$/, '').replace(/\/\d{12}$/, '');
      if (convertBaseUrl.includes("live-mt-server.") && (convertBaseUrl.includes(".loca.lt") || convertBaseUrl.includes(".ngrok"))) {
        convertBaseUrl = convertBaseUrl.replace("://live-mt-server.", "://");
      }

      const isPdf = fileUrl.toLowerCase().includes('.pdf') || fileUrl.includes('%28pdf%29') || fileUrl.includes('(pdf)');
      const isImage = /\.(png|jpe?g|webp|gif|bmp)(\?.*)?$/i.test(fileUrl);

      // Attempt 1: Fetch direct blob from Google Apps Script if accessible
      let downloadedBlob = null;
      try {
        const fetchRes = UrlFetchApp.fetch(fileUrl, {
          muteHttpExceptions: true,
          followRedirects: true,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        if (fetchRes.getResponseCode() === 200) {
          downloadedBlob = fetchRes.getBlob();
        }
      } catch (dlErr) {
        console.log("Direct download in Apps Script failed, delegating to self-hosted ConvertAPI:", dlErr.toString());
      }

      let convertApiUrl;
      let convertPayload;

      if (isPdf || (downloadedBlob && downloadedBlob.getContentType() === 'application/pdf')) {
        convertApiUrl = `${convertBaseUrl}/convert/pdf/to/png?Secret=${convertApiSecret}`;
        if (downloadedBlob) {
          const pdfBase64 = Utilities.base64Encode(downloadedBlob.getBytes());
          convertPayload = {
            "Parameters": [
              { "Name": "File", "FileValue": { "Name": "document.pdf", "Data": pdfBase64 } },
              { "Name": "CropMode", "Value": "auto" },
              { "Name": "ImageResolution", "Value": "300" }
            ]
          };
        } else {
          convertPayload = {
            "Parameters": [
              { "Name": "File", "FileValue": { "Name": "document.pdf", "Url": fileUrl } },
              { "Name": "CropMode", "Value": "auto" },
              { "Name": "ImageResolution", "Value": "300" }
            ]
          };
        }
      } else if (isImage || (downloadedBlob && downloadedBlob.getContentType().startsWith('image/'))) {
        convertApiUrl = `${convertBaseUrl}/convert/image/to/crop?Secret=${convertApiSecret}`;
        if (downloadedBlob) {
          const imgBase64 = Utilities.base64Encode(downloadedBlob.getBytes());
          convertPayload = {
            "Parameters": [
              { "Name": "File", "FileValue": { "Name": "image.png", "Data": imgBase64 } }
            ]
          };
        } else {
          convertPayload = {
            "Parameters": [
              { "Name": "File", "FileValue": { "Name": "image.png", "Url": fileUrl } }
            ]
          };
        }
      } else {
        // Webpage URL Screenshot
        convertApiUrl = `${convertBaseUrl}/convert/url/to/png?Secret=${convertApiSecret}`;
        convertPayload = {
          "Parameters": [
            { "Name": "Url", "Value": fileUrl },
            { "Name": "FullPage", "Value": true }
          ]
        };
      }

      const convertOptions = {
        "method": "post",
        "contentType": "application/json",
        "headers": {
          "Authorization": "Bearer " + convertApiSecret,
          "Secret": convertApiSecret,
          "Bypass-Tunnel-Reminder": "true",
          "bypass-tunnel-reminder": "true",
          "User-Agent": "CortexWA-GoogleAppsScript/1.0"
        },
        "payload": JSON.stringify(convertPayload),
        "muteHttpExceptions": true
      };

      const convertResponse = UrlFetchApp.fetch(convertApiUrl, convertOptions);
      let convertResult = {};
      try {
        convertResult = JSON.parse(convertResponse.getContentText());
      } catch (parseErr) {
        return { status: "Failed", message: "ConvertAPI Parse Error: " + convertResponse.getContentText() };
      }

      if (convertResult.Code && convertResult.Code !== 200) {
        const msg = `ConvertAPI Error (${convertResult.Code}): ${convertResult.Message || convertResult.Error}`;
        console.log(msg);
        return { status: "Failed", message: msg };
      }

      if (!convertResult.Files || convertResult.Files.length === 0) {
        const msg = "ConvertAPI Error: No image returned from conversion engine for URL.";
        console.log(msg);
        return { status: "Failed", message: msg };
      }

      const pngBase64 = convertResult.Files[0].FileData;
      const pngBlob = Utilities.newBlob(Utilities.base64Decode(pngBase64), 'image/png', 'converted_media.png');

      return uploadToCortexBot(pngBlob, phoneNumber, messageText, apiEndpoint, accessToken);
    }

    // -------------------------------------------------------------
    // CASE B: Target Sheet + Cell Range or Chart
    // -------------------------------------------------------------
    const targetSheet = ss.getSheetByName(sheetName);
    if (!targetSheet) {
      const msg = `Error: Target sheet '${sheetName}' not found.`;
      console.log(msg);
      return { status: "Failed", message: msg };
    }
    
    // Check if user wants to send a CHART instead of a cell range
    if (rangeA1.toString().toUpperCase().startsWith("CHART")) {
      const chartIndex = parseInt(rangeA1.toString().toUpperCase().replace("CHART", "")) - 1;
      const charts = targetSheet.getCharts();
      
      if (charts.length === 0 || chartIndex < 0 || chartIndex >= charts.length) {
        const msg = `Error: Chart ${chartIndex + 1} not found on sheet '${sheetName}'.`;
        console.log(msg);
        return { status: "Failed", message: msg };
      }
      
      const chart = charts[chartIndex];
      const pngBlob = chart.getAs('image/png');
      
      return uploadToCortexBot(pngBlob, phoneNumber, messageText, apiEndpoint, accessToken);
    }
    
    const ssId = ss.getId();
    const sheetId = targetSheet.getSheetId();
    
    // 1. Export Specific Range as PDF (Maintains exact table styling)
    const pdfUrl = `https://docs.google.com/spreadsheets/d/${ssId}/export?exportFormat=pdf&format=pdf&size=A4&portrait=true&fitw=true&gridlines=false&gid=${sheetId}&range=${rangeA1}`;
    
    const pdfParams = { 
      method: "GET", 
      headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    };
    
    const pdfResponse = UrlFetchApp.fetch(pdfUrl, pdfParams);
    if (pdfResponse.getResponseCode() !== 200) {
        const msg = `Error generating PDF for ${sheetName}: ${pdfResponse.getContentText()}`;
        console.log(msg);
        return { status: "Failed", message: msg };
    }
    
    const pdfBlob = pdfResponse.getBlob();
    const pdfBase64 = Utilities.base64Encode(pdfBlob.getBytes());
    
    // 2. Resolve ConvertAPI Endpoint URL (Defaults to self-hosted server)
    let cleanEndpoint = (apiEndpoint || "").toString().trim().replace(/\/+$/, '');
    let convertBaseUrl = cleanEndpoint.replace(/\/api\/v1.*$/, '').replace(/\/\d{12}$/, '');
    if (convertBaseUrl.includes("live-mt-server.") && (convertBaseUrl.includes(".loca.lt") || convertBaseUrl.includes(".ngrok"))) {
      convertBaseUrl = convertBaseUrl.replace("://live-mt-server.", "://");
    }

    // 3. Convert & Auto-Crop PDF to High-Res PNG using self-hosted ConvertAPI engine
    const convertApiUrl = `${convertBaseUrl}/convert/pdf/to/png?Secret=${convertApiSecret}`;
    const convertPayload = {
      "Parameters": [
        {
          "Name": "File",
          "FileValue": {
            "Name": `${sheetName}.pdf`,
            "Data": pdfBase64
          }
        },
        {
          "Name": "CropMode",
          "Value": "auto"
        },
        {
          "Name": "ImageResolution",
          "Value": "300"
        }
      ]
    };

    const convertOptions = {
      "method": "post",
      "contentType": "application/json",
      "headers": {
        "Authorization": "Bearer " + convertApiSecret,
        "Secret": convertApiSecret,
        "Bypass-Tunnel-Reminder": "true",
        "bypass-tunnel-reminder": "true",
        "User-Agent": "CortexWA-GoogleAppsScript/1.0"
      },
      "payload": JSON.stringify(convertPayload),
      "muteHttpExceptions": true
    };

    const convertResponse = UrlFetchApp.fetch(convertApiUrl, convertOptions);
    let convertResult = {};
    try {
      convertResult = JSON.parse(convertResponse.getContentText());
    } catch (parseErr) {
      return { status: "Failed", message: "ConvertAPI Parse Error: " + convertResponse.getContentText() };
    }

    if (convertResult.Code && convertResult.Code !== 200) {
      const msg = `ConvertAPI Error (${convertResult.Code}): ${convertResult.Message || convertResult.Error}`;
      console.log(msg);
      return { status: "Failed", message: msg };
    }

    if (!convertResult.Files || convertResult.Files.length === 0) {
      const msg = "ConvertAPI Error: No image returned from conversion engine.";
      console.log(msg);
      return { status: "Failed", message: msg };
    }

    // 4. Decode PNG and send via Cortex WA AutoBot REST API
    const pngBase64 = convertResult.Files[0].FileData;
    const pngBlob = Utilities.newBlob(Utilities.base64Decode(pngBase64), 'image/png', `${sheetName}.png`);

    return uploadToCortexBot(pngBlob, phoneNumber, messageText, apiEndpoint, accessToken);

  } catch (e) {
    const msg = `Script Error for task ${sheetName}: ` + e.toString();
    console.log(msg);
    return { status: "Failed", message: msg };
  }
}

// ==========================================
// 5. CORTEX WA AUTOBOT DISPATCH FUNCTION
// ==========================================

function uploadToCortexBot(pngBlob, phoneNumber, messageText, apiEndpoint, accessToken) {
  let cleanEndpoint = (apiEndpoint || "").toString().trim().replace(/\/+$/, '');
  
  if (!cleanEndpoint) {
    return { status: "Failed", message: "API Endpoint is empty. Please enter your API Endpoint in the SETUP sheet." };
  }

  // Check if endpoint is using localhost / local domain (which Google Cloud cannot resolve)
  if (cleanEndpoint.includes("localhost") || cleanEndpoint.includes("127.0.0.1")) {
    const msg = "Configuration Error: Google Apps Script runs in Google's Cloud and cannot reach 'localhost'. Please use a public URL (e.g. ngrok: https://xxxx.ngrok-free.app/100000000001 or your live website domain).";
    console.error(msg);
    return { status: "Failed", message: msg };
  }

  // Build send URL (supports both standard endpoint and https://live-mt-server.<domain>/<uid>)
  let sendUrl;
  if (cleanEndpoint.includes('/api/v1/')) {
    sendUrl = cleanEndpoint;
  } else if (/\/\d{12}$/.test(cleanEndpoint)) {
    sendUrl = `${cleanEndpoint}/api/v1/send-message`;
  } else {
    sendUrl = `${cleanEndpoint}/api/v1/send-message`;
  }

  // If endpoint uses live-mt-server prefix on localtunnel (loca.lt) or ngrok,
  // adapt the request host so single-level SSL wildcards (*.loca.lt) resolve and connect flawlessly
  if (sendUrl.includes("live-mt-server.") && (sendUrl.includes(".loca.lt") || sendUrl.includes(".ngrok"))) {
    sendUrl = sendUrl.replace("://live-mt-server.", "://");
  }

  const pngBase64 = Utilities.base64Encode(pngBlob.getBytes());

  const payload = {
    "to": phoneNumber,
    "phone": phoneNumber,
    "image": pngBase64,
    "imageBase64": pngBase64,
    "caption": messageText || "",
    "message": messageText || "",
    "fileName": "report.png"
  };

  const options = {
    "method": "post",
    "contentType": "application/json",
    "headers": { 
      "Authorization": "Bearer " + accessToken,
      "access-token": accessToken,
      "Bypass-Tunnel-Reminder": "true",
      "bypass-tunnel-reminder": "true",
      "User-Agent": "CortexWA-GoogleAppsScript/1.0"
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(sendUrl, options);
    const responseCode = response.getResponseCode();
    
    let result = {};
    try {
      result = JSON.parse(response.getContentText());
    } catch (err) {
      result = { message: response.getContentText() };
    }

    if (responseCode === 200 && (result.result === true || result.success === true)) {
      const msg = `Successfully sent image to ${phoneNumber}`;
      console.log(msg);
      return { status: "Pass", message: msg };
    } else {
      const errorDetail = result.message || result.error || response.getContentText();
      const msg = `Cortex WA API Error (${responseCode}) for ${phoneNumber}: ` + errorDetail;
      console.log(msg);
      return { status: "Failed", message: msg };
    }
  } catch (fetchErr) {
    const errMsg = fetchErr.toString();
    if (errMsg.includes("DNS error")) {
      return { status: "Failed", message: `DNS Error: Google Cloud cannot reach '${sendUrl}'. Verify that your domain or ngrok tunnel URL is live and publicly accessible.` };
    }
    return { status: "Failed", message: `Fetch Error: ` + errMsg };
  }
}