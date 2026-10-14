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

app.use(express.json({ limit: '8mb' }));

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

  fulfillmentStatus: { type: String, enum: ['Order Received', 'Order Confirmed', 'Shipped', 'Delivered', 'Digital Delivery'], default: 'Order Received' },

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

// Centralized prices: one MongoDB record per paperback/e-book SKU.

const bookPriceSchema = new mongoose.Schema({

  bookId: { type: String, required: true, unique: true },

  mrp: { type: Number, required: true, min: 0 },

  currentPrice: { type: Number, required: true, min: 0 },

  updatedAt: { type: Date, default: Date.now }

});

const BookPrice = mongoose.models.BookPrice || mongoose.model('BookPrice', bookPriceSchema);

// Editable book catalogue. Existing legacy books remain available during migration.
const managedBookSchema = new mongoose.Schema({
  bookId: { type: String, required: true, unique: true },
  title: { type: String, required: true, trim: true, maxlength: 180 },
  desc: { type: String, default: '', maxlength: 2000 },
  image: { type: String, required: true },
  imageDriveFileId: { type: String, default: '' },
  pbId: { type: String, required: true, unique: true },
  ebId: { type: String, required: true, unique: true },
  published: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const ManagedBook = mongoose.models.ManagedBook || mongoose.model('ManagedBook', managedBookSchema);

const LEGACY_CATALOG = [
  { bookId: 'book_1', title: 'KaalYug: Shadows of Dark Web', desc: 'Time is a wheel turning endlessly through eras of light and shadow.', image: 'images/kaalyug.png', samplePdf: 'samples/KaalYug_Shadows_of_Dark_Web_Sample_Chapter.pdf', pbId: 'book_1_pb', ebId: 'book_1_eb', published: true, legacy: true },
  { bookId: 'book_2', title: 'Pages of Us', desc: 'Raw emotion and human connection folded like dried flowers in a diary.', image: 'images/pages-of-us.png', samplePdf: 'samples/Pages_of_Us_Sample_Chapter.pdf', pbId: 'book_2_pb', ebId: 'book_2_eb', published: true, legacy: true },
  { bookId: 'book_3', title: 'The Indestructible Kali', desc: 'Primal energy, myth, and the ultimate resilience of the cosmos.', image: 'images/kali.jpeg', samplePdf: 'samples/The_Indestructible_Kali_Sample_Chapter.pdf', pbId: 'book_3_pb', ebId: 'book_3_eb', published: true, legacy: true }
];

function safeDriveImageUrl(fileId) {
  return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(fileId)}`;
}

function validateBookPayload(body) {
  const title = String(body?.title || '').trim();
  const desc = String(body?.desc || '').trim();
  const image = String(body?.image || '').trim();
  if (!title || title.length > 180) throw new Error('Book title is required (maximum 180 characters).');
  if (desc.length > 2000) throw new Error('Description must be 2,000 characters or fewer.');
  if (!/^https:\/\//i.test(image) && !/^images\/[\w./-]+$/i.test(image)) throw new Error('Please upload a cover image or provide a valid HTTPS image URL.');
  return { title, desc, image };
}

async function getDriveWriteAccessToken() {
  // getGoogleDriveAccessToken uses the full Drive scope for uploads and protected PDF reads.
  return getGoogleDriveAccessToken();
}

async function uploadImageToDrive({ fileName, mimeType, base64 }) {
  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!allowedTypes.has(mimeType)) throw new Error('Use a JPG, PNG, WEBP or GIF image.');
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('Image must be between 1 byte and 5 MB.');
  const folderId = process.env.GOOGLE_DRIVE_IMAGES_FOLDER_ID;
  if (!folderId) throw new Error('Set GOOGLE_DRIVE_IMAGES_FOLDER_ID in Render to the ID of your Author Store Images folder.');
  const accessToken = await getDriveWriteAccessToken();
  const boundary = `authorstore_${crypto.randomBytes(12).toString('hex')}`;
  const metadata = { name: String(fileName || 'book-cover').replace(/[\\/]/g, '_').slice(0, 180), mimeType, parents: [folderId] };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes,
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(body.length) },
    body
  });
  const data = await response.json();
  if (!response.ok || !data.id) throw new Error(`Google Drive image upload failed (${response.status}): ${data.error?.message || 'Check folder sharing and Drive API permissions.'}`);
  const permissionResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(data.id)}/permissions`, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'anyone', role: 'reader' })
  });
  if (!permissionResponse.ok) {
    const detail = await permissionResponse.text();
    console.error('Could not make uploaded cover publicly viewable:', permissionResponse.status, detail.slice(0, 300));
    throw new Error('Image uploaded but Google Drive could not enable public viewing. Check your organisation sharing settings.');
  }
  return { fileId: data.id, fileName: data.name, imageUrl: safeDriveImageUrl(data.id) };
}


async function getPricedBooks(includeUnpublished = false) {
  const result = [];
  for (const book of BOOKS) {
    const price = await BookPrice.findOneAndUpdate(
      { bookId: book.id },
      { $setOnInsert: { mrp: book.price, currentPrice: book.price, updatedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    result.push({ ...book, mrp: price.mrp, currentPrice: price.currentPrice, price: price.currentPrice });
  }
  const managed = await ManagedBook.find(includeUnpublished ? {} : { published: true }).sort({ createdAt: 1 }).lean();
  for (const book of managed) {
    for (const sku of [
      { id: book.pbId, name: `${book.title} (Paperback)`, type: 'Paperback' },
      { id: book.ebId, name: `${book.title} (E-Book)`, type: 'E-Book' }
    ]) {
      const price = await BookPrice.findOne({ bookId: sku.id }).lean();
      if (price) result.push({ ...sku, mrp: price.mrp, currentPrice: price.currentPrice, price: price.currentPrice });
    }
  }
  return result;
}

// 3. API Endpoints

// Public catalogue: only published managed books plus the three existing legacy books.
app.get('/api/catalog', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const managed = await ManagedBook.find({ published: true }).sort({ createdAt: 1 }).lean();
    const priced = await getPricedBooks();
    const byId = new Map(priced.map(item => [item.id, item]));
    const legacy = LEGACY_CATALOG.map(book => ({ ...book }));
    const dynamic = managed.map(book => ({ bookId: book.bookId, title: book.title, desc: book.desc, image: book.image, pbId: book.pbId, ebId: book.ebId, published: book.published, samplePdf: '' }));
    return res.json([...legacy, ...dynamic].map(book => {
      const pb = byId.get(book.pbId), eb = byId.get(book.ebId);
      return { ...book, pbMrp: pb?.mrp ?? 0, pbPrice: pb?.currentPrice ?? 0, ebMrp: eb?.mrp ?? 0, ebPrice: eb?.currentPrice ?? 0 };
    }));
  } catch (error) {
    console.error('Public catalogue error:', error);
    return res.status(500).json({ error: 'Could not load the book catalogue.' });
  }
});

// Admin catalogue management.
app.get('/api/admin/books', requireAdmin, async (req, res) => {
  try {
    const priced = await getPricedBooks(true);
    const priceById = new Map(priced.map(item => [item.id, item]));
    const legacy = LEGACY_CATALOG.map(book => ({ ...book, pbMrp: priceById.get(book.pbId)?.mrp ?? 0, pbPrice: priceById.get(book.pbId)?.currentPrice ?? 0, ebMrp: priceById.get(book.ebId)?.mrp ?? 0, ebPrice: priceById.get(book.ebId)?.currentPrice ?? 0 }));
    const managed = await ManagedBook.find({}).sort({ createdAt: -1 }).lean();
    return res.json([...legacy, ...managed.map(book => ({ ...book, legacy: false, pbMrp: priceById.get(book.pbId)?.mrp ?? 0, pbPrice: priceById.get(book.pbId)?.currentPrice ?? 0, ebMrp: priceById.get(book.ebId)?.mrp ?? 0, ebPrice: priceById.get(book.ebId)?.currentPrice ?? 0 }))]);
  } catch (error) {
    console.error('Admin books list error:', error);
    return res.status(500).json({ error: 'Could not load books.' });
  }
});

app.post('/api/admin/upload-image', requireAdmin, async (req, res) => {
  try {
    const result = await uploadImageToDrive(req.body || {});
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('Admin image upload error:', error.message);
    return res.status(400).json({ error: error.message || 'Could not upload image.' });
  }
});

app.post('/api/admin/books', requireAdmin, async (req, res) => {
  try {
    const { title, desc, image } = validateBookPayload(req.body || {});
    const mrpPb = Number(req.body?.pbMrp), pricePb = Number(req.body?.pbPrice);
    const mrpEb = Number(req.body?.ebMrp), priceEb = Number(req.body?.ebPrice);
    if (![mrpPb, pricePb, mrpEb, priceEb].every(n => Number.isFinite(n) && n >= 0) || pricePb > mrpPb || priceEb > mrpEb) {
      return res.status(400).json({ error: 'Enter valid prices. Selling prices must be between zero and MRP.' });
    }
    const suffix = crypto.randomBytes(6).toString('hex');
    const book = await ManagedBook.create({
      bookId: `book_${suffix}`, title, desc, image,
      imageDriveFileId: String(req.body?.imageDriveFileId || ''),
      pbId: `book_${suffix}_pb`, ebId: `book_${suffix}_eb`,
      published: Boolean(req.body?.published), createdAt: new Date(), updatedAt: new Date()
    });
    await BookPrice.create([
      { bookId: book.pbId, mrp: mrpPb, currentPrice: pricePb, updatedAt: new Date() },
      { bookId: book.ebId, mrp: mrpEb, currentPrice: priceEb, updatedAt: new Date() }
    ]);
    return res.status(201).json({ success: true, book });
  } catch (error) {
    console.error('Admin create book error:', error);
    return res.status(400).json({ error: error.message || 'Could not create book.' });
  }
});

app.put('/api/admin/books/:bookId', requireAdmin, async (req, res) => {
  try {
    const book = await ManagedBook.findOne({ bookId: req.params.bookId });
    if (!book) return res.status(404).json({ error: 'Managed book not found. Existing legacy book metadata is read-only in this first release.' });
    const { title, desc, image } = validateBookPayload(req.body || {});
    const mrpPb = Number(req.body?.pbMrp), pricePb = Number(req.body?.pbPrice);
    const mrpEb = Number(req.body?.ebMrp), priceEb = Number(req.body?.ebPrice);
    if (![mrpPb, pricePb, mrpEb, priceEb].every(n => Number.isFinite(n) && n >= 0) || pricePb > mrpPb || priceEb > mrpEb) return res.status(400).json({ error: 'Enter valid prices. Selling prices must be between zero and MRP.' });
    Object.assign(book, { title, desc, image, imageDriveFileId: String(req.body?.imageDriveFileId || ''), published: Boolean(req.body?.published), updatedAt: new Date() });
    await book.save();
    for (const [bookId, mrp, currentPrice] of [[book.pbId, mrpPb, pricePb], [book.ebId, mrpEb, priceEb]]) {
      await BookPrice.findOneAndUpdate({ bookId }, { $set: { mrp, currentPrice, updatedAt: new Date() } }, { upsert: true, new: true, runValidators: true });
    }
    return res.json({ success: true, book });
  } catch (error) {
    console.error('Admin update book error:', error);
    return res.status(400).json({ error: error.message || 'Could not update book.' });
  }
});

app.delete('/api/admin/books/:bookId', requireAdmin, async (req, res) => {
  try {
    const book = await ManagedBook.findOneAndDelete({ bookId: req.params.bookId });
    if (!book) return res.status(404).json({ error: 'Managed book not found.' });
    // Keep price records so historical order IDs remain understandable; checkout no longer offers this book.
    return res.json({ success: true, message: 'Book removed from the catalogue.' });
  } catch (error) {
    console.error('Admin delete book error:', error);
    return res.status(500).json({ error: 'Could not delete book.' });
  }
});

// Public book list: frontend display and checkout use these same server-managed prices.

app.get('/api/books', async (req, res) => {

  try {

    res.set('Cache-Control', 'no-store');

    return res.json(await getPricedBooks(true));

  } catch (error) {

    console.error('Book price fetch error:', error);

    return res.status(500).json({ error: 'Could not load current book prices.' });

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

    const allowedIds = new Set((await getPricedBooks(true)).map(book => book.id));

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

    return res.json({ success: true, message: 'Book prices saved.', prices: await getPricedBooks(true) });

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

    if (fulfillmentStatus === 'Shipped' || fulfillmentStatus === 'Delivered') {

      if (!String(courierName).trim() || !String(trackingNumber).trim()) {

        return res.status(400).json({ error: 'Courier name and tracking number are required for Shipped/Delivered.' });

      }

    }

    const previous = order.fulfillmentStatus || 'Order Received';

    const oldIndex = FULFILLMENT_STAGES.indexOf(previous);

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

function makeEbookToken(email, orderNumber) {

  const payload = Buffer.from(JSON.stringify({

    email,

    orderNumber,

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

      !payload.orderNumber ||

      !payload.exp ||

      payload.exp < Math.floor(Date.now() / 1000)

    ) {

      return res.status(401).json({

        error: 'Your session expired. Please log in again.'

      });

    }

    req.ebookEmail = normalizeEmail(payload.email);

    req.ebookOrderNumber = String(payload.orderNumber);

    next();

  } catch {

    return res.status(401).json({ error: 'Invalid session. Please log in again.' });

  }

}

// Verify the order ID, checkout email and paid status.

app.post('/api/ebooks/access', async (req, res) => {

  try {

    const orderNumber = String(req.body?.orderNumber || '').trim();

    const email = normalizeEmail(req.body?.email);

    if (!orderNumber || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {

      return res.status(400).json({

        error: 'Enter a valid order ID and purchase email.'

      });

    }

    const order = await Order.findOne({

      orderNumber,

      customerEmail: email,

      status: { $in: ['paid', 'completed'] }

    }).select('orderNumber customerEmail items').lean();

    if (!order) {

      return res.status(404).json({

        error: 'No completed order matched that order ID and email.'

      });

    }

  const purchasedIds = new Set(

    (order.items || [])

      .map(item => String(item.id || ''))

      .filter(id => Boolean(EBOOKS[id]))

  );

    if (purchasedIds.size === 0) {

      return res.status(403).json({

        error: 'This order does not contain an e-book.'

      });

    }

    const ebooks = [...purchasedIds].map(id => ({

      id,

      title: EBOOKS[id].title

    }));

    return res.json({

      success: true,

      token: makeEbookToken(email, order.orderNumber),

      email,

      ebooks

    });

  } catch (error) {

    console.error('E-book access error:', error);

    return res.status(500).json({

      error: 'Could not verify the order. Please try again.'

    });

  }

});

// Only list e-books included in the order attached to this session.

app.get('/api/ebooks', requireEbookSession, async (req, res) => {

  try {

    const order = await Order.findOne({

      orderNumber: req.ebookOrderNumber,

      customerEmail: req.ebookEmail,

      status: { $in: ['paid', 'completed'] }

    }).select('items').lean();

    if (!order) {

      return res.status(401).json({

        error: 'This order is no longer available. Please log in again.'

      });

    }

    const ids = new Set(

      (order.items || [])

        .map(item => String(item.id || ''))

        .filter(id => Boolean(EBOOKS[id]))

    );

    return res.json({

      email: req.ebookEmail,

      ebooks: [...ids].map(id => ({

        id,

        title: EBOOKS[id].title

      }))

    });

  } catch (error) {

    console.error('E-book list error:', error);

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

  const unsigned = `${enc({alg:'RS256',typ:'JWT'})}.${enc({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/drive',aud:'https\://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;

  const sign = crypto.createSign('RSA-SHA256'); sign.update(unsigned); sign.end();

  const assertion = `${unsigned}.${sign.sign(credentials.private_key).toString('base64url')}`;

  const response = await fetch('https\://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}) });

  const data = await response.json();

  if (!response.ok || !data.access_token) throw new Error(`Google token request failed: ${data.error_description || data.error || response.status}`);

  driveTokenCache = { token:data.access_token, expiresAt:Date.now() + Number(data.expires_in || 3600)*1000 };

  return driveTokenCache.token;

}

app.get('/api/ebooks/:bookId/pdf', requireEbookSession, async (req, res) => {

  try {

    const bookId = req.params.bookId;

    const book = EBOOKS[bookId];

    if (!book) return res.status(404).json({ error: 'E-book not found.' });

    const order = await Order.findOne({

      orderNumber: req.ebookOrderNumber,

      customerEmail: req.ebookEmail,

      status: { $in: ['paid', 'completed'] },

      'items.id': bookId

    }).select('_id').lean();

    if (!order) {

      return res.status(403).json({

        error: 'This e-book is not included in your verified order.'

      });

    }

    const accessToken = await getGoogleDriveAccessToken();

    const upstream = await fetch(`https\://www\.googleapis.com/drive/v3/files/${book.driveFileId}?alt=media`, { headers:{Authorization:`Bearer ${accessToken}`} });

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

    const pricedBooks = await getPricedBooks();

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

              \<h2>Your order is confirmed!\</h2>

              \<p>This order was free, so no payment was required.\</p>

              \<p>\<strong>Order Number:\</strong> ${order.orderNumber}\</p>

              \<h3>Books in your order\</h3>

              \<ul>

                ${order.items.map(item =>

                  `\<li>${item.name} — Qty: ${item.quantity} — FREE\</li>`

                ).join('')}

              \</ul>

              \<p>For e-books, visit the store's e-book access page and use this order number with this email address.\</p>

              \<p>Thank you for supporting Sai Krishna Author Store.\</p>

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

            \<h2>Thank you for your order!\</h2>

            \<p>Your payment has been verified successfully.\</p>

            \<p>\<strong>Order Number:\</strong> ${existingOrder.orderNumber || 'Pending'}\</p>

            \<p>\<strong>Payment ID:\</strong> ${razorpay_payment_id}\</p>

            \<h3>Purchased Items\</h3>

            \<ul>

              ${existingOrder.items.map(item =>

                `\<li>${item.name} — Qty: ${item.quantity}, ₹${item.price * item.quantity}\</li>`

              ).join('')}

            \</ul>

            \<p>Thank you for supporting Sai Krishna Author Store.\</p>

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
