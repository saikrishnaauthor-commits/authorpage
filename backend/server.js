require('dotenv').config();

const dns = require("node:dns");

// Use Google DNS for Node.js DNS lookups
dns.setServers(["8.8.8.8", "8.8.4.4"]);


// Validate critical environment variables on startup
const requiredEnv = ['MONGO_URI', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
for (const env of requiredEnv) {
  if (!process.env[env]) {
    console.error(`FATAL ERROR: Missing required environment variable ${env} in .env`);
    process.exit(1);
  }
}

const express = require('express');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const cors = require('cors');

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cors()); // Allows requests from your frontend

// 1. Connect to MongoDB Database
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('MongoDB Connected Successfully'))
.catch(err => {
  console.error('Database connection error:', err);
  process.exit(1);
});

// 2. Define Order Schema & Model
const orderSchema = new mongoose.Schema({
  customerEmail: { type: String, required: true },
  items: { type: Array, required: true },
  amountTotal: { type: Number, required: true },
  razorpayOrderId: { type: String, default: undefined, unique: true, sparse: true },
  razorpayPaymentId: { type: String, default: null },
  status: { type: String, enum: ['created', 'paid', 'completed', 'failed'], default: 'created' },
  createdAt: { type: Date, default: Date.now },
  orderNumber: {type: String,unique: true, sparse: true},
  confirmationEmailSentAt: {type: Date,default: null},
  shippingAddress: { type: mongoose.Schema.Types.Mixed, default: null },
  fulfillmentStatus: { type: String, enum: ['Order Received', 'Order Confirmed', 'Shipped', 'In Transit', 'Delivered', 'Digital Delivery'], default: 'Order Received' },
  courierName: { type: String, default: '' },
  trackingNumber: { type: String, default: '' },
  trackingUrl: { type: String, default: '' },
  fulfillmentHistory: { type: Array, default: [] }
});

const Order = mongoose.model('Order', orderSchema);


function generateOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `SKS-${date}-${suffix}`;
}


function requireAdmin(req, res, next) {
  const expectedToken = process.env.ADMIN_TOKEN;
  const authHeader = req.headers.authorization || '';
  const suppliedToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : '';

  if (!expectedToken) {
    return res.status(503).json({
      error: 'Admin access is not configured.'
    });
  }

  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return res.status(401).json({
      error: 'Unauthorized admin access.'
    });
  }

  next();
}


// Initialize Razorpay Instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Configure Nodemailer Transporter

const smtpPort = Number(process.env.SMTP_PORT || 465);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});


// Author Books Inventory (Synced with catalog.json)
const BOOKS = [
  { id: 'book_1_pb', name: 'KaalYug: Shadows of Dark Web (Paperback)', price: 249, type: 'Paperback' },
  { id: 'book_1_eb', name: 'KaalYug: Shadows of Dark Web (E-Book)', price: 25, type: 'E-Book' },
  { id: 'book_2_pb', name: 'Pages of Us (Paperback)', price: 299, type: 'Paperback' },
  { id: 'book_2_eb', name: 'Pages of Us (E-Book)', price: 25, type: 'E-Book' },
  { id: 'book_3_pb', name: 'The Indestructible Kali (Paperback)', price: 299, type: 'Paperback' },
  { id: 'book_3_eb', name: 'The Indestructible Kali (E-Book)', price: 25, type: 'E-Book' }
];

// Editable catalogue records. Existing SKU IDs are preserved so old carts and orders remain valid.
const BOOK_CATALOG_DEFAULTS = [
  { title: 'KaalYug: Shadows of Dark Web', desc: 'Time is a wheel turning endlessly through eras of light and shadow.', image: 'images/kaalyug.png', pbId: 'book_1_pb', ebId: 'book_1_eb', pbPrice: 249, ebPrice: 25, ebookDriveFileId: '1eRI8rapGCk9WwL7RYd7F2zwBj8ikkbwO', sampleTitle: 'KaalYug', sampleSubtitle: 'Sample Chapter Preview', sampleText: 'The winds of transition whispered through the ancient pillars. Time was never a straight line, but a wheel turning endlessly through eras of light and shadow...', published: true, series: '', sortOrder: 0 },
  { title: 'Pages of Us', desc: 'Raw emotion and human connection folded like dried flowers in a diary.', image: 'images/pages-of-us.png', pbId: 'book_2_pb', ebId: 'book_2_eb', pbPrice: 299, ebPrice: 25, ebookDriveFileId: '1XXBc9In0OiPflwLyRB44fQWu98PGQ0bZ', sampleTitle: 'Pages of Us', sampleSubtitle: 'Sample Chapter Preview', sampleText: 'Some memories are folded like dried flowers between the pages of an old diary. When opened, they release a fragrance of nostalgia that defies distance and years...', published: true, series: '', sortOrder: 1 },
  { title: 'The Indestructible Kali', desc: 'Primal energy, myth, and the ultimate resilience of the cosmos.', image: 'images/kali.jpeg', pbId: 'book_3_pb', ebId: 'book_3_eb', pbPrice: 299, ebPrice: 25, ebookDriveFileId: '1N8lwC2Wm_Qvygq3lrr4q0zl18hmLVvln', sampleTitle: 'The Indestructible Kali', sampleSubtitle: 'Sample Chapter Preview', sampleText: 'Beyond the veil of ordinary perception lies the primal energy that sustains and transforms the cosmos. Unbound by time or form, this force represents ultimate resilience...', published: true, series: '', sortOrder: 2 }
];
const catalogBookSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  desc: { type: String, default: '' },
  image: { type: String, default: '' },
  pbId: { type: String, required: true, unique: true },
  ebId: { type: String, required: true, unique: true },
  pbPrice: { type: Number, default: 0, min: 0 },
  ebPrice: { type: Number, default: 0, min: 0 },
  ebookDriveFileId: { type: String, default: '' },
  amazonUrl: { type: String, default: '' },
  flipkartUrl: { type: String, default: '' },
  pothiUrl: { type: String, default: '' },
  sampleTitle: { type: String, default: '' },
  sampleSubtitle: { type: String, default: 'Sample Chapter Preview' },
  sampleText: { type: String, default: '' },
  series: { type: String, default: '', trim: true, maxlength: 100 },
  sortOrder: { type: Number, default: 0 },
  published: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const CatalogBook = mongoose.models.CatalogBook || mongoose.model('CatalogBook', catalogBookSchema);

async function ensureCatalogSeed() {
  const count = await CatalogBook.countDocuments();
  if (count === 0) {
    await CatalogBook.insertMany(BOOK_CATALOG_DEFAULTS.map((b, index) => ({ ...b, sortOrder: index, updatedAt: new Date() })));
    return;
  }
  // One-time migration for older records that predate sortOrder: preserve their original creation order.
  const existing = await CatalogBook.find({}).sort({ createdAt: 1, _id: 1 }).select('_id sortOrder createdAt').lean();
  if (existing.length > 1 && existing.every(book => book.sortOrder == null || Number(book.sortOrder) === 0)) {
    await Promise.all(existing.map((book, index) => CatalogBook.updateOne({ _id: book._id }, { $set: { sortOrder: index } })));
  }
}
async function getCatalogBooks(includeUnpublished = false) {
  await ensureCatalogSeed();
  const filter = includeUnpublished ? {} : { published: true };
  return CatalogBook.find(filter).sort({ sortOrder: 1, createdAt: 1, _id: 1 }).lean();
}
function skuId(prefix, title) {
  const slug = String(title || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'book';
  return `book_${slug}_${crypto.randomBytes(3).toString('hex')}_${prefix === 'pb' ? 'pb' : 'eb'}`;
}

// Centralized prices: one MongoDB record per paperback/e-book SKU.
const bookPriceSchema = new mongoose.Schema({
  bookId: { type: String, required: true, unique: true },
  mrp: { type: Number, required: true, min: 0 },
  currentPrice: { type: Number, required: true, min: 0 },
  updatedAt: { type: Date, default: Date.now }
});
const BookPrice = mongoose.models.BookPrice || mongoose.model('BookPrice', bookPriceSchema);

async function getPricedBooks() {
  const catalog = await getCatalogBooks(true);
  const result = [];
  for (const book of catalog) {
    for (const item of [
      { id: book.pbId, name: `${book.title} (Paperback)`, type: 'Paperback', price: Number(book.pbPrice) || 0 },
      { id: book.ebId, name: `${book.title} (E-Book)`, type: 'E-Book', price: Number(book.ebPrice) || 0 }
    ]) {
      const price = await BookPrice.findOneAndUpdate(
        { bookId: item.id },
        { $setOnInsert: { mrp: item.price, currentPrice: item.price, updatedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      result.push({ ...item, bookCatalogId: String(book._id), mrp: price.mrp, currentPrice: price.currentPrice, price: price.currentPrice, updatedAt: price.updatedAt });
    }
  }
  console.log(
    'Admin price records:',
    result.map(p => ({
      id: p.id,
      mrp: p.mrp,
      currentPrice: p.currentPrice
  }))
  );
  return result;
}

async function getEbookConfig(bookId) {
  const legacy = EBOOKS && EBOOKS[bookId];
  if (legacy && legacy.driveFileId) return legacy;
  const book = await CatalogBook.findOne({ ebId: bookId }).lean();
  if (!book || !book.ebookDriveFileId) return null;
  return { title: book.title, driveFileId: book.ebookDriveFileId };
}

// 3. API Endpoints

// Public book catalogue for the website.

app.get('/api/catalog', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');

    const [catalog, priced] = await Promise.all([
      getCatalogBooks(false),
      getPricedBooks()
    ]);

    const priceMap = new Map(priced.map(p => [p.id, p]));

    return res.json(catalog.map(b => {
      const paperback = priceMap.get(b.pbId);
      const ebook = priceMap.get(b.ebId);

      return {
        id: String(b._id),
        title: b.title,
        desc: b.desc,
        image: b.image,
        pbId: b.pbId,
        ebId: b.ebId,
        sampleTitle: b.sampleTitle,
        sampleSubtitle: b.sampleSubtitle,
        sampleText: b.sampleText,
        series: b.series || '',
        sortOrder: Number(b.sortOrder) || 0,
        amazonUrl: b.amazonUrl || '',
        flipkartUrl: b.flipkartUrl || '',
        pothiUrl: b.pothiUrl || '',

        // Paperback prices saved in MongoDB
        pbPrice: paperback?.currentPrice ?? b.pbPrice,
        pbMrp: paperback?.mrp ?? b.pbPrice,

        // E-book prices saved in MongoDB
        ebPrice: ebook?.currentPrice ?? b.ebPrice,
        ebMrp: ebook?.mrp ?? b.ebPrice,

        published: b.published
      };
    }));
  } catch (error) {
    console.error('Public catalogue error:', error);
    return res.status(500).json({
      error: 'Could not load the book catalogue.'
    });
  }
});


// Checkout catalogue: flat paperback/e-book SKUs with server-managed prices.
app.get('/api/books', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const visible = await getCatalogBooks(false);
    const visibleIds = new Set(visible.flatMap(b => [b.pbId, b.ebId]));
    return res.json((await getPricedBooks()).filter(b => visibleIds.has(b.id)));
  } catch (error) {
    console.error('Book price fetch error:', error);
    return res.status(500).json({ error: 'Could not load current book prices.' });
  }
});

// Admin: list catalogue records, including unpublished/soft-deleted books.
app.get('/api/admin/books', requireAdmin, async (req, res) => {
  try {
    const books = await getCatalogBooks(true);
    const prices = await getPricedBooks();
    const map = new Map(prices.map(p => [p.id, p]));
    return res.json(books.map(b => ({
      ...b, id: String(b._id), pbPrice: map.get(b.pbId)?.currentPrice ?? b.pbPrice,
      ebPrice: map.get(b.ebId)?.currentPrice ?? b.ebPrice,
      pbMrp: map.get(b.pbId)?.mrp ?? b.pbPrice, ebMrp: map.get(b.ebId)?.mrp ?? b.ebPrice
    })));
  } catch (error) {
    console.error('Admin catalogue list error:', error);
    return res.status(500).json({ error: 'Could not load the catalogue.' });
  }
});

function validateMarketplaceUrl(value, allowedHosts, label) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} must be a valid URL.`); }
  if (parsed.protocol !== 'https:' || !allowedHosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    throw new Error(`${label} must be an HTTPS URL on an approved ${label} domain.`);
  }
  return parsed.toString();
}

async function saveCatalogBook(req, res, existing = null) {
  const body = req.body || {};
  const title = String(body.title || '').trim();
  const desc = String(body.desc || '').trim();
  const image = String(body.image || '').trim();
  let amazonUrl, flipkartUrl, pothiUrl;
  try {
    amazonUrl = validateMarketplaceUrl(body.amazonUrl ?? existing?.amazonUrl, ['amazon.in','amazon.com','amazon.co.uk','amazon.ca','amazon.com.au'], 'Amazon URL');
    flipkartUrl = validateMarketplaceUrl(body.flipkartUrl ?? existing?.flipkartUrl, ['flipkart.com'], 'Flipkart URL');
    pothiUrl = validateMarketplaceUrl(body.pothiUrl ?? existing?.pothiUrl, ['pothi.com'], 'Pothi URL');
  } catch (error) { return res.status(400).json({ error: error.message }); }
  const pbPrice = Number(body.pbPrice);
  const ebPrice = Number(body.ebPrice);
  if (!title) return res.status(400).json({ error: 'Book title is required.' });
  if (!Number.isFinite(pbPrice) || pbPrice < 0 || !Number.isFinite(ebPrice) || ebPrice < 0) {
    return res.status(400).json({ error: 'Paperback and e-book prices must be valid non-negative amounts.' });
  }
  const pbId = existing ? existing.pbId : String(body.pbId || skuId('pb', title));
  const ebId = existing ? existing.ebId : String(body.ebId || skuId('eb', title));
  if (!existing) {
    const collision = await CatalogBook.findOne({ $or: [{ pbId }, { ebId }, { pbId: ebId }, { ebId: pbId }] });
    if (collision) return res.status(409).json({ error: 'Generated book SKU conflict. Please try again.' });
  }
  const nextOrder = existing ? Number(existing.sortOrder) || 0 : ((await CatalogBook.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean())?.sortOrder ?? -1) + 1;
  const values = { title, desc, image, pbId, ebId, pbPrice, ebPrice, amazonUrl, flipkartUrl, pothiUrl,
    sampleTitle: String(body.sampleTitle || title).trim(), sampleSubtitle: String(body.sampleSubtitle || 'Sample Chapter Preview').trim(), sampleText: String(body.sampleText || '').trim(),
    ebookDriveFileId: String(body.ebookDriveFileId || existing?.ebookDriveFileId || '').trim(),
    series: String(body.series ?? existing?.series ?? '').trim().slice(0, 100),
    sortOrder: Number.isFinite(Number(body.sortOrder)) && body.sortOrder !== '' ? Number(body.sortOrder) : nextOrder,
    published: body.published !== false && body.published !== 'false', updatedAt: new Date() };
  const saved = existing
    ? await CatalogBook.findByIdAndUpdate(existing._id, { $set: values }, { new: true, runValidators: true }).lean()
    : await CatalogBook.create(values);
  // Preserve existing price/MRP records; seed price records for new SKUs only.
  for (const [bookId, fallback] of [[pbId, pbPrice], [ebId, ebPrice]]) {
    const oldPrice = await BookPrice.findOne({ bookId }).lean();
    const mrp = Math.max(Number(oldPrice?.mrp) || 0, fallback);
    await BookPrice.findOneAndUpdate(
      { bookId },
      { $set: { currentPrice: fallback, mrp, updatedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  return res.json({ success: true, message: existing ? 'Book updated.' : 'Book added.', book: saved });
}

app.post('/api/admin/books', requireAdmin, async (req, res) => {
  try { return await saveCatalogBook(req, res); }
  catch (error) { console.error('Add book error:', error); return res.status(500).json({ error: 'Could not add book.' }); }
});
app.put('/api/admin/books/order', requireAdmin, async (req, res) => {
  try {
    const ids = req.body?.order;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())) {
      return res.status(400).json({ error: 'Provide an ordered array of book IDs.' });
    }
    const current = await CatalogBook.find({}).select('_id').lean();
    const currentIds = new Set(current.map(book => String(book._id)));
    const submitted = new Set(ids);
    if (ids.length !== currentIds.size || submitted.size !== ids.length || ids.some(id => !currentIds.has(id))) {
      return res.status(400).json({ error: 'The order must include every catalogue book exactly once. Refresh and try again.' });
    }
    await Promise.all(ids.map((id, index) => CatalogBook.updateOne({ _id: id }, { $set: { sortOrder: index, updatedAt: new Date() } })));
    return res.json({ success: true, message: 'Book order saved.', order: ids });
  } catch (error) {
    console.error('Save book order error:', error);
    return res.status(500).json({ error: 'Could not save the book order.' });
  }
});

app.put('/api/admin/books/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await CatalogBook.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Book not found.' });
    return await saveCatalogBook(req, res, existing);
  } catch (error) { console.error('Edit book error:', error); return res.status(500).json({ error: 'Could not update book.' }); }
});
// Soft delete: hide from the public store without breaking old orders/SKUs.
app.delete('/api/admin/books/:id', requireAdmin, async (req, res) => {
  try {
    const book = await CatalogBook.findByIdAndUpdate(req.params.id, { $set: { published: false, updatedAt: new Date() } }, { new: true });
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    return res.json({ success: true, message: 'Book unpublished. Existing orders remain intact.' });
  } catch (error) { console.error('Unpublish book error:', error); return res.status(500).json({ error: 'Could not unpublish book.' }); }
});

// Google Drive cover-image upload. Credentials remain server-side in Render.
app.post('/api/admin/upload-cover', requireAdmin, async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || '');
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'Choose a PNG, JPG, WEBP, or GIF image.' });
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 7 * 1024 * 1024) return res.status(400).json({ error: 'Cover image must be under 7 MB.' });
    const folderId = String(process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID || '').trim();
    if (!folderId) return res.status(503).json({ error: 'Set GOOGLE_DRIVE_IMAGES_FOLDER_ID on Render to enable image uploads.' });
    const accessToken = await getGoogleDriveAccessToken();
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
    console.error('Cover upload error:', error.message);
    return res.status(500).json({ error: error.message || 'Could not upload cover image.' });
  }
});

// Admin: view all centralized MRP/current prices.
app.get('/api/admin/prices', requireAdmin, async (req, res) => {
  try {
    return res.json(await getPricedBooks());
  } catch (error) {
    console.error('Admin price fetch error:', error);
    return res.status(500).json({ error: 'Could not load book prices.' });
  }
});

// Admin: update one or more prices from one screen.
app.put('/api/admin/prices', requireAdmin, async (req, res) => {
  try {
    const prices = req.body?.prices;
    if (!Array.isArray(prices) || prices.length === 0) {
      return res.status(400).json({ error: 'Provide a list of book prices.' });
    }
    const allowedIds = new Set((await getPricedBooks()).map(book => book.id));
    for (const entry of prices) {
      const mrp = Number(entry.mrp);
      const currentPrice = Number(entry.currentPrice);
      if (!allowedIds.has(entry.bookId)) {
        return res.status(400).json({ error: `Unknown book ID: ${entry.bookId}` });
      }
      if (!Number.isFinite(mrp) || !Number.isFinite(currentPrice) ||
          mrp < 0 || currentPrice < 0 || currentPrice > mrp) {
        return res.status(400).json({ error: 'Prices must be valid non-negative amounts, and current price cannot exceed MRP.' });
      }
    }
    const saved = [];
    for (const entry of prices) {
      const doc = await BookPrice.findOneAndUpdate(
        { bookId: entry.bookId },
        { $set: { mrp: Number(entry.mrp), currentPrice: Number(entry.currentPrice), updatedAt: new Date() } },
        { upsert: true, new: true, runValidators: true }
      ).lean();
      saved.push(doc);
    }
    return res.json({ success: true, message: 'Book prices saved.', prices: await getPricedBooks() });
  } catch (error) {
    console.error('Admin price update error:', error);
    return res.status(500).json({ error: 'Could not save book prices.' });
  }
});


// Admin: list paid orders with fulfilment and shipping details.
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find({ status: { $in: ['paid', 'completed'] } })
      .select('customerEmail items amountTotal razorpayOrderId razorpayPaymentId status createdAt orderNumber shippingAddress fulfillmentStatus courierName trackingNumber trackingUrl fulfillmentHistory')
      .sort({ createdAt: -1 })
      .lean();
    return res.json(orders);
  } catch (error) {
    console.error('Admin orders error:', error);
    return res.status(500).json({ error: 'Failed to fetch orders.' });
  }
});

const FULFILLMENT_STAGES = ['Order Received', 'Order Confirmed', 'Shipped', 'Delivered'];
function hasPaperback(order) {
  return (order.items || []).some(item => String(item.type || item.id || '').toLowerCase().includes('paperback') || String(item.id || '').endsWith('_pb'));
}

// Admin: update physical-book fulfilment. Shipment details are mandatory at Shipped.
app.patch('/api/orders/:orderNumber/fulfillment', requireAdmin, async (req, res) => {
  try {
    const { fulfillmentStatus, courierName = '', trackingNumber = '', trackingUrl = '' } = req.body || {};
    if (!FULFILLMENT_STAGES.includes(fulfillmentStatus)) {
      return res.status(400).json({ error: 'Invalid fulfilment status.' });
    }
    const order = await Order.findOne({ orderNumber: req.params.orderNumber, status: { $in: ['paid', 'completed'] } });
    if (!order) return res.status(404).json({ error: 'Paid order not found.' });
    if (!hasPaperback(order)) {
      order.fulfillmentStatus = 'Digital Delivery';
      await order.save();
      return res.status(400).json({ error: 'This order contains no paperback items; shipping status is not applicable.' });
    }
    if (['Shipped', 'In Transit', 'Delivered'].includes(fulfillmentStatus)) {
      if (!String(courierName).trim() || !String(trackingNumber).trim()) {
        return res.status(400).json({ error: 'Courier name and tracking number are required for Shipped, In Transit, and Delivered.' });
      }
    }
    const storedPrevious = order.fulfillmentStatus || 'Order Received';
    const previous = storedPrevious === 'In Transit' ? 'Shipped' : storedPrevious;const oldIndex = FULFILLMENT_STAGES.indexOf(previous);
    const newIndex = FULFILLMENT_STAGES.indexOf(fulfillmentStatus);
    if (newIndex < oldIndex || newIndex > oldIndex + 1) {
      return res.status(400).json({ error: `Move status one step at a time. Current status: ${previous}.` });
    }
    order.fulfillmentStatus = fulfillmentStatus;
    order.courierName = String(courierName).trim();
    order.trackingNumber = String(trackingNumber).trim();
    order.trackingUrl = String(trackingUrl).trim();
    order.fulfillmentHistory.push({ status: fulfillmentStatus, at: new Date(), courierName: order.courierName, trackingNumber: order.trackingNumber });
    await order.save();
    return res.json({ success: true, order: {
      orderNumber: order.orderNumber, fulfillmentStatus: order.fulfillmentStatus,
      courierName: order.courierName, trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl, fulfillmentHistory: order.fulfillmentHistory
    }});
  } catch (error) {
    console.error('Fulfilment update error:', error);
    return res.status(500).json({ error: 'Could not update order fulfilment.' });
  }
});

// Customer order lookup. Requires both order number and matching checkout email.
app.post('/api/order-status', async (req, res) => {
  try {
    const orderNumber = String(req.body?.orderNumber || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!orderNumber || !email) return res.status(400).json({ error: 'Order number and email are required.' });
    const order = await Order.findOne({ orderNumber, customerEmail: email, status: { $in: ['paid', 'completed'] } })
      .select('orderNumber customerEmail items amountTotal createdAt fulfillmentStatus courierName trackingNumber trackingUrl fulfillmentHistory')
      .lean();
    if (!order) return res.status(404).json({ error: 'No completed order matched that order number and email.' });
    const physical = hasPaperback(order);
    return res.json({
      orderNumber: order.orderNumber, items: order.items, amountTotal: order.amountTotal,
      createdAt: order.createdAt,
      fulfillmentStatus: physical ? (order.fulfillmentStatus || 'Order Received') : 'Digital Delivery',
      courierName: physical ? order.courierName : '',
      trackingNumber: physical ? order.trackingNumber : '',
      trackingUrl: physical ? order.trackingUrl : '',
      fulfillmentHistory: physical ? order.fulfillmentHistory : []
    });
  } catch (error) {
    console.error('Customer order lookup error:', error);
    return res.status(500).json({ error: 'Could not look up order status.' });
  }
});


// E-book access: email OTP + paid-order entitlement + private Google Drive streaming.
const EBOOKS = {
  book_1_eb: { title: 'Kaalyug: Shadows of Dark Web', driveFileId: '1eRI8rapGCk9WwL7RYd7F2zwBj8ikkbwO' },
  book_2_eb: { title: 'Pages of Us', driveFileId: '1XXBc9In0OiPFlwLyRB44fQWu98PGQ0bZ' },
  book_3_eb: { title: 'The Indestructible Kali', driveFileId: '1N8lwC2Wm_Qvygq3lrr4q0zl18hmLVvln' }
};

const SESSION_TTL_SECONDS = 12 * 60 * 60;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

const ebookOtpSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true },
  email: { type: String, required: true },
  otpHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  attempts: { type: Number, default: 0 },
  usedAt: { type: Date, default: null },
  lastSentAt: { type: Date, default: Date.now }
}, { timestamps: true });
ebookOtpSchema.index({ orderNumber: 1, email: 1 }, { unique: true });
const EbookOtp = mongoose.models.EbookOtp || mongoose.model('EbookOtp', ebookOtpSchema);

function hashEbookOtp(orderNumber, email, otp) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderNumber}:${email}:${otp}`).digest('hex');
}
async function getPurchasedEbooks(order) {
  const candidates = [...new Set((order.items || []).map(item => String(item.id || '')))];
  const ebooks = [];
  for (const id of candidates) {
    const config = await getEbookConfig(id);
    if (config) ebooks.push({ id, title: config.title });
  }
  return ebooks;
}


function makeEbookToken(email) {
  const payload = Buffer.from(JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  })).toString('base64url');

  const signature = crypto
    .createHmac(
      'sha256',
      process.env.SESSION_SECRET || process.env.RAZORPAY_KEY_SECRET
    )
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
}


function requireEbookSession(req, res, next) {
  const token = String(req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  const parts = token.split('.');

  if (parts.length !== 2) {
    return res.status(401).json({
      error: 'Please log in again to access your e-books.'
    });
  }

  const expected = crypto
    .createHmac(
      'sha256',
      process.env.SESSION_SECRET || process.env.RAZORPAY_KEY_SECRET
    )
    .update(parts[0])
    .digest('base64url');

  const suppliedBuffer = Buffer.from(parts[1]);
  const expectedBuffer = Buffer.from(expected);

  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return res.status(401).json({ error: 'Invalid session. Please log in again.' });
  }

  try {
    const payload = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8')
    );

    
    if (
      !payload.email ||
      !payload.exp ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return res.status(401).json({
        error: 'Your session expired. Please log in again.'
      });
    }

    req.ebookEmail = normalizeEmail(payload.email);
    req.ebookOrderNumber = null;

    next();

  } catch {
    return res.status(401).json({ error: 'Invalid session. Please log in again.' });
  }
}

// Send an email OTP only after verifying a paid/completed order and its e-book entitlement.
app.post('/api/ebooks/request-otp', async (req, res) => {
  try {
    const orderNumber = String(req.body?.orderNumber || '').trim();
    const email = normalizeEmail(req.body?.email);
    if (!orderNumber || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid order ID and purchase email.' });
    }
    const order = await Order.findOne({ orderNumber, customerEmail: email, status: { $in: ['paid', 'completed'] } }).select('orderNumber customerEmail items').lean();
    if (!order) return res.status(404).json({ error: 'No completed order matched that order ID and email.' });
    const ebooks = await getPurchasedEbooks(order);
    if (!ebooks.length) return res.status(403).json({ error: 'This order does not contain an e-book.' });
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_FROM) {
      return res.status(503).json({ error: 'Email OTP is not configured. Please contact the store administrator.' });
    }
    let record = await EbookOtp.findOne({ orderNumber, email });
    if (record && !record.usedAt && Date.now() - new Date(record.lastSentAt).getTime() < 60_000) {
      return res.status(429).json({ error: 'Please wait one minute before requesting another code.' });
    }
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const values = { otpHash: hashEbookOtp(orderNumber, email, otp), expiresAt: new Date(Date.now() + 10 * 60_000), attempts: 0, usedAt: null, lastSentAt: new Date() };
    if (record) { Object.assign(record, values); await record.save(); }
    else { try { record = await EbookOtp.create({ orderNumber, email, ...values }); } catch (e) { if (e.code !== 11000) throw e; record = await EbookOtp.findOne({ orderNumber, email }); Object.assign(record, values); await record.save(); } }
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: 'Your Sai Krishna Author Store verification code',
      text: `Your e-book access verification code is ${otp}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>Sai Krishna Author Store</h2><p>Use this one-time code to access your purchased e-book:</p><p style="font-size:30px;font-weight:bold;letter-spacing:8px">${otp}</p><p>This code expires in 10 minutes. Do not share it with anyone.</p></div>`
    });
    return res.json({ success: true, message: 'A 6-digit verification code has been sent to your purchase email.' });
  } catch (error) {
    console.error('E-book OTP request error:', error.message);
    return res.status(500).json({ error: 'Could not send the verification code. Please try again.' });
  }
});

app.post('/api/ebooks/verify-otp', async (req, res) => {
  try {
    const orderNumber = String(req.body?.orderNumber || '').trim();
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();
    if (!orderNumber || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: 'Enter the order ID, purchase email and 6-digit code.' });
    }
    const record = await EbookOtp.findOne({ orderNumber, email });
    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now() || record.attempts >= 5) {
      return res.status(401).json({ error: 'The code is invalid or expired. Request a new code.' });
    }
    const expected = Buffer.from(record.otpHash, 'hex');
    const supplied = Buffer.from(hashEbookOtp(orderNumber, email, otp), 'hex');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      record.attempts += 1;
      await record.save();
      return res.status(401).json({ error: `Incorrect code. ${Math.max(0, 5 - record.attempts)} attempt(s) remaining.` });
    }
    record.usedAt = new Date();
    await record.save();
    const order = await Order.findOne({ orderNumber, customerEmail: email, status: { $in: ['paid', 'completed'] } }).select('orderNumber customerEmail items').lean();
    if (!order) return res.status(404).json({ error: 'The order is no longer available.' });
    const ebooks = await getPurchasedEbooks(order);
    if (!ebooks.length) return res.status(403).json({ error: 'This order does not contain an e-book.' });
    return res.json({ success: true, token: makeEbookToken(email, order.orderNumber), email, ebooks });
  } catch (error) {
    console.error('E-book OTP verification error:', error.message);
    return res.status(500).json({ error: 'Could not verify the code. Please try again.' });
  }
});

// E-book login: match order ID + checkout email and issue a short-lived protected session.


app.post('/api/ebooks/access', async (req, res) => {
  try {
    const orderNumber = String(req.body?.orderNumber || '').trim();
    const email = normalizeEmail(req.body?.email);

    if (
      !orderNumber ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        error: 'Enter a valid order ID and purchase email.'
      });
    }

    // The entered order must belong to this email.
    const matchingOrder = await Order.findOne({
      orderNumber,
      customerEmail: email,
      status: { $in: ['paid', 'completed'] }
    }).select('orderNumber').lean();

    if (!matchingOrder) {
      return res.status(401).json({
        error: 'Invalid Order ID or purchase email.'
      });
    }

    // Collect all eligible orders for this email.
    const orders = await Order.find({
      customerEmail: email,
      status: { $in: ['paid', 'completed'] }
    }).select('items').lean();

    // Combine books and remove duplicates by book ID.
    const uniqueBooks = new Map();

    for (const order of orders) {
      const books = await getPurchasedEbooks(order);

      for (const book of books) {
        uniqueBooks.set(book.id, book);
      }
    }

    const ebooks = [...uniqueBooks.values()];

    if (!ebooks.length) {
      return res.status(403).json({
        error: 'No purchased e-books were found for this email.'
      });
    }

    return res.json({
      success: true,
      token: makeEbookToken(email),
      email,
      ebooks
    });
  } catch (error) {
    console.error('E-book access error:', error.message);
    return res.status(500).json({
      error: 'Could not verify your order. Please try again.'
    });
  }
});



// Only list e-books included in the order attached to this session.

// Only list e-books included in the order attached to this session.

app.get('/api/ebooks', requireEbookSession, async (req, res) => {
  try {
    const orders = await Order.find({
      customerEmail: req.ebookEmail,
      status: { $in: ['paid', 'completed'] }
    }).select('items').lean();

    const uniqueBooks = new Map();

    for (const order of orders) {
      const books = await getPurchasedEbooks(order);

      for (const book of books) {
        uniqueBooks.set(book.id, book);
      }
    }

    return res.json({
      email: req.ebookEmail,
      ebooks: [...uniqueBooks.values()]
    });
  } catch (error) {
    console.error('E-book list error:', error.message);
    return res.status(500).json({
      error: 'Could not load your e-books.'
    });
  }
});

// Google service account credentials are kept in Render environment variables, never in frontend code.
// Share each private Drive PDF with the service-account email from GOOGLE_SERVICE_ACCOUNT_JSON.
let driveTokenCache = { token: '', expiresAt: 0 };
async function getGoogleDriveAccessToken() {
  if (driveTokenCache.token && driveTokenCache.expiresAt > Date.now() + 60000) return driveTokenCache.token;
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.'); }
  if (!credentials.client_email || !credentials.private_key) throw new Error('Google Drive service account is not configured.');
  const now = Math.floor(Date.now()/1000);
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${enc({alg:'RS256',typ:'JWT'})}.${enc({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/drive',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
  const sign = crypto.createSign('RSA-SHA256'); sign.update(unsigned); sign.end();
  const assertion = `${unsigned}.${sign.sign(credentials.private_key).toString('base64url')}`;
  const response = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}) });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google token request failed: ${data.error_description || data.error || response.status}`);
  driveTokenCache = { token:data.access_token, expiresAt:Date.now() + Number(data.expires_in || 3600)*1000 };
  return driveTokenCache.token;
}

app.get('/api/ebooks/:bookId/pdf', requireEbookSession, async (req, res) => {
  try {
    const bookId = req.params.bookId;
    const book = await getEbookConfig(bookId);
    if (!book) return res.status(404).json({ error: 'E-book not found.' });

    
    const order = await Order.findOne({
      customerEmail: req.ebookEmail,
      status: { $in: ['paid', 'completed'] },
      'items.id': bookId
    }).select('_id').lean();

    if (!order) {
      return res.status(403).json({
        error: 'This e-book is not included in your eligible orders.'
      });
    }


    const accessToken = await getGoogleDriveAccessToken();
    const upstream = await fetch(`https://www.googleapis.com/drive/v3/files/${book.driveFileId}?alt=media`, { headers:{Authorization:`Bearer ${accessToken}`} });
    if (!upstream.ok) {
      const details = await upstream.text();
      console.error('Google Drive PDF fetch failed:', upstream.status, details.slice(0,500));
      return res.status(502).json({ error: 'Could not load this e-book. Please contact the store administrator.' });
    }
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition','inline; filename="reading-copy.pdf"');
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options','nosniff');
    if (upstream.body) {
      const { Readable } = require('node:stream');
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      const bytes = Buffer.from(await upstream.arrayBuffer());
      res.end(bytes);
    }
  } catch (error) {
    console.error('Protected e-book PDF error:', error.message);
    const status = error.message.includes('not configured') || error.message.includes('valid JSON') ? 503 : 500;
    return res.status(status).json({ error: status === 503 ? 'Private Google Drive access is not configured on the backend.' : 'Could not load this e-book.' });
  }
});

app.get('/api/ebooks/session', requireEbookSession, (req, res) => res.json({ success:true, email:req.ebookEmail }));


// Create Razorpay Order API (Secure Server-Side Calculation)

app.post('/api/create-order', async (req, res) => {
  try {
    const customerEmail = normalizeEmail(req.body?.customerEmail);
    const items = req.body?.items;
    const shippingAddress = req.body?.shippingAddress || null;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) ||
        !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Valid email and non-empty cart are required.' });
    }

    const visibleCatalog = await getCatalogBooks(false);
    const visibleSkuIds = new Set(visibleCatalog.flatMap(b => [b.pbId, b.ebId]));
    const pricedBooks = (await getPricedBooks()).filter(b => visibleSkuIds.has(b.id));
    let totalRupees = 0;
    const verifiedItems = [];

    for (const item of items) {
      const book = pricedBooks.find(b => b.id === item.id);
      if (!book) return res.status(400).json({ error: `Invalid book ID: ${item.id}` });

      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        return res.status(400).json({ error: `Invalid quantity for ${book.name}` });
      }

      totalRupees += book.currentPrice * quantity;
      verifiedItems.push({
        id: book.id,
        name: book.name,
        price: book.currentPrice,
        mrp: book.mrp,
        quantity,
        type: book.type
      });
    }

    const orderNumber = generateOrderNumber();
    const hasPhysicalBook = verifiedItems.some(item => item.type === 'Paperback' || item.id.endsWith('_pb'));
    const fulfillmentStatus = hasPhysicalBook ? 'Order Received' : 'Digital Delivery';

    // Free orders are completed immediately; no Razorpay order/payment is created.
    if (totalRupees === 0) {
      const order = await Order.create({
        customerEmail,
        items: verifiedItems,
        amountTotal: 0,
        orderNumber,
        status: 'completed',
        shippingAddress,
        fulfillmentStatus,
        fulfillmentHistory: [{ status: fulfillmentStatus, at: new Date() }]
      });

      let emailSent = false;
      
      // Send confirmation email in the background.
      void (async () => {
        try {
          if (
            !process.env.SMTP_HOST ||
            !process.env.SMTP_USER ||
            !process.env.SMTP_PASS ||
            !process.env.MAIL_FROM
          ) {
            throw new Error('SMTP environment variables are incomplete.');
          }

          await transporter.sendMail({
            from: process.env.MAIL_FROM,
            to: order.customerEmail,
            subject: 'Your Free Book Order - Sai Krishna Author Store',
            html: `
              <h2>Your order is confirmed!</h2>
              <p>This order was free, so no payment was required.</p>
              <p><strong>Order Number:</strong> ${order.orderNumber}</p>
              <h3>Books in your order</h3>
              <ul>
                ${order.items.map(item =>
                  `<li>${item.name} — Qty: ${item.quantity} — FREE</li>`
                ).join('')}
              </ul>
              <p>For e-books, visit the store's e-book access page and use this order number with this email address.</p>
              <p>Thank you for supporting Sai Krishna Author Store.</p>
            `
          });

          order.confirmationEmailSentAt = new Date();
          await order.save();

          console.log(
            'Free-order confirmation email sent:',
            order.orderNumber
          );
        } catch (mailErr) {
          console.error(
            'Free-order confirmation email failed:',
            mailErr.message
          );
        }
      })();
 

      return res.json({
        success: true,
        freeOrder: true,
        orderNumber: order.orderNumber,
        emailSent,
        amount: 0,
        currency: 'INR'
      });
    }

    const amountPaise = Math.round(totalRupees * 100);
    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`
    });

    const order = await Order.create({
      customerEmail,
      items: verifiedItems,
      amountTotal: totalRupees,
      razorpayOrderId: razorpayOrder.id,
      orderNumber,
      status: 'created',
      shippingAddress
    });

    return res.json({
      orderId: razorpayOrder.id,
      orderNumber: order.orderNumber,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    console.error('Order creation error:', error);
    return res.status(500).json({ error: 'Failed to create order.' });
  }
});


// Verify Payment Signature & Send Confirmation Email API

app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing payment verification parameters.'
      });
    }

    const existingOrder = await Order.findOne({
      razorpayOrderId: razorpay_order_id
    });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: 'Order not found.'
      });
    }

    const generatedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    const received = Buffer.from(razorpay_signature, 'hex');
    const expected = Buffer.from(generatedSignature, 'hex');

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(received, expected)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature.'
      });
    }

    // Do not overwrite a different payment ID on an already-paid order.
    if (existingOrder.status === 'paid') {
      if (existingOrder.razorpayPaymentId !== razorpay_payment_id) {
        return res.status(409).json({
          success: false,
          message: 'This order is already associated with another payment.'
        });
      }
    } else {
      existingOrder.razorpayPaymentId = razorpay_payment_id;
      existingOrder.status = 'paid';
      existingOrder.fulfillmentStatus = (existingOrder.items || []).some(item => String(item.type || item.id || '').toLowerCase().includes('paperback') || String(item.id || '').endsWith('_pb')) ? 'Order Received' : 'Digital Delivery';
      existingOrder.fulfillmentHistory = [{ status: existingOrder.fulfillmentStatus, at: new Date() }];
      await existingOrder.save();
    }

    let emailSent = Boolean(existingOrder.confirmationEmailSentAt);

    if (!emailSent) {
      try {
        if (
          !process.env.SMTP_HOST ||
          !process.env.SMTP_USER ||
          !process.env.SMTP_PASS ||
          !process.env.MAIL_FROM
        ) {
          throw new Error('SMTP environment variables are incomplete.');
        }

        await transporter.sendMail({
          from: process.env.MAIL_FROM,
          to: existingOrder.customerEmail,
          subject: 'Order Confirmation - Sai Krishna Author Store',
          html: `
            <h2>Thank you for your order!</h2>
            <p>Your payment has been verified successfully.</p>
            <p><strong>Order Number:</strong> ${existingOrder.orderNumber || 'Pending'}</p>
            <p><strong>Payment ID:</strong> ${razorpay_payment_id}</p>
            <h3>Purchased Items</h3>
            <ul>
              ${existingOrder.items.map(item =>
                `<li>${item.name} ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Qty: ${item.quantity}, ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¹${item.price * item.quantity}</li>`
              ).join('')}
            </ul>
            <p>Thank you for supporting Sai Krishna Author Store.</p>
          `
        });

        existingOrder.confirmationEmailSentAt = new Date();
        await existingOrder.save();
        emailSent = true;

        console.log(
          'Confirmation email sent to:',
          existingOrder.customerEmail
        );
      } catch (mailErr) {
        console.error('Confirmation email failed:', mailErr.message);
      }
    }

    // This response is essential for the frontend success popup.
    return res.json({
      success: true,
      message: 'Payment verified successfully.',
      orderNumber: existingOrder.orderNumber,
      emailSent
    });

  } catch (error) {
    console.error('Payment verification error:', error);

    return res.status(500).json({
      success: false,
      message: 'Payment verification encountered a server error.'
    });
  }
});


// Centralized Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.stack);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));


function showOrderSuccess(orderNumber, emailSent) {
  document.getElementById('confirmed-order-id').textContent = orderNumber;

  document.getElementById('confirmation-email-status').textContent =
    emailSent
      ? 'Your confirmation email has been sent.'
      : 'Your order is confirmed. Email delivery may be delayed; please check again later.';

  document.getElementById('copy-order-status').textContent = '';

  const modal = document.getElementById('order-success-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

async function copyOrderId() {
  const orderId = document.getElementById('confirmed-order-id').textContent;
  const status = document.getElementById('copy-order-status');

  try {
    await navigator.clipboard.writeText(orderId);
    status.textContent = 'Order ID copied!';
  } catch {
    status.textContent = 'Please select and copy the Order ID manually.';
  }
}

function closeOrderSuccess() {
  const modal = document.getElementById('order-success-modal');
  modal.classList.remove('flex');
  modal.classList.add('hidden');
}
