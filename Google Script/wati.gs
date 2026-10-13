/**
 * ============================================================
 *  WATI WHATSAPP MASTER SCRIPT
 *  Version 5.1 — Simplified (removed unused document template type)
 * ============================================================
 *
 *  SHEET STRUCTURE (auto-created by Setup):
 *  ┌─────────────────┬────────────────────────────────────────┐
 *  │ ⚙️ CONFIG    	│ API credentials + column mappings      │
 *  │ 📋 TEMPLATES 	│ One row per WATI template              │
 *  │ 📊 DATA      	│ Your contacts + trigger + status cols  │
 *  │ 📝 LOG       	│ Append-only audit trail                │
 *  └─────────────────┴────────────────────────────────────────┘
 *
 *  SENDING PDF/DOCUMENT FILES:
 *  No special configuration needed. If a variable value contains a
 *  Google Drive URL, the script automatically converts it to a direct
 *  download URL so WATI can fetch the file correctly.
 *  The original Drive filename is preserved on WhatsApp.
 *
 *  HOW SENDING WORKS:
 *  1. Team member fills DATA sheet (manually, IMPORTRANGE, or Form)
 *  2. Team member writes an ARRAYFORMULA in the "WA Trigger" column
 *     that returns "Yes" when a row should be sent, blank otherwise
 *  3. Time-based trigger runs sendAllPending() every N minutes
 *  4. Script finds rows where WA Trigger = "Yes" AND WA Status = blank
 *  5. Normalises phone → validates → sends via WATI API
 *  6. Writes result to WA Status column + LOG sheet
 *
 *  STATUS VALUES (WA Status column — script-owned, never touch):
 *  blank    	→ not yet processed
 *  Processing   → script is currently sending (race condition guard)
 *  Sent     	→ successfully sent  ✅ green
 *  Error    	→ WATI API rejected (see LOG)  🔴 red
 *  Invalid No.  → phone number could not be normalised  🔴 red
 *  Config Error → template mapping issue (see LOG)  🔴 red
 *  Stopped  	→ WA Stop Date passed; skipped permanently
 *
 *  TO RE-SEND A ROW: clear WA Status cell → picked up on next cycle
 * ============================================================
 */
 
// ============================================================
//  CONSTANTS
// ============================================================
 
const SHEET = {
  CONFIG	: "⚙️ CONFIG",
  TEMPLATES : "📋 TEMPLATES",
  DATA  	: "📊 DATA",
  LOG   	: "📝 LOG"
};
 
// CONFIG sheet — fixed cell addresses
const CFG = {
  ENDPOINT	: "B3",  // WATI API base URL
  TOKEN   	: "B4",  // Bearer token
  INTERVAL	: "B5",  // Trigger interval in minutes (default 5)
  PHONE_COL   : "B8",  // Header name of phone column in DATA sheet
  TRIGGER_COL : "B9",  // Header name of WA Trigger column in DATA sheet
  STATUS_COL  : "B10"  // Header name of WA Status column in DATA sheet
};
 
// TEMPLATES sheet — header names for column lookup (column order doesn't matter)
const TMPL_HEADERS = {
  ID          	: "Template ID",
  WATI_NAME   	: "WATI Template Name",
  VAR_COUNT   	: "Var Count",
  DEFAULT_INTERVAL: "Default Interval (Days)"
  // v1 → Header ... v10 → Header are found dynamically
};
 
// DATA sheet — reserved column header names (script reads/writes these)
const TRIGGER_HEADER   = "WA Trigger";      	// ARRAYFORMULA column — user edits
const STATUS_HEADER	= "WA Status";        	// Script-owned — never write formulas here
const INTERVAL_HEADER  = "WA Interval (Days)";  // Row-level recurring interval override
const LAST_SENT_HEADER = "WA Last Sent";     	// Script writes timestamp after each send
const STOP_DATE_HEADER = "WA Stop Date";     	// Team member fills — stops recurring after this date
 
// ============================================================
//  MENU
// ============================================================
 
function onOpen() {
  SpreadsheetApp.getUi()
	.createMenu("🚀 WhatsApp Master")
	.addItem("⚙️ Run Initial Setup",      	"runInitialSetup")
	.addSeparator()
	.addSubMenu(SpreadsheetApp.getUi().createMenu("📨 Manual Actions")
  	.addItem("▶️  Send All Pending Now", 	"sendAllPending")
  	.addItem("🎨 Reapply Status Colours",	"reapplyStatusColours"))
	.addSeparator()
	.addSubMenu(SpreadsheetApp.getUi().createMenu("⏲️ Automation")
  	.addItem("✅ Enable Auto-Send Trigger",  "createTimeTrigger")
  	.addItem("🗑️ Remove ALL Triggers",   	"deleteAllTriggers")
  	.addItem("📋 View Active Triggers",  	"listTriggers"))
	.addSeparator()
	.addItem("❓ How to Use This Sheet",   	"showHelp")
	.addToUi();
}
 
// ============================================================
//  INITIAL SETUP
// ============================================================
 
function runInitialSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
 
  const resp = ui.alert(
	"⚙️ Initial Setup",
	"This will create 4 sheets: CONFIG, TEMPLATES, DATA, LOG.\n\n" +
	"Existing sheets with those names will be CLEARED.\n\nContinue?",
	ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
 
  _setupConfigSheet(ss);
  _setupTemplatesSheet(ss);
  _setupDataSheet(ss);
  _setupLogSheet(ss);
 
  // Reorder sheets
  [SHEET.CONFIG, SHEET.TEMPLATES, SHEET.DATA, SHEET.LOG].forEach((name, i) => {
	const s = ss.getSheetByName(name);
	if (s) { ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); }
  });
 
  ss.setActiveSheet(ss.getSheetByName(SHEET.DATA));
  ui.alert(
	"✅ Setup complete!\n\n" +
	"Next steps:\n" +
	"1. Fill ⚙️ CONFIG — API Endpoint & Access Token\n" +
	"2. Add your templates in 📋 TEMPLATES\n" +
	"3. Add your data in 📊 DATA\n" +
	"4. Write your ARRAYFORMULA in the 'WA Trigger' column\n" +
	"5. Menu → Automation → Enable Auto-Send Trigger\n\n" +
	"See menu → How to Use for full instructions."
  );
}
 
// ============================================================
//  SHEET SETUP FUNCTIONS
// ============================================================
 
function _setupConfigSheet(ss) {
  const s = _getOrCreate(ss, SHEET.CONFIG);
  s.setTabColor("#4285F4");
 
  _mergeStyle(s, "A1:B1", "⚙️ WATI CONFIGURATION", "#1a73e8", "white", 13);
 
  _mergeStyle(s, "A2:B2", "🔐 API CREDENTIALS", "#e8f0fe", "#1a73e8", 11, true);
  s.getRange("A3:B5").setValues([
	["API Endpoint",          	""],
	["Access Token",          	""],
	["Trigger Interval (mins)",   "5"]
  ]);
  s.getRange("B3").setNote("Paste your WATI endpoint\ne.g. https://live-mt-server.wati.io/10129");
  s.getRange("B4").setNote("Paste your WATI Bearer token (without 'Bearer ' prefix)");
  s.getRange("B5").setNote("How often (minutes) to check for pending rows.\nMin = 1, Recommended = 5");
 
  _mergeStyle(s, "A6:B6", "📊 DATA SHEET COLUMN HEADERS", "#e6f4ea", "#137333", 11, true);
  s.getRange("A7:B10").setValues([
	["── Label ──",           	"── Value ──"],
	["Phone Column Header",   	"Phone"],
	["WA Trigger Column Header",  TRIGGER_HEADER],
	["WA Status Column Header",   STATUS_HEADER]
  ]);
  s.getRange("A7:B7").setFontWeight("bold").setBackground("#f8f9fa");
  s.getRange("B8").setNote("Exact header of the phone column in your DATA sheet");
  s.getRange("B9").setNote("Exact header of the WA Trigger column. Default: 'WA Trigger'");
  s.getRange("B10").setNote("Exact header of the WA Status column. Default: 'WA Status'");
 
  s.setColumnWidth(1, 230);
  s.setColumnWidth(2, 320);
  s.setFrozenRows(1);
 
  try {
	const p = s.getRange("A1:A10").protect();
	p.setDescription("CONFIG labels — do not edit");
	p.setWarningOnly(true);
  } catch(e) {}
}
 
function _setupTemplatesSheet(ss) {
  const s = _getOrCreate(ss, SHEET.TEMPLATES);
  s.clearConditionalFormatRules();
  try { s.clearDataValidations(); } catch(e) {}
  s.setTabColor("#34A853");
 
  // Row 1 — instruction (permanently at top, frozen)
  _mergeStyle(s, "A1:N1",
	"ℹ️  SIMPLE RULE:  v1→ to v10→ text must match DATA sheet headers AND WATI variable names exactly " +
	"(same spelling, same case).  " +
	"Google Drive URLs in any variable column are automatically converted to direct download format — " +
	"no extra configuration needed.  " +
	"Default Interval: blank = one-time, number = recurring every N days.",
	"#e8f0fe", "#1a73e8", 10);
  s.setRowHeight(1, 48);
 
  // Row 2 — title
  _mergeStyle(s, "A2:N2", "📋 TEMPLATES — One row per WATI template", "#34A853", "white", 13);
 
  // Row 3 — column headers (14 total)
  const headers = [
	"Template ID",        	// 1
	"WATI Template Name", 	// 2
	"Var Count",          	// 3
	"v1 → Header",        	// 4
	"v2 → Header",        	// 5
	"v3 → Header",        	// 6
	"v4 → Header",        	// 7
	"v5 → Header",        	// 8
	"v6 → Header",        	// 9
	"v7 → Header",        	// 10
	"v8 → Header",        	// 11
	"v9 → Header",        	// 12
	"v10 → Header",       	// 13
	"Default Interval (Days)" // 14
  ];
  s.getRange(3, 1, 1, headers.length)
	.setValues([headers])
	.setBackground("#137333").setFontColor("white").setFontWeight("bold");
 
  s.getRange(3,1).setNote("Friendly name used in DATA sheet.\nExamples: T1 - Invoice | T2 - Visit Message");
  s.getRange(3,2).setNote("EXACT template name from WATI/Meta dashboard.\nCase-sensitive. No spaces.");
  s.getRange(3,3).setNote(
	"Number of {{variables}} in the WATI template.\n\n" +
	"Tip: Google Drive URLs work for any variable — the script auto-converts\n" +
	"them to direct download format so WATI can fetch the file correctly."
  );
  s.getRange(3,14).setNote(
	"Recurring interval in days (default for all rows using this template).\n\n" +
	"Leave blank = one-time send.\n" +
	"Number = recurring every N days.\n" +
	"Row-level 'WA Interval (Days)' column overrides this."
  );
 
  // Sample rows — 14 values each
  s.getRange(4, 1, 1, 14).setValues([[
	"T1 - Visit Message", "dse_visit_hindi", 2,
	"Name", "City", "", "", "", "", "", "", "", "",
	""
  ]]).setBackground("#f1f8e9");
 
  s.getRange(5, 1, 1, 14).setValues([[
	"T2 - Invoice PDF", "invoice_pdf_doc", 1,
	"attachment_url", "", "", "", "", "", "", "", "", "",
	""
  ]]).setBackground("#f1f8e9");
 
  s.getRange(6, 1, 1, 14).setValues([[
	"T3 - Payment Reminder", "payment_reminder", 2,
	"Name", "Amount", "", "", "", "", "", "", "", "",
	3
  ]]).setBackground("#f1f8e9");
 
  // Column widths
  s.setColumnWidth(1, 185); s.setColumnWidth(2, 210); s.setColumnWidth(3, 90);
  for (let c = 4; c <= 13; c++) s.setColumnWidth(c, 120);
  s.setColumnWidth(14, 175);
 
  s.setFrozenRows(3);
}
 
function _setupDataSheet(ss) {
  const s = _getOrCreate(ss, SHEET.DATA);
  s.clearConditionalFormatRules();
  try { s.clearDataValidations(); } catch(e) {}
  s.setTabColor("#FBBC04");
 
  _mergeStyle(s, "A1:L1", "📊 DATA SHEET — Add your contacts here", "#FBBC04", "#3c2a00", 13);
 
  const headers = [
	"Timestamp", "Name", "Phone", "Invoice No", "Invoice Date", "Amount",
	"WA Template ID", TRIGGER_HEADER, STATUS_HEADER,
	INTERVAL_HEADER, LAST_SENT_HEADER, STOP_DATE_HEADER
  ];
  s.getRange(2, 1, 1, headers.length)
	.setValues([headers])
	.setBackground("#1f2937").setFontColor("white").setFontWeight("bold");
 
  s.getRange(2, 7).setNote(
	"WA Template ID — type or formula the Template ID.\n" +
	"Must match exactly what's in the TEMPLATES sheet (spelling & case)."
  );
  s.getRange(2, 8).setNote(
	"WA Trigger — YOUR ARRAYFORMULA COLUMN.\n\n" +
	"Write one formula in row 3 returning 'Yes' when the row should be sent.\n\n" +
	"Example: =ARRAYFORMULA(IF(G3:G<>\"\",\"Yes\",\"\"))\n\n" +
	"Script sends rows where this = 'Yes' AND WA Status is blank.\n" +
	"For recurring rows: keep returning 'Yes' — interval logic handles timing.\n" +
	"NEVER write formulas in WA Status — script owns that column."
  );
  s.getRange(2, 9).setNote(
	"WA Status — SCRIPT OWNED. Do not write formulas here.\n\n" +
	"Sent         → ✅ green\n" +
	"Error        → 🔴 red (see LOG sheet)\n" +
	"Invalid No.  → 🔴 red (phone unrecognised)\n" +
	"Config Error → 🔴 red (template issue)\n" +
	"Processing   → currently being sent\n" +
	"Stopped      → WA Stop Date passed\n\n" +
	"To re-send: clear this cell."
  );
  s.getRange(2, 10).setNote(
	"WA Interval (Days) — optional row-level override.\n\n" +
	"Blank → uses template Default Interval.\n" +
	"Number → overrides template default for this row only.\n" +
	"Both blank → one-time send."
  );
  s.getRange(2, 11).setNote("WA Last Sent — script writes timestamp here after each successful send. Do not edit.");
  s.getRange(2, 12).setNote(
	"WA Stop Date — fill a date to permanently stop recurring sends after that date.\n" +
	"Leave blank = runs indefinitely.\n" +
	"To restart a stopped row: clear both this cell and WA Status."
  );
 
  // Sample data rows
  s.getRange(3, 1, 3, 12).setValues([
	[new Date(), "Sample Name 1", "9876543210",	"INV-001", "01/05/2025", "5000", "T2 - Invoice PDF", "", "", "", "", ""],
	[new Date(), "Sample Name 2", "+919123456789", "INV-002", "02/05/2025", "3200", "T2 - Invoice PDF", "", "", "", "", ""],
	[new Date(), "Sample Name 3", "91-98765-00001","INV-003", "03/05/2025", "1500", "T2 - Invoice PDF", "", "", "", "", ""]
  ]).setBackground("#fffde7");
 
  s.getRange("H3").setValue("← Paste your ARRAYFORMULA here")
	.setFontColor("#e65100").setFontStyle("italic");
 
  // Column widths
  s.setColumnWidth(1, 155); s.setColumnWidth(2, 155); s.setColumnWidth(3, 130);
  s.setColumnWidth(4, 110); s.setColumnWidth(5, 110); s.setColumnWidth(6, 100);
  s.setColumnWidth(7, 170); s.setColumnWidth(8, 140); s.setColumnWidth(9, 140);
  s.setColumnWidth(10, 160); s.setColumnWidth(11, 155); s.setColumnWidth(12, 135);
 
  s.setFrozenRows(2);
  _applyStatusCFRules(s, null);
}
 
function _setupLogSheet(ss) {
  const s = _getOrCreate(ss, SHEET.LOG);
  s.clearConditionalFormatRules();
  try { s.clearDataValidations(); } catch(e) {}
  s.setTabColor("#EA4335");
 
  _mergeStyle(s, "A1:G1", "📝 LOG — Audit trail of all send attempts", "#EA4335", "white", 13);
  s.getRange(2, 1, 1, 7)
	.setValues([["Timestamp", "Row #", "Phone (Normalised)", "Template ID", "WATI Template Name", "Status", "Details / Error"]])
	.setBackground("#3c1a1a").setFontColor("white").setFontWeight("bold");
 
  s.setColumnWidth(1, 165); s.setColumnWidth(2, 65);  s.setColumnWidth(3, 160);
  s.setColumnWidth(4, 170); s.setColumnWidth(5, 200); s.setColumnWidth(6, 110);
  s.setColumnWidth(7, 380);
  s.setFrozenRows(2);
 
  // Colours on LOG Status column
  const r = s.getRange("F3:F2000");
  s.setConditionalFormatRules([
	SpreadsheetApp.newConditionalFormatRule()
  	.whenTextEqualTo("Sent").setBackground("#d2f8d2").setFontColor("#137333")
  	.setRanges([r]).build(),
	SpreadsheetApp.newConditionalFormatRule()
  	.whenTextContains("Error").setBackground("#fce8e6").setFontColor("#c5221f")
  	.setRanges([r]).build(),
	SpreadsheetApp.newConditionalFormatRule()
  	.whenTextContains("Invalid").setBackground("#fce8e6").setFontColor("#c5221f")
  	.setRanges([r]).build()
  ]);
}
 
// ============================================================
//  CORE — SEND ALL PENDING
// ============================================================
 
function sendAllPending() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
 
  // 1. Load CONFIG
  const config = _loadConfig(ss);
  if (!config) return;
 
  // 2. Load DATA sheet
  const dataSheet = ss.getSheetByName(SHEET.DATA);
  if (!dataSheet) {
	_log(ss, null, null, null, null, "Config Error", "DATA sheet not found.");
	return;
  }
 
  // 3. Read all DATA in one batch (performance)
  const lastRow = dataSheet.getLastRow();
  if (lastRow < 3) return; // row 1 = title, row 2 = headers, nothing to process
 
  const dataRange  = dataSheet.getRange(2, 1, lastRow - 1, dataSheet.getLastColumn());
  const allValues  = dataRange.getValues();    	// raw values — dates, numbers
  const allDisplay = dataRange.getDisplayValues(); // display strings — handles hyperlinked cells
  const headers	= allValues[0].map(h => h.toString().trim());
 
  // 4. Resolve column indices by header name
  const phoneIdx  	= headers.indexOf(config.phoneHeader);
  const triggerIdx	= headers.indexOf(config.triggerHeader);
  const statusIdx 	= headers.indexOf(config.statusHeader);
  const templateIdIdx = headers.indexOf("WA Template ID");
  const intervalIdx   = headers.indexOf(INTERVAL_HEADER);
  const lastSentIdx   = headers.indexOf(LAST_SENT_HEADER);
  const stopDateIdx   = headers.indexOf(STOP_DATE_HEADER);
 
  if (phoneIdx   === -1) { _log(ss,null,null,null,null,"Config Error","Column not found: " + config.phoneHeader);   return; }
  if (triggerIdx === -1) { _log(ss,null,null,null,null,"Config Error","Column not found: " + config.triggerHeader); return; }
  if (statusIdx  === -1) { _log(ss,null,null,null,null,"Config Error","Column not found: " + config.statusHeader);  return; }
 
  // 5. Load TEMPLATES once
  const templates = _loadTemplates(ss);
  if (!templates) return;
 
  // 6. Process each data row
  for (let i = 1; i < allValues.length; i++) {
	const row  	= allValues[i];
	const trigger  = allDisplay[i][triggerIdx] ? allDisplay[i][triggerIdx].toString().trim() : "";
	const status   = allDisplay[i][statusIdx]  ? allDisplay[i][statusIdx].toString().trim()  : "";
	const sheetRow = i + 2; // +1 for 0-index offset, +1 for title row
 
	if (trigger.toLowerCase() !== "yes") continue;
	if (status === "Stopped") continue;
 
	// --- STOP DATE CHECK ---
	if (stopDateIdx !== -1) {
  	const stopVal = row[stopDateIdx];
  	if (stopVal instanceof Date && stopVal.getTime() > 0) {
    	const today	= new Date(); today.setHours(0,0,0,0);
    	const stopDate = new Date(stopVal); stopDate.setHours(0,0,0,0);
    	if (today > stopDate) {
      	_setStatus(dataSheet, sheetRow, statusIdx + 1, "Stopped");
      	_log(ss, sheetRow, "—", "—", "—", "Stopped",
           	"WA Stop Date (" + Utilities.formatDate(stopVal, Session.getScriptTimeZone(), "dd/MM/yyyy") +
           	") has passed. Row will not be processed again.");
      	continue;
    	}
  	}
	}
 
	// --- RECURRING INTERVAL CHECK ---
	const templateId	= templateIdIdx !== -1 ? row[templateIdIdx].toString().trim() : "";
	const tmplRef   	= templateId && templates[templateId] ? templates[templateId] : null;
	const rowInterval   = intervalIdx !== -1 ? (parseFloat(row[intervalIdx]) || 0) : 0;
	const tmplInterval  = tmplRef ? (tmplRef.defaultInterval || 0) : 0;
	const effectiveInterval = rowInterval > 0 ? rowInterval : tmplInterval;
 
	if (effectiveInterval > 0) {
  	const lastSentVal = lastSentIdx !== -1 ? row[lastSentIdx] : null;
  	if (status === "Sent" && lastSentVal instanceof Date && lastSentVal.getTime() > 0) {
    	const daysSince = (Date.now() - lastSentVal.getTime()) / (1000 * 60 * 60 * 24);
    	if (daysSince < effectiveInterval) continue; // interval not yet reached
    	_setStatus(dataSheet, sheetRow, statusIdx + 1, ""); // reset → fall through to send
  	}
	} else {
  	if (status !== "") continue; // one-time: skip if already has any status
	}
 
	// 6a. Race condition guard
	_setStatus(dataSheet, sheetRow, statusIdx + 1, "Processing");
 
	// 6b. Normalise phone number
	const rawPhone = row[phoneIdx] ? row[phoneIdx].toString().trim() : "";
	const phone	= _normalisePhone(rawPhone);
	if (!phone) {
  	_setStatus(dataSheet, sheetRow, statusIdx + 1, "Invalid No.");
  	_log(ss, sheetRow, rawPhone, "—", "—", "Invalid No.",
       	"Cannot normalise '" + rawPhone + "'. Expected 10 or 12-digit Indian number.");
  	continue;
	}
 
	// 6c. Look up template
	if (!templateId) {
  	_setStatus(dataSheet, sheetRow, statusIdx + 1, "Config Error");
  	_log(ss, sheetRow, phone, "—", "—", "Config Error", "'WA Template ID' cell is empty.");
  	continue;
	}
	const tmpl = templates[templateId];
	if (!tmpl) {
  	_setStatus(dataSheet, sheetRow, statusIdx + 1, "Config Error");
  	_log(ss, sheetRow, phone, templateId, "—", "Config Error",
       	"Template ID '" + templateId + "' not found in TEMPLATES sheet. Check spelling and case.");
  	continue;
	}
 
	// 6d. Build parameters
	const paramResult = _buildParameters(tmpl, headers, row, allDisplay[i]);
	if (paramResult.error) {
  	_setStatus(dataSheet, sheetRow, statusIdx + 1, "Config Error");
  	_log(ss, sheetRow, phone, templateId, tmpl.watiName, "Config Error", paramResult.error);
  	continue;
	}
 
	// 6e. Send via WATI API
	const apiResult = _sendToWati(config, tmpl.watiName, phone, paramResult.parameters);
 
	if (apiResult.success) {
  	_setStatus(dataSheet, sheetRow, statusIdx + 1, "Sent");
  	if (lastSentIdx !== -1) dataSheet.getRange(sheetRow, lastSentIdx + 1).setValue(new Date());
  	_log(ss, sheetRow, phone, templateId, tmpl.watiName, "Sent",
       	"Sent | " + paramResult.parameters.length + " var(s)" +
       	(effectiveInterval > 0 ? " | Recurring every " + effectiveInterval + "d" : " | One-time"));
	} else {
  	_setStatus(dataSheet, sheetRow, statusIdx + 1, "Error");
  	_log(ss, sheetRow, phone, templateId, tmpl.watiName, "Error", apiResult.error);
	}
 
	Utilities.sleep(300);
  }
}
 
// ============================================================
//  HELPERS
// ============================================================
 
/**
 * Reads CONFIG sheet and returns a config object.
 * Returns null if critical fields are missing.
 */
function _loadConfig(ss) {
  const s = ss.getSheetByName(SHEET.CONFIG);
  if (!s) {
	SpreadsheetApp.getUi().alert("❌ CONFIG sheet not found. Run Initial Setup first.");
	return null;
  }
  const endpoint  	= s.getRange(CFG.ENDPOINT).getValue().toString().trim();
  const token     	= s.getRange(CFG.TOKEN).getValue().toString().trim();
  const phoneHeader   = s.getRange(CFG.PHONE_COL).getValue().toString().trim();
  const triggerHeader = s.getRange(CFG.TRIGGER_COL).getValue().toString().trim();
  const statusHeader  = s.getRange(CFG.STATUS_COL).getValue().toString().trim();
 
  if (!endpoint || !token) {
	_log(ss, null, null, null, null, "Config Error",
     	"API Endpoint or Access Token is empty in CONFIG sheet.");
	return null;
  }
  return { endpoint, token, phoneHeader, triggerHeader, statusHeader };
}
 
/**
 * Reads TEMPLATES sheet and returns a lookup map keyed by Template ID.
 * Finds columns by header name — column order doesn't matter.
 * Scans first 5 rows to auto-detect the header row.
 *
 * Each map entry:
 *   { watiName, templateType, varCount, varHeaders[], pdfUrlColumn, defaultInterval }
 */
function _loadTemplates(ss) {
  const s = ss.getSheetByName(SHEET.TEMPLATES);
  if (!s) {
	_log(ss, null, null, null, null, "Config Error", "TEMPLATES sheet not found.");
	return null;
  }
 
  const lastRow = s.getLastRow();
  const lastCol = s.getLastColumn();
  if (lastRow < 2) return {};
 
  // Auto-detect header row by scanning first 5 rows for "Template ID"
  const scanRows = s.getRange(1, 1, Math.min(5, lastRow), lastCol).getValues();
  let headerRowNum = -1;
  for (let r = 0; r < scanRows.length; r++) {
	if (scanRows[r].some(c => c.toString().trim() === "Template ID")) {
  	headerRowNum = r + 1; break;
	}
  }
  if (headerRowNum === -1) {
	_log(ss, null, null, null, null, "Config Error",
     	"TEMPLATES sheet: cannot find header row containing 'Template ID'.");
	return null;
  }
 
  const headerRow = scanRows[headerRowNum - 1];
  const hIdx  	= name => headerRow.findIndex(h => h.toString().trim() === name);
 
  const idIdx          	= hIdx(TMPL_HEADERS.ID);
  const watiNameIdx    	= hIdx(TMPL_HEADERS.WATI_NAME);
  const varCountIdx    	= hIdx(TMPL_HEADERS.VAR_COUNT);
  const defaultIntervalIdx = hIdx(TMPL_HEADERS.DEFAULT_INTERVAL);
 
  // v1 → Header through v10 → Header — found in order
  const varColIndices = [];
  for (let v = 1; v <= 10; v++) {
	const idx = hIdx("v" + v + " \u2192 Header");
	if (idx !== -1) varColIndices.push(idx);
  }
 
  if (idIdx === -1 || watiNameIdx === -1 || varCountIdx === -1) {
	_log(ss, null, null, null, null, "Config Error",
     	"TEMPLATES sheet missing required headers: 'Template ID', 'WATI Template Name', or 'Var Count'.");
	return null;
  }
 
  const dataStartRow = headerRowNum + 1;
  if (dataStartRow > lastRow) return {};
  const data = s.getRange(dataStartRow, 1, lastRow - headerRowNum, lastCol).getValues();
  const map  = {};
 
  data.forEach(row => {
	const id   	= row[idIdx].toString().trim();
	const watiName = row[watiNameIdx].toString().trim();
	if (!id || !watiName) return;
 
	const varCount    	= parseInt(row[varCountIdx]) || 0;
	const defaultInterval = defaultIntervalIdx !== -1 ? (parseFloat(row[defaultIntervalIdx]) || 0) : 0;
 
	const varHeaders = [];
	varColIndices.forEach(idx => {
  	const h = row[idx] ? row[idx].toString().trim() : "";
  	if (h) varHeaders.push(h);
	});
 
	map[id] = { watiName, varCount, varHeaders, defaultInterval };
  });
 
  return map;
}
 
/**
 * Builds WATI parameters array for a given template and DATA row.
 * Uses displayRow for all reads — correctly handles hyperlinks and formatted values.
 * Returns { parameters, error }
 */
function _buildParameters(tmpl, dataHeaders, dataRow, displayRow) {
  if (tmpl.varHeaders.length !== tmpl.varCount) {
	return {
  	parameters: null,
  	error: "Var Count = " + tmpl.varCount + " but " + tmpl.varHeaders.length +
         	" header(s) are mapped. Update the TEMPLATES sheet."
	};
  }
 
  const parameters = [];
  const missing	= [];
 
  for (let i = 0; i < tmpl.varHeaders.length; i++) {
	const headerName = tmpl.varHeaders[i];
	const colIdx 	= dataHeaders.indexOf(headerName);
	if (colIdx === -1) { missing.push(headerName); continue; }
 
	// Prefer display value (handles hyperlinks, formatted dates and numbers)
	let val = (displayRow && displayRow[colIdx] !== undefined && displayRow[colIdx] !== "")
  	? displayRow[colIdx].toString().trim()
  	: (dataRow[colIdx] instanceof Date
      	? Utilities.formatDate(dataRow[colIdx], Session.getScriptTimeZone(), "dd/MM/yyyy")
      	: (dataRow[colIdx] != null ? dataRow[colIdx].toString().trim() : ""));
 
	// Auto-convert Google Drive share URLs to direct download format
	// WATI needs a direct download URL to fetch the actual file bytes.
	// We also embed the filename in the URL so WATI uses it as the document name.
	if (val.includes("drive.google.com/file/d/") || val.includes("drive.google.com/open?id=")) {
  	const m = val.match(/\/d\/([\w-]+)/) || val.match(/[?&]id=([\w-]+)/);
  	if (m) {
    	const fileId = m[1];
    	let filename = "";
    	try {
      	filename = DriveApp.getFileById(fileId).getName();
    	} catch(e) {
      	filename = "Document.pdf";
    	}
    	// Use export=download with confirm=1 to bypass Google's virus scan redirect
    	// for larger files, and include filename so WATI labels it correctly
    	val = "https://drive.google.com/uc?export=download&confirm=1&id=" + fileId;
    	if (filename) val += "&filename=" + encodeURIComponent(filename);
  	}
	}
 
	parameters.push({ name: headerName, value: val });
  }
 
  if (missing.length > 0) {
	return {
  	parameters: null,
  	error: "Header(s) not found in DATA sheet: [" + missing.join(", ") + "]. " +
         	"Check spelling and case in TEMPLATES v-headers."
	};
  }
 
  return { parameters, error: null };
}
 
/**
 * Normalises an Indian phone number to 12-digit format (91XXXXXXXXXX).
 * Returns null if unrecognisable.
 */
function _normalisePhone(raw) {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10)                    	return "91" + d;
  if (d.length === 11 && d.startsWith("0"))   return "91" + d.slice(1);
  if (d.length === 12 && d.startsWith("91"))  return d;
  if (d.length === 13 && d.startsWith("091")) return d.slice(1);
  return null;
}
 
/**
 * Sends a WhatsApp template message via WATI API.
 * Google Drive URLs in parameters are auto-converted to direct download
 * format by _buildParameters before reaching here.
 *
 * @param {object} config   	- { endpoint, token }
 * @param {string} templateName - Exact WATI template name
 * @param {string} phone    	- Normalised 12-digit number
 * @param {Array}  parameters   - [{ name, value }, ...]
 * @return {{ success: boolean, error: string|null }}
 */
function _sendToWati(config, templateName, phone, parameters) {
  const url = config.endpoint.replace(/\/+$/, "") +
          	"/api/v1/sendTemplateMessage?whatsappNumber=" + encodeURIComponent(phone);
 
  const payload = {
	template_name  : templateName,
	broadcast_name : "GSheets_Automation",
	parameters 	: parameters
  };
 
  const options = {
	method        	: "post",
	contentType   	: "application/json",
	headers       	: { "Authorization": "Bearer " + config.token },
	payload       	: JSON.stringify(payload),
	muteHttpExceptions: true
  };
 
  try {
	const response = UrlFetchApp.fetch(url, options);
	const code 	= response.getResponseCode();
	const body 	= response.getContentText();
	let parsed;
	try { parsed = JSON.parse(body); } catch(e) { parsed = {}; }
 
	if ((code === 200 || code === 201) &&
    	(parsed.result === true || parsed.result === "success" || parsed.result === "true")) {
  	return { success: true, error: null };
	}
	return {
  	success: false,
  	error: "HTTP " + code + ": " + (parsed.message || parsed.info || body.substring(0, 250))
	};
  } catch(e) {
	return { success: false, error: "Network/script error: " + e.toString() };
  }
}
 
// ============================================================
//  STATUS WRITER
// ============================================================
 
/**
 * Writes status text to the WA Status column.
 * Conditional formatting handles all colouring — no manual colours set here.
 */
function _setStatus(sheet, row, colNum, statusText) {
  sheet.getRange(row, colNum).setValue(statusText);
}
 
// ============================================================
//  LOG WRITER
// ============================================================
 
function _log(ss, rowNum, phone, templateId, watiName, status, details) {
  const s = ss.getSheetByName(SHEET.LOG);
  if (!s) return;
  s.getRange(Math.max(s.getLastRow(), 2) + 1, 1, 1, 7).setValues([[
	new Date(),
	rowNum 	|| "—",
	phone  	|| "—",
	templateId || "—",
	watiName   || "—",
	status 	|| "—",
	details	|| ""
  ]]);
}
 
// ============================================================
//  URL SHORTENER — usable as a Google Sheets custom formula
// ============================================================
 
/**
 * Shortens a URL using the is.gd API (no preview page).
 * Use directly in a spreadsheet cell: =ISGD_SHORTEN(A1)
 * Returns the original URL if shortening fails — never throws.
 *
 * @param {string} url The long URL to shorten.
 * @return {string} Shortened URL, or original URL on failure.
 * @customfunction
 */
function ISGD_SHORTEN(url) {
  if (!url || url === "") return "";
  try {
	const response = UrlFetchApp.fetch(
  	"https://is.gd/create.php?format=simple&url=" + encodeURIComponent(url),
  	{ muteHttpExceptions: true }
	);
	const short = response.getContentText().trim();
	if (response.getResponseCode() === 200 && short.startsWith("https://is.gd/")) {
  	return short;
	}
	return url;
  } catch(e) {
	return url;
  }
}
 
// ============================================================
//  REAPPLY STATUS COLOURS
// ============================================================
 
/**
 * Reapplies WA Status conditional formatting rules to the DATA sheet.
 * Run this after copying the sheet to a new spreadsheet.
 * Only Sent (green) and error variants (red) are coloured. Everything else is plain text.
 */
function reapplyStatusColours() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s  = ss.getSheetByName(SHEET.DATA);
  if (!s) { SpreadsheetApp.getUi().alert("❌ DATA sheet not found."); return; }
 
  const headers   = s.getRange(2, 1, 1, s.getLastColumn()).getValues()[0];
  const statusCol = headers.findIndex(h => h.toString().trim() === STATUS_HEADER) + 1;
  if (statusCol === 0) {
	SpreadsheetApp.getUi().alert("❌ 'WA Status' column not found in DATA sheet headers.");
	return;
  }
 
  const colLetter   = _columnToLetter(statusCol);
  const statusRange = s.getRange(colLetter + "3:" + colLetter + "10000");
  _applyStatusCFRules(s, statusRange);
  SpreadsheetApp.getUi().alert("✅ Status colours reapplied successfully.");
}
 
/**
 * Applies conditional formatting rules to the WA Status column.
 * Sent → green. Error / Invalid No. / Config Error → red. Everything else → plain text.
 * If range is null, finds the WA Status column automatically.
 */
function _applyStatusCFRules(sheet, range) {
  if (!range) {
	const headers   = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
	const statusCol = headers.findIndex(h => h.toString().trim() === STATUS_HEADER) + 1;
	if (statusCol === 0) return;
	range = sheet.getRange(_columnToLetter(statusCol) + "3:" + _columnToLetter(statusCol) + "10000");
  }
  sheet.setConditionalFormatRules([
	SpreadsheetApp.newConditionalFormatRule()
  	.whenTextEqualTo("Sent")
  	.setBackground("#d2f8d2").setFontColor("#137333").setBold(true)
  	.setRanges([range]).build(),
	SpreadsheetApp.newConditionalFormatRule()
  	.whenTextEqualTo("Error")
  	.setBackground("#fce8e6").setFontColor("#c5221f").setBold(true)
  	.setRanges([range]).build(),
	SpreadsheetApp.newConditionalFormatRule()
  	.whenTextContains("Invalid")
  	.setBackground("#fce8e6").setFontColor("#c5221f").setBold(true)
  	.setRanges([range]).build(),
	SpreadsheetApp.newConditionalFormatRule()
  	.whenTextContains("Config Error")
  	.setBackground("#fce8e6").setFontColor("#c5221f").setBold(true)
  	.setRanges([range]).build()
  ]);
}
 
// ============================================================
//  TRIGGERS
// ============================================================
 
function createTimeTrigger() {
  const ss   	= SpreadsheetApp.getActiveSpreadsheet();
  const cfgSheet = ss.getSheetByName(SHEET.CONFIG);
  let interval   = 5;
  if (cfgSheet) {
	const v = parseInt(cfgSheet.getRange(CFG.INTERVAL).getValue());
	if (v > 0) interval = v;
  }
  ScriptApp.getProjectTriggers().forEach(t => {
	if (t.getHandlerFunction() === "sendAllPending") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sendAllPending").timeBased().everyMinutes(interval).create();
  SpreadsheetApp.getUi().alert(
	"✅ Auto-Send enabled!\n\n" +
	"Checks for pending rows every " + interval + " minute(s).\n\n" +
	"To change: update CONFIG row 5, then re-run this menu item."
  );
}
 
function deleteAllTriggers() {
  const ui   = SpreadsheetApp.getUi();
  const resp = ui.alert("⚠️ Remove ALL triggers?",
	"This stops all automation. Continue?", ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ui.alert("✅ All triggers removed.");
}
 
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.length) {
	SpreadsheetApp.getUi().alert("No active triggers.\nUse menu → Automation → Enable to set one.");
	return;
  }
  SpreadsheetApp.getUi().alert(
	"Active Triggers:\n\n" +
	triggers.map(t => "• " + t.getHandlerFunction() + " (" + t.getTriggerSource() + ")").join("\n")
  );
}
 
// ============================================================
//  HELP
// ============================================================
 
function showHelp() {
  SpreadsheetApp.getUi().alert(
	"📖 HOW TO USE — WhatsApp Master v5.0\n\n" +
 
	"FIRST-TIME SETUP:\n" +
	"1. Menu → Run Initial Setup\n" +
	"2. Fill ⚙️ CONFIG — API Endpoint & Access Token\n" +
	"3. Add templates in 📋 TEMPLATES:\n" +
	"   • Var Count: number of variables in the WATI template\n" +
	"   • v1→ to v10→: DATA column headers = WATI variable names\n" +
	"   • Default Interval: blank = one-time, number = recurring\n" +
	"4. Add data in 📊 DATA\n" +
	"5. Write ARRAYFORMULA in 'WA Trigger' column\n" +
	"   Example: =ARRAYFORMULA(IF(G3:G<>\"\",\"Yes\",\"\"))\n" +
	"6. Menu → Automation → Enable Auto-Send Trigger\n\n" +
 
	"SENDING PDF / DOCUMENT FILES:\n" +
	"• No special setup needed\n" +
	"• Just map the Drive URL column as a normal variable in TEMPLATES\n" +
	"• Script auto-converts Drive URLs to direct download format\n" +
	"• Original Drive filename is preserved on WhatsApp\n\n" +
 
	"RECURRING MESSAGES:\n" +
	"• Set Default Interval (Days) in TEMPLATES sheet\n" +
	"• Or per row using 'WA Interval (Days)' column in DATA\n" +
	"• Set 'WA Stop Date' to stop recurring after a date\n\n" +
 
	"URL SHORTENER:\n" +
	"• Use =ISGD_SHORTEN(A1) in any DATA sheet cell\n\n" +
 
	"AFTER COPYING SHEET:\n" +
	"• Menu → 🎨 Reapply Status Colours\n" +
	"• Re-enable trigger"
  );
}
 
// ============================================================
//  UTILITY
// ============================================================
 
function _getOrCreate(ss, name) {
  let s = ss.getSheetByName(name);
  if (!s) s = ss.insertSheet(name);
  else s.clear();
  return s;
}
 
function _mergeStyle(sheet, a1Range, text, bg, fg, fontSize, italic) {
  const r = sheet.getRange(a1Range);
  r.merge().setValue(text)
   .setBackground(bg).setFontColor(fg)
   .setFontSize(fontSize || 11).setFontWeight("bold")
   .setVerticalAlignment("middle").setWrap(true);
  if (italic) r.setFontStyle("italic");
}
 
function _columnToLetter(col) {
  let letter = "";
  while (col > 0) {
	const rem = (col - 1) % 26;
	letter	= String.fromCharCode(65 + rem) + letter;
	col   	= Math.floor((col - 1) / 26);
  }
  return letter;
}

