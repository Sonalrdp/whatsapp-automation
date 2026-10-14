/**
 * ==============================================================================
 * CORTEX WA AUTOBOT + GOOGLE SHEETS - MULTI-IMAGE SENDER (RETRY TILL PASS)
 * ==============================================================================
 * - Converts specific Google Sheet ranges or charts to PNG using ConvertAPI
 * - Sends multiple formatted screenshot images via your Cortex WA AutoBot REST API
 * - Authenticated with 50-character Access Token
 * - Continuous "Try Till Pass" retry loop with automatic trigger continuation:
 *   never gives up or times out; chains background executions until every task passes.
 * - Skips already passed tasks to prevent duplicate WhatsApp messages.
 * - Caches converted images during retries so ConvertAPI is not called redundantly.
 * - Includes manual test, trigger management, and daily scheduled run at 7 PM.
 * ==============================================================================
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("🚀 Cortex WA AutoBot")
    .addItem("⚙️ Initialize Setup", "initializeSpreadsheet")
    .addSeparator()
    .addItem("⏰ Add Daily Trigger at 7 PM", "setupDailyTrigger")
    .addSeparator()
    .addItem("⚡ Send Now (Manual Test)", "sendNowManualTest")
    .addItem("🔄 Reset All Statuses", "resetAllTaskStatuses")
    .addItem("⏹️ Stop Retrying & Cancel Triggers", "stopRetryingAndCancelTriggers")
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
  setup.getRange("A2:B5").setValues([
    ["Cortex WA API Endpoint", "https://live-mt-server.ready-doodles-study.loca.lt/100000000001"],
    ["Cortex WA Access Token", "aK8mN2vP9qL4wX1yT7bN5mC3jH6fG0dE8sA1xK9qW2vL5tY7pB"],
    ["ConvertAPI Secret", "kL9mN2vP4qW1xT7bN5mC3jH6fG0dE8"],
    ["ConvertAPI Min Gap (Seconds)", "10"]
  ]);
  
  // Setup Task List Config (Row-wise)
  setup.getRange("A6:F6").setValues([["📋 TASK LIST (MULTITASKING)", "", "", "", "", ""]]).setBackground("#059669").setFontColor("white").setFontWeight("bold");
  setup.getRange("A7:F7").setValues([
    ["Target Sheet Name", "Target Range (e.g. A1:F5 / CHART1)", "Target Phone Number", "Msg Caption", "Log Status", "Timestamp"]
  ]).setBackground("#f3f3f3").setFontWeight("bold");
  
  setup.getRange("A8:F8").setValues([
    ["Sheet2", "A1:G10", "919876543211", "Here is your automated report", "", ""]
  ]);
  
  setup.setColumnWidth(1, 200);
  setup.setColumnWidth(2, 250);
  setup.setColumnWidth(3, 200);
  setup.setColumnWidth(4, 250);
  setup.setColumnWidth(5, 160);
  setup.setColumnWidth(6, 180);
  
  // Conditional formatting for Log column
  const logRange = setup.getRange("E8:E1000");
  const rulePass = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo("Pass")
    .setBackground("#b7e1cd") // light green
    .setRanges([logRange])
    .build();
    
  const ruleFailed = SpreadsheetApp.newConditionalFormatRule()
    .whenTextStartsWith("Failed")
    .setBackground("#f4c7c3") // light red
    .setRanges([logRange])
    .build();
    
  const ruleRetrying = SpreadsheetApp.newConditionalFormatRule()
    .whenTextStartsWith("Retrying")
    .setBackground("#fce8b2") // light yellow/amber
    .setRanges([logRange])
    .build();

  const ruleProcessing = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo("Processing...")
    .setBackground("#d2e3fc") // light blue
    .setRanges([logRange])
    .build();

  const ruleStopped = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo("Stopped")
    .setBackground("#e0e0e0") // light gray
    .setRanges([logRange])
    .build();
    
  setup.setConditionalFormatRules([rulePass, ruleFailed, ruleRetrying, ruleProcessing, ruleStopped]);
  
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
  
  Browser.msgBox("✅ Cortex WA AutoBot Setup Sheet Initialized!\n\nYour API Endpoint and Access Token have been configured in rows B2-B5.\n\nList your tasks starting from row 8.");
}

// ==========================================
// 2. TRIGGER & AUTO-CONTINUATION MANAGEMENT
// ==========================================

function setupDailyTrigger() {
  // Remove existing daily triggers to prevent duplicates
  const triggers = ScriptApp.getProjectTriggers();
  for (let trigger of triggers) {
    if (trigger.getHandlerFunction() === 'dailyScheduledRun' || trigger.getHandlerFunction() === 'sendMultipleImages') {
      try {
        ScriptApp.deleteTrigger(trigger);
      } catch (e) {}
    }
  }

  ScriptApp.newTrigger('dailyScheduledRun')
    .timeBased()
    .everyDays(1)
    .atHour(19) // 7:00 PM
    .nearMinute(0)
    .create();
    
  Browser.msgBox("✅ Daily Trigger scheduled for 7:00 PM successfully!");
}

/**
 * Handler for the daily 7 PM trigger.
 * Clears previous statuses and runs all tasks until pass.
 */
function dailyScheduledRun() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const setupSheet = ss.getSheetByName("SETUP");
  if (setupSheet) {
    const lastRow = setupSheet.getLastRow();
    if (lastRow >= 8) {
      setupSheet.getRange(8, 5, lastRow - 7, 2).clearContent();
    }
  }
  cleanupContinuationTriggers();
  sendMultipleImages();
}

/**
 * Auto-resume continuation handler called by time-based trigger
 * when previous execution approached Google Apps Script's 6-minute timeout limit.
 */
function continueRetryingUntilPass() {
  console.log("Auto-resume continuation trigger fired. Resuming retries until all tasks pass...");
  cleanupContinuationTriggers();
  sendMultipleImages();
}

/**
 * Schedules a continuation trigger to resume execution in 20 seconds.
 */
function scheduleContinuationTrigger() {
  cleanupContinuationTriggers();
  ScriptApp.newTrigger('continueRetryingUntilPass')
    .timeBased()
    .after(20000) // 20 seconds
    .create();
  console.log("Continuation trigger scheduled to resume execution shortly.");
}

/**
 * Deletes all temporary continuation triggers (does not affect daily schedule).
 */
function cleanupContinuationTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let trigger of triggers) {
    if (trigger.getHandlerFunction() === 'continueRetryingUntilPass') {
      try {
        ScriptApp.deleteTrigger(trigger);
      } catch (e) {
        console.log("Error cleaning trigger:", e);
      }
    }
  }
}

/**
 * User action to stop retrying and remove background continuation triggers.
 */
function stopRetryingAndCancelTriggers() {
  cleanupContinuationTriggers();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const setupSheet = ss.getSheetByName("SETUP");
  if (setupSheet) {
    const lastRow = setupSheet.getLastRow();
    if (lastRow >= 8) {
      const statuses = setupSheet.getRange(8, 5, lastRow - 7, 1).getValues();
      for (let i = 0; i < statuses.length; i++) {
        const val = statuses[i][0].toString().trim();
        if (val.startsWith("Retrying") || val === "Processing...") {
          setupSheet.getRange(i + 8, 5).setValue("Stopped");
        }
      }
    }
  }
  Browser.msgBox("🛑 Retries stopped and continuation triggers cancelled.");
}

/**
 * Reset all statuses and timestamps back to empty for fresh execution.
 */
function resetAllTaskStatuses() {
  cleanupContinuationTriggers();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const setupSheet = ss.getSheetByName("SETUP");
  if (setupSheet) {
    const lastRow = setupSheet.getLastRow();
    if (lastRow >= 8) {
      setupSheet.getRange(8, 5, lastRow - 7, 2).clearContent();
    }
  }
  Browser.msgBox("🔄 All task statuses and timestamps reset to blank.");
}

/**
 * Manual test menu action.
 * If all tasks are already 'Pass', resets them so a fresh test can run.
 */
function sendNowManualTest() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const setupSheet = ss.getSheetByName("SETUP");
  if (setupSheet) {
    const lastRow = setupSheet.getLastRow();
    if (lastRow >= 8) {
      const statuses = setupSheet.getRange(8, 5, lastRow - 7, 1).getValues();
      const allPassed = statuses.every(r => r[0].toString().trim() === "Pass" || r[0].toString().trim() === "");
      if (allPassed) {
        setupSheet.getRange(8, 5, lastRow - 7, 2).clearContent();
      }
    }
  }
  cleanupContinuationTriggers();
  sendMultipleImages();
}

// ==========================================
// 3. CORE SENDING LOGIC (TRY TILL PASS)
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
  const rawGap = setupSheet.getRange("B5").getValue();
  const customGapSec = parseInt(rawGap, 10);
  const minGapMs = (!isNaN(customGapSec) && customGapSec >= 0) ? customGapSec * 1000 : 10000;

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
  
  // Read Columns A to E (Sheet, Range, Phone, Caption, Status)
  const tasks = setupSheet.getRange(8, 1, lastRow - 7, 5).getValues();
  
  // Ensure Column F header ("Timestamp") is configured
  const colFHeader = setupSheet.getRange(7, 6).getValue().toString().trim();
  if (!colFHeader) {
    setupSheet.getRange(6, 6).setValue("").setBackground("#059669");
    setupSheet.getRange(7, 6).setValue("Timestamp").setBackground("#f3f3f3").setFontWeight("bold");
    setupSheet.setColumnWidth(6, 180);
  }

  // Setup Log Sheet
  let logSheet = ss.getSheetByName("LOG");
  if (!logSheet) {
    logSheet = ss.insertSheet("LOG");
    logSheet.getRange("A1:F1").setValues([["Timestamp", "Target Sheet", "Target Range", "Phone Number", "Status", "Details"]])
      .setBackground("#f3f3f3").setFontWeight("bold");
  }

  const executionStartTime = Date.now();
  // Safe margin: 4.5 minutes (270,000 ms) before Google Apps Script 6-minute hard termination
  const MAX_EXECUTION_TIME_MS = 270000;
  let continuationNeeded = false;

  // Loop through all tasks (Multitasking)
  for (let i = 0; i < tasks.length; i++) {
    const targetSheetName = tasks[i][0].toString().trim();
    const targetRangeRaw = tasks[i][1].toString().trim();
    const phoneNumber = tasks[i][2].toString().replace(/[^\d]/g, '');
    const messageText = tasks[i][3] ? tasks[i][3].toString().trim() : "";
    const currentStatus = (tasks[i][4] || "").toString().trim();
    
    if (!targetSheetName || !targetRangeRaw || !phoneNumber) {
      continue; // Skip empty rows
    }

    // Skip already passed tasks to avoid re-sending duplicate messages
    if (currentStatus === "Pass") {
      console.log(`Task ${i + 1} (${targetSheetName}!${targetRangeRaw}) already passed. Skipping.`);
      continue;
    }

    // Split by slash or comma to handle multiple targets per row (e.g. "A21:I42 / CHART1")
    const targets = targetRangeRaw.split(/\s*[\/,]\s*/).filter(t => t.length > 0);
    
    // Read previous retry count if this task was already retrying
    let retryCount = 0;
    const match = currentStatus.match(/(\d+)/);
    if (match) {
      retryCount = parseInt(match[1], 10) || 0;
    }

    let allTargetsPassed = true;

    for (let target of targets) {
      console.log(`Processing Task ${i + 1}: ${targetSheetName}!${target} to ${phoneNumber}`);
      
      let pass = false;
      let cachedBlob = null; // Caches converted image if ConvertAPI succeeded but WA upload failed
      let lastErrorMessage = "";

      // CONTINUOUS RETRY LOOP: TRY TILL PASS
      while (!pass) {
        // Approaching Google Apps Script execution timeout: yield and auto-resume in background
        if (Date.now() - executionStartTime > MAX_EXECUTION_TIME_MS) {
          console.log(`Approaching execution limit (4.5 mins). Scheduling auto-resume trigger for Task ${i + 1}...`);
          setupSheet.getRange(i + 8, 5).setValue(`Retrying (${retryCount > 0 ? retryCount : 1})...`);
          SpreadsheetApp.flush();
          continuationNeeded = true;
          allTargetsPassed = false;
          break;
        }

        setupSheet.getRange(i + 8, 5).setValue(retryCount === 0 ? "Processing..." : `Retrying (${retryCount})...`);
        SpreadsheetApp.flush();

        let result;
        try {
          result = processAndSendImageTask(ss, apiEndpoint, accessToken, convertApiSecret, targetSheetName, target, phoneNumber, messageText, cachedBlob, minGapMs);
          if (result && result.cachedBlob) {
            cachedBlob = result.cachedBlob;
          }
        } catch (err) {
          result = { status: "Failed", message: "Execution error: " + err.toString(), cachedBlob: cachedBlob };
        }

        if (result && result.status === "Pass") {
          console.log(`Task ${i + 1} (${target}) passed!`);
          pass = true;
          logSheet.appendRow([new Date(), targetSheetName, target, phoneNumber, "Pass", result.message || "Successfully sent"]);
          break;
        }

        // Attempt failed -> increment retry count and log
        retryCount++;
        lastErrorMessage = (result && result.message) ? result.message : "Unknown error";
        console.log(`Task ${i + 1} (${target}) failed (${lastErrorMessage}). Retrying (Attempt #${retryCount})...`);
        setupSheet.getRange(i + 8, 5).setValue(`Retrying (${retryCount})...`);
        SpreadsheetApp.flush();

        logSheet.appendRow([new Date(), targetSheetName, target, phoneNumber, `Retry ${retryCount}`, lastErrorMessage]);

        // Check timeout before sleeping
        if (Date.now() - executionStartTime > MAX_EXECUTION_TIME_MS) {
          console.log(`Approaching execution limit after attempt #${retryCount}. Scheduling auto-resume trigger...`);
          continuationNeeded = true;
          allTargetsPassed = false;
          break;
        }

        Utilities.sleep(3000); // 3 seconds between retries
      }

      if (continuationNeeded) {
        break; // Exit targets loop to yield and trigger continuation
      }
    }

    if (continuationNeeded) {
      break; // Exit tasks loop to yield and trigger continuation
    }

    if (allTargetsPassed) {
      const timeZone = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone();
      const doneTimestamp = Utilities.formatDate(new Date(), timeZone, "yyyy-MM-dd HH:mm:ss");
      setupSheet.getRange(i + 8, 5).setValue("Pass");
      setupSheet.getRange(i + 8, 6).setValue(doneTimestamp);
      SpreadsheetApp.flush();
    }
  }

  // Handle Continuation Trigger or Complete Cleanup
  if (continuationNeeded) {
    console.log("Scheduling continuation trigger so script keeps trying until pass...");
    scheduleContinuationTrigger();
  } else {
    // Check if any tasks remain unpassed
    const updatedStatuses = setupSheet.getRange(8, 5, lastRow - 7, 1).getValues();
    const anyPending = updatedStatuses.some(r => {
      const val = r[0].toString().trim();
      return val !== "Pass" && val !== "";
    });

    if (!anyPending) {
      console.log("All tasks passed successfully! Cleaning up continuation triggers.");
      cleanupContinuationTriggers();
    } else {
      console.log("Some tasks still pending. Resuming continuation trigger...");
      scheduleContinuationTrigger();
    }
  }
}

// ==========================================
// 4. IMAGE CONVERSION & QUEUE RATE LIMITER
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

/**
 * Global queue & rate limiter for ConvertAPI requests.
 * Enforces configurable delay between conversions across background executions.
 * Protects against stale ScriptProperties timestamps.
 */
function fetchConvertApiWithRateLimit(url, options, minGapMs) {
  const MIN_GAP_MS = (typeof minGapMs === 'number' && minGapMs >= 0) ? minGapMs : 10000;
  const lock = LockService.getScriptLock();
  const props = PropertiesService.getScriptProperties();

  let myStartTime = 0;

  try {
    lock.waitLock(30000);
    const now = Date.now();
    const lastFinish = parseInt(props.getProperty('LAST_CONVERT_FINISH_MS') || '0', 10);
    const nextSlot = parseInt(props.getProperty('NEXT_CONVERT_SLOT_MS') || '0', 10);

    let sanitizedNextSlot = nextSlot;
    if (isNaN(sanitizedNextSlot) || sanitizedNextSlot > now + MIN_GAP_MS || sanitizedNextSlot < now) {
      sanitizedNextSlot = now;
    }
    let sanitizedLastFinish = lastFinish;
    if (isNaN(sanitizedLastFinish) || sanitizedLastFinish > now || sanitizedLastFinish < now - 86400000) {
      sanitizedLastFinish = 0;
    }

    myStartTime = Math.max(now, sanitizedLastFinish + MIN_GAP_MS, sanitizedNextSlot);
    props.setProperty('NEXT_CONVERT_SLOT_MS', (myStartTime + MIN_GAP_MS).toString());
  } catch (err) {
    console.log("Queue lock note:", err.toString());
    myStartTime = Date.now();
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }

  let waitMs = myStartTime - Date.now();
  if (waitMs > MIN_GAP_MS) {
    waitMs = MIN_GAP_MS;
  }
  if (waitMs > 0) {
    console.log(`[ConvertAPI Rate Limit] Waiting ${(waitMs / 1000).toFixed(1)} seconds to enforce delay between conversions...`);
    Utilities.sleep(waitMs);
  }

  console.log("[ConvertAPI Rate Limit] Executing ConvertAPI conversion request...");
  const response = UrlFetchApp.fetch(url, options);

  try {
    lock.waitLock(30000);
    const finishTime = Date.now();
    props.setProperty('LAST_CONVERT_FINISH_MS', finishTime.toString());
    
    const currentNextSlot = parseInt(props.getProperty('NEXT_CONVERT_SLOT_MS') || '0', 10);
    const minNextSlot = finishTime + MIN_GAP_MS;
    if (minNextSlot > currentNextSlot) {
      props.setProperty('NEXT_CONVERT_SLOT_MS', minNextSlot.toString());
    }
  } catch (err) {
    console.log("Queue finish lock note:", err.toString());
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }

  return response;
}

/**
 * Handles image generation (URL, Chart, or Sheet Range PDF) and dispatches to Cortex WA Bot.
 * Reuses cachedBlob if conversion succeeded previously, avoiding redundant ConvertAPI calls.
 */
function processAndSendImageTask(ss, apiEndpoint, accessToken, convertApiSecret, sheetName, rangeA1, phoneNumber, messageText, cachedBlob, minGapMs) {
  try {
    // -------------------------------------------------------------
    // OPTIMIZATION: Reuse cached blob if already successfully converted
    // -------------------------------------------------------------
    if (cachedBlob) {
      console.log(`Reusing cached image blob for ${sheetName}!${rangeA1} (skipping ConvertAPI re-conversion)...`);
      const uploadRes = uploadToCortexBot(cachedBlob, phoneNumber, messageText, apiEndpoint, accessToken);
      return {
        status: uploadRes.status,
        message: uploadRes.message,
        cachedBlob: cachedBlob
      };
    }

    let generatedPngBlob = null;

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
      if (convertBaseUrl.includes("live-mt-server.")) {
        convertBaseUrl = convertBaseUrl.replace("://live-mt-server.", "://");
      }

      const isPdf = fileUrl.toLowerCase().includes('.pdf') || fileUrl.includes('%28pdf%29') || fileUrl.includes('(pdf)');
      const isImage = /\.(png|jpe?g|webp|gif|bmp)(\?.*)?$/i.test(fileUrl);

      // Attempt direct download in Google Apps Script if accessible
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
        console.log("Direct download in Apps Script failed, delegating to ConvertAPI:", dlErr.toString());
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

      const convertResponse = fetchConvertApiWithRateLimit(convertApiUrl, convertOptions, minGapMs);
      let convertResult = {};
      try {
        convertResult = JSON.parse(convertResponse.getContentText());
      } catch (parseErr) {
        return { status: "Failed", message: "ConvertAPI Parse Error: " + convertResponse.getContentText(), cachedBlob: null };
      }

      if (convertResult.Code && convertResult.Code !== 200) {
        const msg = `ConvertAPI Error (${convertResult.Code}): ${convertResult.Message || convertResult.Error}`;
        console.log(msg);
        return { status: "Failed", message: msg, cachedBlob: null };
      }

      if (!convertResult.Files || convertResult.Files.length === 0) {
        const msg = "ConvertAPI Error: No image returned from conversion engine for URL.";
        console.log(msg);
        return { status: "Failed", message: msg, cachedBlob: null };
      }

      const pngBase64 = convertResult.Files[0].FileData;
      generatedPngBlob = Utilities.newBlob(Utilities.base64Decode(pngBase64), 'image/png', 'converted_media.png');

    } else {
      // -------------------------------------------------------------
      // CASE B: Target Sheet + Cell Range or Chart
      // -------------------------------------------------------------
      const targetSheet = ss.getSheetByName(sheetName);
      if (!targetSheet) {
        const msg = `Error: Target sheet '${sheetName}' not found.`;
        console.log(msg);
        return { status: "Failed", message: msg, cachedBlob: null };
      }
      
      // Check if user wants to send a CHART instead of a cell range
      if (rangeA1.toString().toUpperCase().startsWith("CHART")) {
        const chartIndex = parseInt(rangeA1.toString().toUpperCase().replace("CHART", "")) - 1;
        const charts = targetSheet.getCharts();
        
        if (charts.length === 0 || chartIndex < 0 || chartIndex >= charts.length) {
          const msg = `Error: Chart ${chartIndex + 1} not found on sheet '${sheetName}'.`;
          console.log(msg);
          return { status: "Failed", message: msg, cachedBlob: null };
        }
        
        const chart = charts[chartIndex];
        generatedPngBlob = chart.getAs('image/png');
      } else {
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
            return { status: "Failed", message: msg, cachedBlob: null };
        }
        
        const pdfBlob = pdfResponse.getBlob();
        const pdfBase64 = Utilities.base64Encode(pdfBlob.getBytes());
        
        // 2. Resolve ConvertAPI Endpoint URL (Defaults to self-hosted server)
        let cleanEndpoint = (apiEndpoint || "").toString().trim().replace(/\/+$/, '');
        let convertBaseUrl = cleanEndpoint.replace(/\/api\/v1.*$/, '').replace(/\/\d{12}$/, '');
        if (convertBaseUrl.includes("live-mt-server.")) {
          convertBaseUrl = convertBaseUrl.replace("://live-mt-server.", "://");
        }

        // 3. Convert & Auto-Crop PDF to High-Res PNG using ConvertAPI engine
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

        const convertResponse = fetchConvertApiWithRateLimit(convertApiUrl, convertOptions, minGapMs);
        let convertResult = {};
        try {
          convertResult = JSON.parse(convertResponse.getContentText());
        } catch (parseErr) {
          return { status: "Failed", message: "ConvertAPI Parse Error: " + convertResponse.getContentText(), cachedBlob: null };
        }

        if (convertResult.Code && convertResult.Code !== 200) {
          const msg = `ConvertAPI Error (${convertResult.Code}): ${convertResult.Message || convertResult.Error}`;
          console.log(msg);
          return { status: "Failed", message: msg, cachedBlob: null };
        }

        if (!convertResult.Files || convertResult.Files.length === 0) {
          const msg = "ConvertAPI Error: No image returned from conversion engine.";
          console.log(msg);
          return { status: "Failed", message: msg, cachedBlob: null };
        }

        const pngBase64 = convertResult.Files[0].FileData;
        generatedPngBlob = Utilities.newBlob(Utilities.base64Decode(pngBase64), 'image/png', `${sheetName}.png`);
      }
    }

    // 4. Dispatch via Cortex WA AutoBot REST API
    const uploadResult = uploadToCortexBot(generatedPngBlob, phoneNumber, messageText, apiEndpoint, accessToken);
    return {
      status: uploadResult.status,
      message: uploadResult.message,
      cachedBlob: generatedPngBlob // Retained so subsequent retries do not re-run ConvertAPI
    };

  } catch (e) {
    const msg = `Script Error for task ${sheetName}: ` + e.toString();
    console.log(msg);
    return { status: "Failed", message: msg, cachedBlob: null };
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
  if (sendUrl.includes("live-mt-server.")) {
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

    const isSuccess = responseCode === 200 && (
      result.result === true || 
      result.success === true || 
      result.status === "success" || 
      result.status === true || 
      result.status === "PASS" || 
      result.status === "Pass" || 
      result.sent === true ||
      (typeof result.result === "string" && result.result.toLowerCase() === "success")
    );

    if (isSuccess) {
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