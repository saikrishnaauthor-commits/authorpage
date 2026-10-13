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
app.use(express.json());
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
  razorpayOrderId: { type: String, required: true, unique: true },
  razorpayPaymentId: { type: String, default: null },
  status: { type: String, enum: ['created', 'paid', 'failed'], default: 'created' },
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

// 3. API Endpoints

// Get available books
app.get('/api/books', (req, res) => {
  res.json(BOOKS);
});


// Admin: list paid orders with fulfilment and shipping details.
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find({ status: 'paid' })
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
    const order = await Order.findOne({ orderNumber: req.params.orderNumber, status: 'paid' });
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
    const order = await Order.findOne({ orderNumber, customerEmail: email, status: 'paid' })
      .select('orderNumber customerEmail items amountTotal createdAt fulfillmentStatus courierName trackingNumber trackingUrl fulfillmentHistory')
      .lean();
    if (!order) return res.status(404).json({ error: 'No paid order matched that order number and email.' });
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
      status: 'paid'
    }).select('orderNumber customerEmail items').lean();

    if (!order) {
      return res.status(404).json({
        error: 'No paid order matched that order ID and email.'
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

// Only list e-books included in the order attached to this session.
app.get('/api/ebooks', requireEbookSession, async (req, res) => {
  try {
    const order = await Order.findOne({
      orderNumber: req.ebookOrderNumber,
      customerEmail: req.ebookEmail,
      status: 'paid'
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
  const unsigned = `${enc({alg:'RS256',typ:'JWT'})}.${enc({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/drive.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})}`;
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
    const book = EBOOKS[bookId];
    if (!book) return res.status(404).json({ error: 'E-book not found.' });

    const order = await Order.findOne({
      orderNumber: req.ebookOrderNumber,
      customerEmail: req.ebookEmail,
      status: 'paid',
      'items.id': bookId
    }).select('_id').lean();

    if (!order) {
      return res.status(403).json({
        error: 'This e-book is not included in your verified paid order.'
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
    const { items, customerEmail, shippingAddress } = req.body;
    console.log("CHECKOUT REQUEST:", JSON.stringify(req.body, null, 2));

    if (
      !customerEmail ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({
        error: 'Valid email and non-empty cart are required.'
      });
    }

    let totalRupees = 0;
    const verifiedItems = [];


    for (const item of items) {
      const book = BOOKS.find(b => b.id === item.id);

      if (!book) {
        return res.status(400).json({
          error: `Invalid book ID: ${item.id}`
        });
      }

      const quantity = Number(item.quantity);

      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        return res.status(400).json({
          error: `Invalid quantity for ${book.name}`
        });
      }

      totalRupees += book.price * quantity;

      verifiedItems.push({
        id: book.id,
        name: book.name,
        price: book.price,
        quantity,
        type: book.type
      });
    }

    const amountPaise = Math.round(totalRupees * 100);

    console.log('Verified cart:', verifiedItems);
    console.log('Razorpay amount:', amountPaise, 'paise');
    console.log('Cart total:', totalRupees, 'INR');

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
      orderNumber: generateOrderNumber(),
      status: 'created'
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
    return res.status(500).json({
      error: 'Failed to create payment order.'
    });
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

