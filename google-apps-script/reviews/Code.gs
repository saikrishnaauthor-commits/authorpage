/**
 * @OnlyCurrentDoc  Limits this script to the one Sheet it is attached to.
 */

/**
 * Reader reviews server for the Sai Krishna author website.
 *
 * Storage: the "Reviews" tab of the Google Sheet this script is attached to
 * (Extensions → Apps Script in that Sheet). Deploy as a web app:
 *   Execute as: Me   ·   Who has access: Anyone
 * See README.md in this folder for full setup steps.
 *
 * GET  ?action=list[&bookId=book_1_pb]      approved reviews (public)
 * POST {action:'submit', ...}               new review → status "pending"
 * POST {action:'adminList', key, status}    moderation queue (needs ADMIN_KEY)
 * POST {action:'moderate', key, id, status} approve / reject
 * POST {action:'delete', key, id}           delete permanently
 *
 * POST bodies are sent as text/plain so browsers skip the CORS preflight,
 * which Apps Script cannot answer.
 *
 * You can also moderate straight from the Sheet: change a row's "status"
 * cell to approved / rejected. The website picks it up within a minute.
 */

const SHEET_NAME = 'Reviews';
const HEADERS = ['id', 'createdAt', 'status', 'bookId', 'bookTitle', 'name', 'rating', 'title', 'text', 'verified', 'orderNumber', 'moderatedAt'];
const COL = HEADERS.reduce((map, name, i) => (map[name] = i, map), {});
const STATUSES = ['pending', 'approved', 'rejected'];
const STORE_API = 'https://authorpage-gybu.onrender.com';
const MAX_NEW_PER_HOUR = 30;     // across all visitors; protects the queue from floods
const PUBLIC_CACHE_SECONDS = 60;

/* ---------------- HTTP entry points ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action && p.action !== 'list') return json_({ error: 'Unknown action.' });
    const bookId = clean_(p.bookId, 80);
    const reviews = listApproved_();
    return json_(bookId ? reviews.filter(r => r.bookId === bookId) : reviews);
  } catch (err) {
    console.error(err);
    return json_({ error: 'Could not load reviews.' });
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ error: 'Invalid request.' });
  }
  try {
    switch (body.action) {
      case 'submit': return json_(submit_(body));
      case 'adminList': requireAdmin_(body.key); return json_(adminList_(body.status));
      case 'moderate': requireAdmin_(body.key); return json_(moderate_(body.id, body.status));
      case 'delete': requireAdmin_(body.key); return json_(remove_(body.id));
      default: return json_({ error: 'Unknown action.' });
    }
  } catch (err) {
    if (err && err.userMessage) return json_({ error: err.userMessage });
    console.error(err);
    return json_({ error: 'Something went wrong. Please try again.' });
  }
}

/* ---------------- Public ---------------- */

function listApproved_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('approved');
  if (cached) return JSON.parse(cached);

  const reviews = readRows_()
    .filter(r => r.status === 'approved')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200)
    .map(r => ({
      id: r.id, bookId: r.bookId, bookTitle: r.bookTitle, name: r.name, rating: r.rating,
      title: r.title, text: r.text, verified: r.verified, createdAt: r.createdAt
    }));
  const payload = JSON.stringify(reviews);
  if (payload.length < 90000) cache.put('approved', payload, PUBLIC_CACHE_SECONDS);
  return reviews;
}

function submit_(body) {
  // Honeypot: real visitors never see or fill this field. Pretend success.
  if (clean_(body.website, 200)) return { success: true, status: 'pending' };

  const name = clean_(body.name, 60);
  const title = clean_(body.title, 100);
  const text = clean_(body.text, 2000);
  const rating = Number(body.rating);
  const orderNumber = clean_(body.orderNumber, 60);
  const email = clean_(body.email, 200).toLowerCase();
  let bookId = clean_(body.bookId, 80);
  let bookTitle = clean_(body.bookTitle, 200);

  if (!/^[A-Za-z0-9_-]{1,80}$/.test(bookId)) fail_('Choose the book you are reviewing.');
  if (name.length < 2) fail_('Enter your name (at least 2 characters).');
  if (!(rating >= 1 && rating <= 5 && Math.floor(rating) === rating)) fail_('Choose a rating from 1 to 5 stars.');
  if (text.length < 20) fail_('Your review needs at least 20 characters.');
  if (Boolean(orderNumber) !== Boolean(email)) {
    fail_('To verify your purchase, enter both your order number and checkout email — or leave both empty.');
  }

  // Trust the live catalogue for the title when it is reachable.
  const catalog = catalog_();
  let bookIds = [bookId];
  if (catalog) {
    const book = catalog.find(b => b.pbId === bookId || b.ebId === bookId);
    if (!book) fail_('That book is not in the catalogue.');
    bookId = book.pbId || book.ebId;
    bookTitle = String(book.title || bookTitle);
    bookIds = [book.pbId, book.ebId].filter(Boolean);
  }
  if (!bookTitle) fail_('Choose the book you are reviewing.');

  let verified = false;
  if (orderNumber) {
    const order = lookupOrder_(orderNumber, email);
    verified = (order.items || []).some(item => bookIds.indexOf(String(item.id || '')) !== -1);
    if (!verified) fail_('That order does not include this book.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = sheet_();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = readRows_(sheet).filter(r => r.createdAt >= hourAgo).length;
    if (recent >= MAX_NEW_PER_HOUR) fail_('We are receiving a lot of reviews right now. Please try again in an hour.');

    const row = [];
    row[COL.id] = Utilities.getUuid();
    row[COL.createdAt] = new Date().toISOString();
    row[COL.status] = 'pending';
    row[COL.bookId] = bookId;
    row[COL.bookTitle] = bookTitle;
    row[COL.name] = name;
    row[COL.rating] = rating;
    row[COL.title] = title;
    row[COL.text] = text;
    row[COL.verified] = verified;
    row[COL.orderNumber] = verified ? orderNumber : '';
    row[COL.moderatedAt] = '';
    sheet.appendRow(row.map(sheetSafe_));
  } finally {
    lock.releaseLock();
  }
  return { success: true, status: 'pending' };
}

/* ---------------- Admin ---------------- */

function requireAdmin_(key) {
  const cache = CacheService.getScriptCache();
  const failures = Number(cache.get('adminFailures') || 0);
  if (failures >= 20) fail_('Too many failed admin attempts. Try again in 15 minutes.');

  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!expected) fail_('Review admin key is not set up. Add ADMIN_KEY in the script\'s Project Settings → Script properties.');
  const supplied = String(key || '');
  let diff = supplied.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i % (supplied.length || 1));
  if (diff !== 0) {
    cache.put('adminFailures', String(failures + 1), 900);
    fail_('Unauthorized admin access.');
  }
}

function adminList_(status) {
  const rows = readRows_();
  const wanted = STATUSES.indexOf(status) !== -1 ? rows.filter(r => r.status === status) : rows;
  return wanted.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500);
}

function moderate_(id, status) {
  if (STATUSES.indexOf(status) === -1) fail_('Status must be pending, approved or rejected.');
  return withRow_(id, (sheet, rowNumber) => {
    sheet.getRange(rowNumber, COL.status + 1).setValue(status);
    sheet.getRange(rowNumber, COL.moderatedAt + 1).setValue(new Date().toISOString());
    return { success: true };
  });
}

function remove_(id) {
  return withRow_(id, (sheet, rowNumber) => {
    sheet.deleteRow(rowNumber);
    return { success: true };
  });
}

function withRow_(id, fn) {
  const target = clean_(id, 60);
  if (!target) fail_('Review not found.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = sheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][COL.id]) === target) {
        const result = fn(sheet, i + 1);
        CacheService.getScriptCache().remove('approved');
        return result;
      }
    }
    fail_('Review not found.');
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Store backend helpers ---------------- */

function catalog_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('catalog');
  if (cached) return JSON.parse(cached);
  try {
    const res = UrlFetchApp.fetch(STORE_API + '/api/catalog', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const books = JSON.parse(res.getContentText());
    if (!Array.isArray(books) || !books.length) return null;
    const slim = books.map(b => ({ title: b.title, pbId: b.pbId, ebId: b.ebId }));
    cache.put('catalog', JSON.stringify(slim), 600);
    return slim;
  } catch (err) {
    console.warn('Catalogue unavailable', err);
    return null;
  }
}

function lookupOrder_(orderNumber, email) {
  let res;
  try {
    res = UrlFetchApp.fetch(STORE_API + '/api/order-status', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ orderNumber: orderNumber, email: email }),
      muteHttpExceptions: true
    });
  } catch (err) {
    fail_('We could not check your order right now. Try again, or submit without verifying.');
  }
  const code = res.getResponseCode();
  if (code === 404) fail_('No completed order matched that order number and email.');
  if (code !== 200) fail_('We could not check your order right now. Try again, or submit without verifying.');
  return JSON.parse(res.getContentText());
}

/* ---------------- Sheet helpers ---------------- */

function sheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build();
    sheet.getRange(2, COL.status + 1, 1000, 1).setDataValidation(rule);
  }
  return sheet;
}

function readRows_(sheet) {
  const values = (sheet || sheet_()).getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (!v[COL.id]) continue;
    const created = v[COL.createdAt] instanceof Date ? v[COL.createdAt].toISOString() : String(v[COL.createdAt] || '');
    rows.push({
      id: String(v[COL.id]),
      createdAt: created,
      status: String(v[COL.status] || '').trim().toLowerCase(),
      bookId: String(v[COL.bookId] || ''),
      bookTitle: String(v[COL.bookTitle] || ''),
      name: String(v[COL.name] || ''),
      rating: Math.min(5, Math.max(1, Math.round(Number(v[COL.rating]) || 0))),
      title: String(v[COL.title] || ''),
      text: String(v[COL.text] || ''),
      verified: v[COL.verified] === true || String(v[COL.verified]).toUpperCase() === 'TRUE',
      orderNumber: String(v[COL.orderNumber] || ''),
      moderatedAt: v[COL.moderatedAt] instanceof Date ? v[COL.moderatedAt].toISOString() : String(v[COL.moderatedAt] || '')
    });
  }
  return rows;
}

// Stop text such as "=IMPORTXML(...)" from being treated as a formula.
function sheetSafe_(value) {
  return typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value;
}

function clean_(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function fail_(message) {
  const err = new Error(message);
  err.userMessage = message;
  throw err;
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to create the Reviews tab and grant permissions. */
function setup() {
  sheet_();
  catalog_();
}
