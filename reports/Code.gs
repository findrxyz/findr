/**
 * Problem reports for findr, kept in a Google Sheet.
 *
 * The page is static, so its "Report a problem" form posts to this script, which adds one row per report to the
 * spreadsheet it is attached to. To set it up:
 *
 *   1. Create a Google Sheet. Open Extensions → Apps Script and replace the editor's contents with this file.
 *   2. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone.
 *   3. Approve the access request. It covers this one spreadsheet and nothing else (see @OnlyCurrentDoc below).
 *   4. Put the web app URL, which ends in /exec, in REPORT_URL in app.js.
 *
 * After changing this file: Deploy → Manage deployments → Edit → Version: New version. That keeps the same URL.
 *
 * A web app can't see who is calling it, so nothing here checks the sender: anyone who finds the URL can add rows.
 * What limits the damage is a cap on reports per minute and per day, a length cap on every field, a form field
 * only bots fill in, and cell text that can never start a formula.
 *
 * @OnlyCurrentDoc
 */

const SHEET = 'Reports';
const COLUMNS = ['Received', 'Problem', 'Reply to', 'Pool', 'Details'];
const WIDTHS = [130, 420, 200, 260, 420];
const MAX_BODY = 8000;     // characters of JSON accepted
const MAX_MESSAGE = 2000;
const MAX_POOL = 300;
const MAX_CONTEXT = 3000;
const PER_MINUTE = 6;      // reports accepted from everyone together
const PER_DAY = 200;
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

// Opening the URL in a browser shows this, which is a quick way to check the deployment.
function doGet() {
  return ContentService.createTextOutput('findr problem reports: this address only accepts reports from the page.');
}

function doPost(e) {
  let out;
  try {
    out = save(e);
  } catch (err) {
    console.error(err);
    out = refuse("The report couldn't be saved.");
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

const refuse = (error) => ({ ok: false, error });

// Drops control characters (keeping tabs and line breaks) and trims to a maximum length.
const clean = (s, max) => (typeof s === 'string' ? s : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

// Sheets treats text starting with = + - or @ as a formula, which would let a report run one in this
// spreadsheet. A leading apostrophe makes it plain text.
const asText = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);

function save(e) {
  const raw = (e && e.postData && e.postData.contents) || '';
  if (raw.length > MAX_BODY) return refuse('That report is too long.');
  let data;
  try { data = JSON.parse(raw); } catch (err) { data = null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return refuse('The report could not be read.');

  // The form has a field people can't see. Only a bot fills it in, and it's told all went well.
  if (data.website) return { ok: true };

  const message = clean(data.message, MAX_MESSAGE);
  const email = clean(data.email, 254);
  if (!message) return refuse('Describe the problem before sending.');
  if (email && !EMAIL.test(email)) return refuse("That email address doesn't look right.");
  const row = [new Date(), message, email, clean(data.pool, MAX_POOL), clean(data.context, MAX_CONTEXT)];

  // One report at a time, so two arriving together can't both slip under a limit.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (!underLimits()) return refuse('Too many reports just now. Try again in a minute.');
    reportsSheet().appendRow(row.map(asText));
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

// Counts reports in the current minute and day, and says whether one more is allowed.
function underLimits() {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const minute = Math.floor(now / 60e3);
  const day = Math.floor(now / 864e5);
  let c = {};
  try { c = JSON.parse(props.getProperty('counts')) || {}; } catch (err) { c = {}; }
  if (c.minute !== minute) { c.minute = minute; c.inMinute = 0; }
  if (c.day !== day) { c.day = day; c.inDay = 0; }
  if (c.inMinute >= PER_MINUTE || c.inDay >= PER_DAY) return false;
  c.inMinute++;
  c.inDay++;
  props.setProperty('counts', JSON.stringify(c));
  return true;
}

// The tab reports go to, created with its header row the first time.
function reportsSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(SHEET) || book.insertSheet(SHEET, 0);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
    sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange('B:B').setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
    sheet.getRange('E:E').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    sheet.getRange('A:E').setVerticalAlignment('top');
    WIDTHS.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  }
  return sheet;
}
