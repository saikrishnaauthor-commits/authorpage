// Sai Krishna Author Store API — all store data lives in a Google Sheet.
require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createStore, salesRows, isPaperbackItem } = require('./store');
const { getGoogleAccessToken, serviceAccountEmail } = require('./google-auth');

/* ---------------- Constants ---------------- */

const BOOK_CATALOG_DEFAULTS = [
  { title: 'KaalYug: Shadows of Dark Web', desc: 'Time is a wheel turning endlessly through eras of light and shadow.', image: 'images/kaalyug.png', pbId: 'book_1_pb', ebId: 'book_1_eb', pbPrice: 249, ebPrice: 25, ebookDriveFileId: '1eRI8rapGCk9WwL7RYd7F2zwBj8ikkbwO', sampleTitle: 'KaalYug', sampleSubtitle: 'Sample Chapter Preview', sampleText: 'The winds of transition whispered through the ancient pillars. Time was never a straight line, but a wheel turning endlessly through eras of light and shadow...' },
  { title: 'Pages of Us', desc: 'Raw emotion and human connection folded like dried flowers in a diary.', image: 'images/pages-of-us.png', pbId: 'book_2_pb', ebId: 'book_2_eb', pbPrice: 299, ebPrice: 25, ebookDriveFileId: '1XXBc9In0OiPFlwLyRB44fQWu98PGQ0bZ', sampleTitle: 'Pages of Us', sampleSubtitle: 'Sample Chapter Preview', sampleText: 'Some memories are folded like dried flowers between the pages of an old diary. When opened, they release a fragrance of nostalgia that defies distance and years...' },
  { title: 'The Indestructible Kali', desc: 'Primal energy, myth, and the ultimate resilience of the cosmos.', image: 'images/kali.jpeg', pbId: 'book_3_pb', ebId: 'book_3_eb', pbPrice: 299, ebPrice: 25, ebookDriveFileId: '1N8lwC2Wm_Qvygq3lrr4q0zl18hmLVvln', sampleTitle: 'The Indestructible Kali', sampleSubtitle: 'Sample Chapter Preview', sampleText: 'Beyond the veil of ordinary perception lies the primal energy that sustains and transforms the cosmos. Unbound by time or form, this force represents ultimate resilience...' }
];

const FULFILLMENT_STAGES = ['Order Received', 'Order Confirmed', 'Shipped', 'Delivered'];
const PAID = new Set(['paid', 'completed']);
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------- Helpers ---------------- */

const normalizeEmail = v => String(v || '').trim().toLowerCase();
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hasPaperback = order => (order.items || []).some(isPaperbackItem);
const newId = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

function generateOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `SKS-${date}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function skuId(prefix, title) {
  const slug = String(title || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'book';
  return `book_${slug}_${crypto.randomBytes(3).toString('hex')}_${prefix === 'pb' ? 'pb' : 'eb'}`;
}

function validateMarketplaceUrl(value, allowedHosts, label) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} must be a valid URL.`); }
  if (parsed.protocol !== 'https:' || !allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
    throw new Error(`${label} must be an HTTPS URL on an approved ${label} domain.`);
  }
  return parsed.toString();
}

function parseTrailers(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/\r?\n/);
  return [...new Set(list.map(v => String(v || '').trim()).filter(Boolean).map(v => {
    let u;
    try { u = new URL(v); } catch { throw new Error('Each trailer must be a valid YouTube URL.'); }
    const ok = u.protocol === 'https:' && (u.hostname === 'youtu.be' || u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com') || u.hostname === 'www.youtube-nocookie.com');
    if (!ok) throw new Error('Trailer links must be YouTube URLs.');
    return u.toString();
  }))];
}

// Serialises work per key (e.g. one payment verification per order at a time).
function keyedLock() {
  const chains = new Map();
  return (key, fn) => {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return run;
  };
}

/* ---------------- App ---------------- */

function createApp({ store, razorpay, mailer, env = process.env, getAccessToken = getGoogleAccessToken, log = console }) {
  const { orders, sales, books, prices } = store;
  const app = express();
  const withOrderLock = keyedLock();
  const sessionSecret = env.SESSION_SECRET || env.RAZORPAY_KEY_SECRET;
  const mailConfigured = () => Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM);

  app.use(express.json({ limit: '10mb' }));
  app.use(cors());

  app.get('/api/health', (req, res) => res.json({ status: store.db.ready ? 'ok' : 'starting', storage: 'google-sheets' }));

  // Every other route needs the Sheet to be loaded.
  app.use('/api', (req, res, next) => {
    if (store.db.ready) return next();
    return res.status(503).json({ error: 'The store is starting up. Please try again in a moment.' });
  });

  /* ----- Auth ----- */

  function requireAdmin(req, res, next) {
    const expectedToken = env.ADMIN_TOKEN;
    if (!expectedToken) return res.status(503).json({ error: 'Admin access is not configured.' });
    const header = req.headers.authorization || '';
    const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(expectedToken);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ error: 'Unauthorized admin access.' });
    }
    next();
  }

  function makeEbookToken(email) {
    const payload = Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString('base64url');
    const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function requireEbookSession(req, res, next) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const parts = token.split('.');
    if (parts.length !== 2) return res.status(401).json({ error: 'Please log in again to access your e-books.' });
    const expected = Buffer.from(crypto.createHmac('sha256', sessionSecret).update(parts[0]).digest('base64url'));
    const supplied = Buffer.from(parts[1]);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ error: 'Invalid session. Please log in again.' });
    }
    try {
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (!payload.email || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
        return res.status(401).json({ error: 'Your session expired. Please log in again.' });
      }
      req.ebookEmail = normalizeEmail(payload.email);
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid session. Please log in again.' });
    }
  }

  /* ----- Catalogue & prices ----- */

  function catalogBooks(includeUnpublished = false) {
    return books.find(b => includeUnpublished || b.published !== false)
      .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
        (a.createdAt?.getTime?.() || 0) - (b.createdAt?.getTime?.() || 0));
  }

  // One price row per SKU; missing rows are created from the book's list price.
  async function pricedBooks() {
    const skus = catalogBooks(true).flatMap(book => [
      { id: book.pbId, name: `${book.title} (Paperback)`, type: 'Paperback', price: Number(book.pbPrice) || 0, bookCatalogId: book.id },
      { id: book.ebId, name: `${book.title} (E-Book)`, type: 'E-Book', price: Number(book.ebPrice) || 0, bookCatalogId: book.id }
    ]);
    const missing = skus.filter(s => !prices.get(s.id));
    if (missing.length) {
      await prices.ensureMany(missing.map(s => ({ bookId: s.id, name: s.name, type: s.type, mrp: s.price, currentPrice: s.price, updatedAt: new Date() })));
    }
    return skus.map(s => {
      const p = prices.get(s.id) || { mrp: s.price, currentPrice: s.price };
      return { ...s, mrp: p.mrp, currentPrice: p.currentPrice, price: p.currentPrice, updatedAt: p.updatedAt };
    });
  }

  function ebookConfig(bookId) {
    const book = books.findOne(b => b.ebId === bookId);
    if (!book || !(book.ebookDriveFileId || book.ebookEpubDriveFileId)) return null;
    return { title: book.title || 'E-book', driveFileId: book.ebookDriveFileId || '', epubDriveFileId: book.ebookEpubDriveFileId || '' };
  }

  function purchasedEbooks(order) {
    const ids = [...new Set((order.items || []).map(i => String(i.id || '')))];
    return ids.map(id => ({ id, config: ebookConfig(id) }))
      .filter(x => x.config)
      .map(x => ({ id: x.id, title: x.config.title, hasEpub: Boolean(x.config.epubDriveFileId) }));
  }

  app.get('/api/catalog', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const priceMap = new Map((await pricedBooks()).map(p => [p.id, p]));
      return res.json(catalogBooks(false).map(b => {
        const pb = priceMap.get(b.pbId);
        const eb = priceMap.get(b.ebId);
        return {
          id: b.id, title: b.title, desc: b.desc, image: b.image, pbId: b.pbId, ebId: b.ebId,
          sampleTitle: b.sampleTitle, sampleSubtitle: b.sampleSubtitle, sampleText: b.sampleText,
          series: b.series || '', sortOrder: Number(b.sortOrder) || 0,
          amazonUrl: b.amazonUrl || '', flipkartUrl: b.flipkartUrl || '', pothiUrl: b.pothiUrl || '',
          sellPaperback: b.sellPaperback !== false, sellEbook: b.sellEbook !== false,
          trailers: b.trailers || [],
          pbPrice: pb?.currentPrice ?? b.pbPrice, pbMrp: pb?.mrp ?? b.pbPrice,
          ebPrice: eb?.currentPrice ?? b.ebPrice, ebMrp: eb?.mrp ?? b.ebPrice,
          published: b.published !== false
        };
      }));
    } catch (error) {
      log.error('Public catalogue error:', error);
      return res.status(500).json({ error: 'Could not load the book catalogue.' });
    }
  });

  const sellableIds = () => new Set(catalogBooks(false).flatMap(b => [
    ...(b.sellPaperback === false ? [] : [b.pbId]),
    ...(b.sellEbook === false ? [] : [b.ebId])
  ]));

  app.get('/api/books', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const visible = sellableIds();
      return res.json((await pricedBooks()).filter(b => visible.has(b.id)));
    } catch (error) {
      log.error('Book price fetch error:', error);
      return res.status(500).json({ error: 'Could not load current book prices.' });
    }
  });

  app.get('/api/admin/books', requireAdmin, async (req, res) => {
    try {
      const map = new Map((await pricedBooks()).map(p => [p.id, p]));
      return res.json(catalogBooks(true).map(b => ({
        ...b, _id: b.id,
        pbPrice: map.get(b.pbId)?.currentPrice ?? b.pbPrice, ebPrice: map.get(b.ebId)?.currentPrice ?? b.ebPrice,
        pbMrp: map.get(b.pbId)?.mrp ?? b.pbPrice, ebMrp: map.get(b.ebId)?.mrp ?? b.ebPrice
      })));
    } catch (error) {
      log.error('Admin catalogue list error:', error);
      return res.status(500).json({ error: 'Could not load the catalogue.' });
    }
  });

  async function saveCatalogBook(req, res, existing = null) {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    let amazonUrl, flipkartUrl, pothiUrl, trailers;
    try {
      amazonUrl = validateMarketplaceUrl(body.amazonUrl ?? existing?.amazonUrl, ['amazon.in', 'amazon.com', 'amazon.co.uk', 'amazon.ca', 'amazon.com.au'], 'Amazon URL');
      flipkartUrl = validateMarketplaceUrl(body.flipkartUrl ?? existing?.flipkartUrl, ['flipkart.com'], 'Flipkart URL');
      pothiUrl = validateMarketplaceUrl(body.pothiUrl ?? existing?.pothiUrl, ['pothi.com'], 'Pothi URL');
      trailers = parseTrailers(body.trailers === undefined ? (existing?.trailers || []) : body.trailers);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const pbPrice = Number(body.pbPrice);
    const ebPrice = Number(body.ebPrice);
    if (!title) return res.status(400).json({ error: 'Book title is required.' });
    if (!Number.isFinite(pbPrice) || pbPrice < 0 || !Number.isFinite(ebPrice) || ebPrice < 0) {
      return res.status(400).json({ error: 'Paperback and e-book prices must be valid non-negative amounts.' });
    }
    const pbId = existing ? existing.pbId : String(body.pbId || skuId('pb', title));
    const ebId = existing ? existing.ebId : String(body.ebId || skuId('eb', title));
    if (!existing && books.findOne(b => [b.pbId, b.ebId].includes(pbId) || [b.pbId, b.ebId].includes(ebId))) {
      return res.status(409).json({ error: 'Generated book SKU conflict. Please try again.' });
    }
    const flag = (value, fallback) => (value === undefined ? fallback : value !== false && value !== 'false');
    const sellPaperback = flag(body.sellPaperback, existing?.sellPaperback !== false);
    const sellEbook = flag(body.sellEbook, existing?.sellEbook !== false);
    if (!sellPaperback && !sellEbook) return res.status(400).json({ error: 'Choose at least one format to sell: paperback or e-book.' });

    const nextOrder = existing ? Number(existing.sortOrder) || 0
      : Math.max(-1, ...books.all().map(b => Number(b.sortOrder) || 0)) + 1;
    const now = new Date();
    const values = {
      id: existing ? existing.id : newId('bk'),
      title, desc: String(body.desc || '').trim(), image: String(body.image || '').trim(),
      pbId, ebId, pbPrice, ebPrice, amazonUrl, flipkartUrl, pothiUrl,
      sampleTitle: String(body.sampleTitle || title).trim(),
      sampleSubtitle: String(body.sampleSubtitle || 'Sample Chapter Preview').trim(),
      sampleText: String(body.sampleText || '').trim(),
      ebookDriveFileId: String(body.ebookDriveFileId ?? existing?.ebookDriveFileId ?? '').trim(),
      ebookEpubDriveFileId: String(body.ebookEpubDriveFileId ?? existing?.ebookEpubDriveFileId ?? '').trim(),
      sellPaperback, sellEbook, trailers,
      series: String(body.series ?? existing?.series ?? '').trim().slice(0, 100),
      sortOrder: Number.isFinite(Number(body.sortOrder)) && body.sortOrder !== '' && body.sortOrder != null ? Number(body.sortOrder) : nextOrder,
      published: body.published !== false && body.published !== 'false',
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    const saved = existing ? await books.update(existing.id, () => values) : await books.insert(values);
    // Keep MRP at least the new list price; seed price rows for new SKUs.
    for (const [bookId, price, type] of [[pbId, pbPrice, 'Paperback'], [ebId, ebPrice, 'E-Book']]) {
      const old = prices.get(bookId);
      await prices.upsert({
        bookId, name: `${title} (${type})`, type,
        mrp: Math.max(Number(old?.mrp) || 0, price), currentPrice: price, updatedAt: now
      });
    }
    return res.json({ success: true, message: existing ? 'Book updated.' : 'Book added.', book: { ...saved, _id: saved.id } });
  }

  app.post('/api/admin/books', requireAdmin, async (req, res) => {
    try { return await saveCatalogBook(req, res); }
    catch (error) { log.error('Add book error:', error); return res.status(500).json({ error: 'Could not add book.' }); }
  });

  app.put('/api/admin/books/order', requireAdmin, async (req, res) => {
    try {
      const ids = req.body?.order;
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())) {
        return res.status(400).json({ error: 'Provide an ordered array of book IDs.' });
      }
      const currentIds = new Set(books.all().map(b => b.id));
      if (ids.length !== currentIds.size || new Set(ids).size !== ids.length || ids.some(id => !currentIds.has(id))) {
        return res.status(400).json({ error: 'The order must include every catalogue book exactly once. Refresh and try again.' });
      }
      const now = new Date();
      await books.updateMany(ids.map((id, index) => ({ key: id, patch: { sortOrder: index, updatedAt: now } })));
      return res.json({ success: true, message: 'Book order saved.', order: ids });
    } catch (error) {
      log.error('Save book order error:', error);
      return res.status(500).json({ error: 'Could not save the book order.' });
    }
  });

  app.put('/api/admin/books/:id', requireAdmin, async (req, res) => {
    try {
      const existing = books.get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Book not found.' });
      return await saveCatalogBook(req, res, existing);
    } catch (error) { log.error('Edit book error:', error); return res.status(500).json({ error: 'Could not update book.' }); }
  });

  // Soft delete: hide from the store without breaking old orders.
  app.delete('/api/admin/books/:id', requireAdmin, async (req, res) => {
    try {
      if (!books.get(req.params.id)) return res.status(404).json({ error: 'Book not found.' });
      await books.update(req.params.id, { published: false, updatedAt: new Date() });
      return res.json({ success: true, message: 'Book unpublished. Existing orders remain intact.' });
    } catch (error) { log.error('Unpublish book error:', error); return res.status(500).json({ error: 'Could not unpublish book.' }); }
  });

  app.post('/api/admin/upload-cover', requireAdmin, async (req, res) => {
    try {
      const match = String(req.body?.dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return res.status(400).json({ error: 'Choose a PNG, JPG, WEBP, or GIF image.' });
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > 7 * 1024 * 1024) return res.status(400).json({ error: 'Cover image must be under 7 MB.' });
      const folderId = String(env.GOOGLE_DRIVE_IMAGES_FOLDER_ID || '').trim();
      if (!folderId) return res.status(503).json({ error: 'Set GOOGLE_DRIVE_IMAGES_FOLDER_ID on Render to enable image uploads.' });
      const accessToken = await getAccessToken();
      const filename = String(req.body?.filename || `book-cover-${Date.now()}`).replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 100);
      const boundary = `sks_${crypto.randomBytes(12).toString('hex')}`;
      const metadata = JSON.stringify({ name: filename, mimeType: match[1], parents: [folderId] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${match[1]}\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--`)
      ]);
      const upload = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType', {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length) }, body
      });
      const uploaded = await upload.json();
      if (!upload.ok || !uploaded.id) throw new Error(uploaded.error?.message || 'Google Drive image upload failed.');
      const permission = await fetch(`https://www.googleapis.com/drive/v3/files/${uploaded.id}/permissions`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'anyone', role: 'reader' })
      });
      if (!permission.ok) throw new Error('Image uploaded, but Google Drive could not make the image public. Check folder sharing and Drive API settings.');
      return res.json({ success: true, fileId: uploaded.id, image: `https://drive.google.com/thumbnail?id=${uploaded.id}&sz=w1200`, message: 'Cover image uploaded.' });
    } catch (error) {
      log.error('Cover upload error:', error.message);
      return res.status(500).json({ error: error.message || 'Could not upload cover image.' });
    }
  });

  app.get('/api/admin/prices', requireAdmin, async (req, res) => {
    try { return res.json(await pricedBooks()); }
    catch (error) { log.error('Admin price fetch error:', error); return res.status(500).json({ error: 'Could not load book prices.' }); }
  });

  app.put('/api/admin/prices', requireAdmin, async (req, res) => {
    try {
      const list = req.body?.prices;
      if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'Provide a list of book prices.' });
      const known = new Map((await pricedBooks()).map(b => [b.id, b]));
      for (const entry of list) {
        const mrp = Number(entry.mrp);
        const currentPrice = Number(entry.currentPrice);
        if (!known.has(entry.bookId)) return res.status(400).json({ error: `Unknown book ID: ${entry.bookId}` });
        if (!Number.isFinite(mrp) || !Number.isFinite(currentPrice) || mrp < 0 || currentPrice < 0 || currentPrice > mrp) {
          return res.status(400).json({ error: 'Prices must be valid non-negative amounts, and current price cannot exceed MRP.' });
        }
      }
      const now = new Date();
      await prices.updateMany(list.map(entry => ({ key: entry.bookId, patch: { mrp: Number(entry.mrp), currentPrice: Number(entry.currentPrice), updatedAt: now } })));
      return res.json({ success: true, message: 'Book prices saved.', prices: await pricedBooks() });
    } catch (error) {
      log.error('Admin price update error:', error);
      return res.status(500).json({ error: 'Could not save book prices.' });
    }
  });

  /* ----- Orders ----- */

  const paidOrders = () => orders.find(o => PAID.has(o.status))
    .sort((a, b) => (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0));

  // Write one Sales row per book once an order is paid/completed.
  const recordSales = order => sales.ensureMany(salesRows(order));

  app.get('/api/orders', requireAdmin, (req, res) => {
    try {
      return res.json(paidOrders().map(o => ({ ...o, _id: o.orderNumber })));
    } catch (error) {
      log.error('Admin orders error:', error);
      return res.status(500).json({ error: 'Failed to fetch orders.' });
    }
  });

  app.patch('/api/orders/:orderNumber/fulfillment', requireAdmin, async (req, res) => {
    try {
      const { fulfillmentStatus, courierName = '', trackingNumber = '', trackingUrl = '' } = req.body || {};
      if (!FULFILLMENT_STAGES.includes(fulfillmentStatus)) return res.status(400).json({ error: 'Invalid fulfilment status.' });
      return await withOrderLock(req.params.orderNumber, async () => {
        const order = orders.findOne(o => o.orderNumber === req.params.orderNumber && PAID.has(o.status));
        if (!order) return res.status(404).json({ error: 'Paid order not found.' });
        if (!hasPaperback(order)) {
          if (order.fulfillmentStatus !== 'Digital Delivery') await orders.update(order.orderNumber, { fulfillmentStatus: 'Digital Delivery', updatedAt: new Date() });
          return res.status(400).json({ error: 'This order contains no paperback items; shipping status is not applicable.' });
        }
        if (['Shipped', 'In Transit', 'Delivered'].includes(fulfillmentStatus) && (!String(courierName).trim() || !String(trackingNumber).trim())) {
          return res.status(400).json({ error: 'Courier name and tracking number are required for Shipped, In Transit, and Delivered.' });
        }
        const stored = order.fulfillmentStatus || 'Order Received';
        const previous = stored === 'In Transit' ? 'Shipped' : stored;
        const oldIndex = FULFILLMENT_STAGES.indexOf(previous);
        const newIndex = FULFILLMENT_STAGES.indexOf(fulfillmentStatus);
        if (newIndex < oldIndex || newIndex > oldIndex + 1) {
          return res.status(400).json({ error: `Move status one step at a time. Current status: ${previous}.` });
        }
        const now = new Date();
        const updated = await orders.update(order.orderNumber, o => ({
          ...o,
          fulfillmentStatus,
          courierName: String(courierName).trim(),
          trackingNumber: String(trackingNumber).trim(),
          trackingUrl: String(trackingUrl).trim(),
          fulfillmentHistory: [...(o.fulfillmentHistory || []), { status: fulfillmentStatus, at: now.toISOString(), courierName: String(courierName).trim(), trackingNumber: String(trackingNumber).trim() }],
          updatedAt: now
        }));
        return res.json({ success: true, order: {
          orderNumber: updated.orderNumber, fulfillmentStatus: updated.fulfillmentStatus, courierName: updated.courierName,
          trackingNumber: updated.trackingNumber, trackingUrl: updated.trackingUrl, fulfillmentHistory: updated.fulfillmentHistory
        } });
      });
    } catch (error) {
      log.error('Fulfilment update error:', error);
      return res.status(500).json({ error: 'Could not update order fulfilment.' });
    }
  });

  app.post('/api/order-status', (req, res) => {
    try {
      const orderNumber = String(req.body?.orderNumber || '').trim();
      const email = normalizeEmail(req.body?.email);
      if (!orderNumber || !email) return res.status(400).json({ error: 'Order number and email are required.' });
      const order = orders.findOne(o => o.orderNumber === orderNumber && o.customerEmail === email && PAID.has(o.status));
      if (!order) return res.status(404).json({ error: 'No completed order matched that order number and email.' });
      const physical = hasPaperback(order);
      return res.json({
        orderNumber: order.orderNumber, items: order.items, amountTotal: order.amountTotal, createdAt: order.createdAt,
        fulfillmentStatus: physical ? (order.fulfillmentStatus || 'Order Received') : 'Digital Delivery',
        courierName: physical ? order.courierName : '', trackingNumber: physical ? order.trackingNumber : '',
        trackingUrl: physical ? order.trackingUrl : '', fulfillmentHistory: physical ? order.fulfillmentHistory : []
      });
    } catch (error) {
      log.error('Customer order lookup error:', error);
      return res.status(500).json({ error: 'Could not look up order status.' });
    }
  });

  /* ----- E-books ----- */

  // OTP codes are short-lived, so they are kept in memory rather than in the Sheet.
  const otps = new Map();
  const otpKey = (orderNumber, email) => `${orderNumber}|${email}`;
  const hashOtp = (orderNumber, email, otp) => crypto.createHmac('sha256', sessionSecret).update(`${orderNumber}:${email}:${otp}`).digest('hex');

  app.post('/api/ebooks/request-otp', async (req, res) => {
    try {
      const orderNumber = String(req.body?.orderNumber || '').trim();
      const email = normalizeEmail(req.body?.email);
      if (!orderNumber || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid order ID and purchase email.' });
      const order = orders.findOne(o => o.orderNumber === orderNumber && o.customerEmail === email && PAID.has(o.status));
      if (!order) return res.status(404).json({ error: 'No completed order matched that order ID and email.' });
      if (!purchasedEbooks(order).length) return res.status(403).json({ error: 'This order does not contain an e-book.' });
      if (!mailConfigured()) return res.status(503).json({ error: 'Email OTP is not configured. Please contact the store administrator.' });
      const key = otpKey(orderNumber, email);
      const record = otps.get(key);
      if (record && !record.usedAt && Date.now() - record.lastSentAt < 60_000) {
        return res.status(429).json({ error: 'Please wait one minute before requesting another code.' });
      }
      const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      otps.set(key, { otpHash: hashOtp(orderNumber, email, otp), expiresAt: Date.now() + 10 * 60_000, attempts: 0, usedAt: null, lastSentAt: Date.now() });
      await mailer.sendMail({
        from: env.MAIL_FROM, to: email,
        subject: 'Your Sai Krishna Author Store verification code',
        text: `Your e-book access verification code is ${otp}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>Sai Krishna Author Store</h2><p>Use this one-time code to access your purchased e-book:</p><p style="font-size:30px;font-weight:bold;letter-spacing:8px">${otp}</p><p>This code expires in 10 minutes. Do not share it with anyone.</p></div>`
      });
      return res.json({ success: true, message: 'A 6-digit verification code has been sent to your purchase email.' });
    } catch (error) {
      log.error('E-book OTP request error:', error.message);
      return res.status(500).json({ error: 'Could not send the verification code. Please try again.' });
    }
  });

  app.post('/api/ebooks/verify-otp', (req, res) => {
    try {
      const orderNumber = String(req.body?.orderNumber || '').trim();
      const email = normalizeEmail(req.body?.email);
      const otp = String(req.body?.otp || '').trim();
      if (!orderNumber || !EMAIL_RE.test(email) || !/^\d{6}$/.test(otp)) {
        return res.status(400).json({ error: 'Enter the order ID, purchase email and 6-digit code.' });
      }
      const record = otps.get(otpKey(orderNumber, email));
      if (!record || record.usedAt || record.expiresAt < Date.now() || record.attempts >= 5) {
        return res.status(401).json({ error: 'The code is invalid or expired. Request a new code.' });
      }
      const expected = Buffer.from(record.otpHash, 'hex');
      const supplied = Buffer.from(hashOtp(orderNumber, email, otp), 'hex');
      if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
        record.attempts += 1;
        return res.status(401).json({ error: `Incorrect code. ${Math.max(0, 5 - record.attempts)} attempt(s) remaining.` });
      }
      record.usedAt = Date.now();
      const order = orders.findOne(o => o.orderNumber === orderNumber && o.customerEmail === email && PAID.has(o.status));
      if (!order) return res.status(404).json({ error: 'The order is no longer available.' });
      const ebooks = purchasedEbooks(order);
      if (!ebooks.length) return res.status(403).json({ error: 'This order does not contain an e-book.' });
      return res.json({ success: true, token: makeEbookToken(email), email, ebooks });
    } catch (error) {
      log.error('E-book OTP verification error:', error.message);
      return res.status(500).json({ error: 'Could not verify the code. Please try again.' });
    }
  });

  function ebooksForEmail(email) {
    const unique = new Map();
    for (const order of orders.find(o => o.customerEmail === email && PAID.has(o.status))) {
      for (const book of purchasedEbooks(order)) unique.set(book.id, book);
    }
    return [...unique.values()];
  }

  app.post('/api/ebooks/access', (req, res) => {
    try {
      const orderNumber = String(req.body?.orderNumber || '').trim();
      const email = normalizeEmail(req.body?.email);
      if (!orderNumber || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid order ID and purchase email.' });
      const match = orders.findOne(o => o.orderNumber === orderNumber && o.customerEmail === email && PAID.has(o.status));
      if (!match) return res.status(401).json({ error: 'Invalid Order ID or purchase email.' });
      const ebooks = ebooksForEmail(email);
      if (!ebooks.length) return res.status(403).json({ error: 'No purchased e-books were found for this email.' });
      return res.json({ success: true, token: makeEbookToken(email), email, ebooks });
    } catch (error) {
      log.error('E-book access error:', error.message);
      return res.status(500).json({ error: 'Could not verify your order. Please try again.' });
    }
  });

  app.get('/api/ebooks', requireEbookSession, (req, res) => {
    try {
      return res.json({ email: req.ebookEmail, ebooks: ebooksForEmail(req.ebookEmail) });
    } catch (error) {
      log.error('E-book list error:', error.message);
      return res.status(500).json({ error: 'Could not load your e-books.' });
    }
  });

  async function streamEbook(req, res, format) {
    const bookId = req.params.bookId;
    const config = ebookConfig(bookId);
    const fileId = format === 'epub' ? config?.epubDriveFileId : config?.driveFileId;
    if (!fileId) return res.status(404).json({ error: format === 'epub' ? 'EPUB edition is not configured for this book.' : 'E-book not found.' });
    const owns = orders.findOne(o => o.customerEmail === req.ebookEmail && PAID.has(o.status) && (o.items || []).some(i => i.id === bookId));
    if (!owns) return res.status(403).json({ error: 'This e-book is not included in your eligible orders.' });
    const accessToken = await getAccessToken();
    const upstream = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!upstream.ok) {
      log.error(`Google Drive ${format} fetch failed:`, upstream.status, (await upstream.text()).slice(0, 500));
      return res.status(502).json({ error: `Could not load this ${format === 'epub' ? 'EPUB' : 'e-book'}. Please contact the store administrator.` });
    }
    res.setHeader('Content-Type', format === 'epub' ? 'application/epub+zip' : 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="reading-copy.${format}"`);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    if (upstream.body) {
      const { Readable } = require('node:stream');
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  }

  for (const format of ['pdf', 'epub']) {
    app.get(`/api/ebooks/:bookId/${format}`, requireEbookSession, async (req, res) => {
      try {
        await streamEbook(req, res, format);
      } catch (error) {
        log.error(`Protected e-book ${format} error:`, error.message);
        const status = /not configured|valid JSON/.test(error.message) ? 503 : 500;
        if (!res.headersSent) res.status(status).json({ error: status === 503 ? 'Private Google Drive access is not configured on the backend.' : 'Could not load this e-book.' });
      }
    });
  }

  app.get('/api/ebooks/session', requireEbookSession, (req, res) => res.json({ success: true, email: req.ebookEmail }));

  /* ----- Checkout ----- */

  function sendMailInBackground(order, subject, html, label) {
    void (async () => {
      try {
        if (!mailConfigured()) throw new Error('SMTP environment variables are incomplete.');
        await mailer.sendMail({ from: env.MAIL_FROM, to: order.customerEmail, subject, html });
        await orders.update(order.orderNumber, { confirmationEmailSentAt: new Date() });
        log.log(`${label} email sent:`, order.orderNumber);
      } catch (error) {
        log.error(`${label} email failed:`, error.message);
      }
    })();
  }

  app.post('/api/create-order', async (req, res) => {
    try {
      const customerEmail = normalizeEmail(req.body?.customerEmail);
      const items = req.body?.items;
      const raw = req.body?.shippingAddress;
      const shippingAddress = raw && typeof raw === 'object'
        ? { address: String(raw.address || '').trim().slice(0, 300), city: String(raw.city || '').trim().slice(0, 100), pincode: String(raw.pincode || '').trim().slice(0, 20) }
        : null;
      if (!EMAIL_RE.test(customerEmail) || !Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'Valid email and non-empty cart are required.' });
      }
      const visible = sellableIds();
      const priced = (await pricedBooks()).filter(b => visible.has(b.id));
      let totalRupees = 0;
      const verifiedItems = [];
      for (const item of items) {
        const book = priced.find(b => b.id === item?.id);
        if (!book) return res.status(400).json({ error: `Invalid book ID: ${item?.id}` });
        const quantity = Number(item.quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return res.status(400).json({ error: `Invalid quantity for ${book.name}` });
        totalRupees += book.currentPrice * quantity;
        verifiedItems.push({ id: book.id, name: book.name, price: book.currentPrice, mrp: book.mrp, quantity, type: book.type });
      }
      const physical = verifiedItems.some(isPaperbackItem);
      if (physical && !(shippingAddress && shippingAddress.address && shippingAddress.city && shippingAddress.pincode)) {
        return res.status(400).json({ error: 'A shipping address is required for paperback orders.' });
      }
      const fulfillmentStatus = physical ? 'Order Received' : 'Digital Delivery';
      const orderNumber = generateOrderNumber();
      const now = new Date();

      if (totalRupees === 0) {
        const order = await orders.insert({
          orderNumber, createdAt: now, updatedAt: now, status: 'completed', customerEmail,
          items: verifiedItems, amountTotal: 0, shippingAddress: physical ? shippingAddress : null, fulfillmentStatus,
          fulfillmentHistory: [{ status: fulfillmentStatus, at: now.toISOString() }]
        });
        await recordSales(order);
        sendMailInBackground(order, 'Your Free Book Order - Sai Krishna Author Store', `
          <h2>Your order is confirmed!</h2>
          <p>This order was free, so no payment was required.</p>
          <p><strong>Order Number:</strong> ${escapeHtml(order.orderNumber)}</p>
          <h3>Books in your order</h3>
          <ul>${order.items.map(i => `<li>${escapeHtml(i.name)} — Qty: ${i.quantity} — FREE</li>`).join('')}</ul>
          <p>For e-books, visit the store's e-book page and use this order number with this email address.</p>
          <p>Thank you for supporting Sai Krishna Author Store.</p>`, 'Free-order confirmation');
        return res.json({ success: true, freeOrder: true, orderNumber, emailSent: false, amount: 0, currency: 'INR' });
      }

      const razorpayOrder = await razorpay.orders.create({ amount: Math.round(totalRupees * 100), currency: 'INR', receipt: `rcpt_${Date.now()}` });
      await orders.insert({
        orderNumber, createdAt: now, updatedAt: now, status: 'created', customerEmail,
        items: verifiedItems, amountTotal: totalRupees, razorpayOrderId: razorpayOrder.id,
        shippingAddress: physical ? shippingAddress : null, fulfillmentStatus: '', fulfillmentHistory: []
      });
      return res.json({ orderId: razorpayOrder.id, orderNumber, amount: razorpayOrder.amount, currency: razorpayOrder.currency, keyId: env.RAZORPAY_KEY_ID });
    } catch (error) {
      log.error('Order creation error:', error);
      return res.status(500).json({ error: 'Failed to create order.' });
    }
  });

  app.post('/api/verify-payment', async (req, res) => {
    try {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Missing payment verification parameters.' });
      }
      const generated = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
      const received = Buffer.from(String(razorpay_signature), 'hex');
      const expected = Buffer.from(generated, 'hex');
      if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        return res.status(400).json({ success: false, message: 'Invalid payment signature.' });
      }
      const found = orders.findOne(o => o.razorpayOrderId === razorpay_order_id);
      if (!found) return res.status(404).json({ success: false, message: 'Order not found.' });

      return await withOrderLock(found.orderNumber, async () => {
        let order = orders.get(found.orderNumber);
        if (order.status === 'paid' || order.status === 'completed') {
          if (order.razorpayPaymentId !== razorpay_payment_id) {
            return res.status(409).json({ success: false, message: 'This order is already associated with another payment.' });
          }
        } else {
          const now = new Date();
          const fulfillmentStatus = hasPaperback(order) ? 'Order Received' : 'Digital Delivery';
          order = await orders.update(order.orderNumber, {
            status: 'paid', razorpayPaymentId: razorpay_payment_id, fulfillmentStatus,
            fulfillmentHistory: [{ status: fulfillmentStatus, at: now.toISOString() }], updatedAt: now
          });
        }
        await recordSales(order);

        let emailSent = Boolean(order.confirmationEmailSentAt);
        if (!emailSent) {
          try {
            if (!mailConfigured()) throw new Error('SMTP environment variables are incomplete.');
            await mailer.sendMail({
              from: env.MAIL_FROM, to: order.customerEmail,
              subject: 'Order Confirmation - Sai Krishna Author Store',
              html: `
                <h2>Thank you for your order!</h2>
                <p>Your payment has been verified successfully.</p>
                <p><strong>Order Number:</strong> ${escapeHtml(order.orderNumber)}</p>
                <p><strong>Payment ID:</strong> ${escapeHtml(razorpay_payment_id)}</p>
                <h3>Purchased Items</h3>
                <ul>${order.items.map(i => `<li>${escapeHtml(i.name)} — Qty: ${i.quantity}, ₹${(Number(i.price) || 0) * (Number(i.quantity) || 1)}</li>`).join('')}</ul>
                <p>Thank you for supporting Sai Krishna Author Store.</p>`
            });
            await orders.update(order.orderNumber, { confirmationEmailSentAt: new Date() });
            emailSent = true;
          } catch (error) {
            log.error('Confirmation email failed:', error.message);
          }
        }
        return res.json({ success: true, message: 'Payment verified successfully.', orderNumber: order.orderNumber, emailSent });
      });
    } catch (error) {
      log.error('Payment verification error:', error);
      return res.status(500).json({ success: false, message: 'Payment verification encountered a server error.' });
    }
  });

  app.use((err, req, res, next) => {
    log.error('Unhandled server error:', err.stack || err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}

/* ---------------- Start-up ---------------- */

// Create the Books/Prices rows the first time the store starts with an empty Sheet.
async function seedIfEmpty(store) {
  if (store.books.count() > 0) return;
  const now = new Date();
  await store.books.insertMany(BOOK_CATALOG_DEFAULTS.map((b, i) => ({
    id: `bk_default_${i + 1}`, ...b, series: '', sortOrder: i, published: true, sellPaperback: true, sellEbook: true,
    trailers: [], ebookEpubDriveFileId: '', amazonUrl: '', flipkartUrl: '', pothiUrl: '', createdAt: now, updatedAt: now
  })));
}

async function start() {
  for (const name of ['GOOGLE_SHEETS_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']) {
    if (!process.env[name]) {
      console.error(`FATAL: missing required environment variable ${name}`);
      process.exit(1);
    }
  }
  const Razorpay = require('razorpay');
  const nodemailer = require('nodemailer');
  const smtpPort = Number(process.env.SMTP_PORT || 465);
  const store = createStore({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, getAccessToken: getGoogleAccessToken });
  const app = createApp({
    store,
    razorpay: new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }),
    mailer: nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: smtpPort, secure: smtpPort === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  });

  const port = process.env.PORT || 5000;
  app.listen(port, () => console.log(`Server running on port ${port}`));

  // Keep retrying until the Sheet is reachable; the API answers 503 meanwhile.
  for (let attempt = 1; ; attempt++) {
    try {
      await store.db.init();
      await seedIfEmpty(store);
      store.db.startAutoRefresh();
      console.log(`Google Sheet loaded: ${store.orders.count()} orders, ${store.books.count()} books.`);
      return;
    } catch (error) {
      const who = serviceAccountEmail();
      console.error(`Could not open the Google Sheet (attempt ${attempt}): ${error.message}` +
        (error.status === 403 || error.status === 404 ? ` — share the Sheet with ${who || 'the service account'} as Editor and enable the Google Sheets API.` : ''));
      await new Promise(r => setTimeout(r, Math.min(60_000, 5_000 * attempt)));
    }
  }
}

if (require.main === module) start();

module.exports = { createApp, seedIfEmpty, BOOK_CATALOG_DEFAULTS };
