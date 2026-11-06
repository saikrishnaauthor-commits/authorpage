// One-time copy of the old MongoDB store data into the Google Sheet.
//
//   npm run migrate -- --dry-run     show what would be copied, write nothing
//   npm run migrate                  copy into empty Orders/Sales/Books/Prices tabs
//   npm run migrate -- --replace     clear those four tabs first, then copy
//
// Needs MONGO_URI, GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_JSON in .env.
// The Reviews tab (Apps Script) is never touched.
require('dotenv').config();

const mongoose = require('mongoose');
const { createStore, salesRows } = require('./store');
const { getGoogleAccessToken } = require('./google-auth');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const REPLACE = args.has('--replace');
const PAID = new Set(['paid', 'completed']);

const toDate = v => (v ? new Date(v) : null);
const str = v => (v == null ? '' : String(v));

function shippingFrom(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { address: raw, city: '', pincode: '' };
  const { address = '', city = '', pincode = '', ...rest } = raw;
  const extra = Object.entries(rest).filter(([, v]) => v != null && String(v).trim()).map(([k, v]) => `${k}: ${v}`).join(', ');
  return { address: [address, extra].filter(Boolean).join(' · '), city: str(city), pincode: str(pincode) };
}

async function main() {
  for (const name of ['MONGO_URI', 'GOOGLE_SHEETS_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON']) {
    if (!process.env[name]) throw new Error(`Missing ${name} in .env`);
  }

  console.log('Reading MongoDB…');
  await mongoose.connect(process.env.MONGO_URI);
  const mdb = mongoose.connection.db;
  const [rawOrders, rawBooks, rawPrices] = await Promise.all([
    mdb.collection('orders').find({}).sort({ createdAt: 1 }).toArray(),
    mdb.collection('catalogbooks').find({}).sort({ sortOrder: 1, createdAt: 1 }).toArray(),
    mdb.collection('bookprices').find({}).toArray()
  ]);
  await mongoose.disconnect();

  const seen = new Set();
  const orders = [];
  let skipped = 0;
  for (const o of rawOrders) {
    // Very old orders may predate order numbers: give them a stable one from their ID.
    const orderNumber = str(o.orderNumber) || `LEGACY-${String(o._id).slice(-10).toUpperCase()}`;
    if (seen.has(orderNumber)) { skipped++; continue; }
    seen.add(orderNumber);
    orders.push({
      orderNumber,
      createdAt: toDate(o.createdAt) || new Date(),
      updatedAt: toDate(o.updatedAt) || toDate(o.createdAt) || new Date(),
      status: str(o.status) || 'created',
      customerEmail: str(o.customerEmail).trim().toLowerCase(),
      items: Array.isArray(o.items) ? o.items : [],
      amountTotal: Number(o.amountTotal) || 0,
      fulfillmentStatus: str(o.fulfillmentStatus),
      courierName: str(o.courierName),
      trackingNumber: str(o.trackingNumber),
      trackingUrl: str(o.trackingUrl),
      shippingAddress: shippingFrom(o.shippingAddress),
      razorpayOrderId: str(o.razorpayOrderId),
      razorpayPaymentId: str(o.razorpayPaymentId),
      confirmationEmailSentAt: toDate(o.confirmationEmailSentAt),
      fulfillmentHistory: (Array.isArray(o.fulfillmentHistory) ? o.fulfillmentHistory : [])
        .map(h => ({ ...h, at: h.at ? new Date(h.at).toISOString() : undefined }))
    });
  }

  const books = rawBooks.map((b, i) => ({
    id: String(b._id),
    sortOrder: Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : i,
    title: str(b.title), published: b.published !== false, series: str(b.series),
    pbId: str(b.pbId), ebId: str(b.ebId), pbPrice: Number(b.pbPrice) || 0, ebPrice: Number(b.ebPrice) || 0,
    sellPaperback: b.sellPaperback !== false, sellEbook: b.sellEbook !== false,
    desc: str(b.desc), image: str(b.image),
    ebookDriveFileId: str(b.ebookDriveFileId), ebookEpubDriveFileId: str(b.ebookEpubDriveFileId),
    trailers: Array.isArray(b.trailers) ? b.trailers.map(String) : [],
    amazonUrl: str(b.amazonUrl), flipkartUrl: str(b.flipkartUrl), pothiUrl: str(b.pothiUrl),
    sampleTitle: str(b.sampleTitle), sampleSubtitle: str(b.sampleSubtitle), sampleText: str(b.sampleText),
    createdAt: toDate(b.createdAt) || new Date(), updatedAt: toDate(b.updatedAt) || new Date()
  }));

  const titleOf = new Map(books.flatMap(b => [[b.pbId, [`${b.title} (Paperback)`, 'Paperback']], [b.ebId, [`${b.title} (E-Book)`, 'E-Book']]]));
  const prices = rawPrices.map(p => ({
    bookId: str(p.bookId),
    name: titleOf.get(str(p.bookId))?.[0] || '',
    type: titleOf.get(str(p.bookId))?.[1] || '',
    mrp: Number(p.mrp) || 0,
    currentPrice: Number(p.currentPrice) || 0,
    updatedAt: toDate(p.updatedAt) || new Date()
  })).filter(p => p.bookId);

  const sales = orders.filter(o => PAID.has(o.status)).flatMap(salesRows);
  const uniqueSales = [...new Map(sales.map(s => [s.saleId, s])).values()];

  const paid = orders.filter(o => PAID.has(o.status));
  console.log(`Found ${orders.length} orders (${paid.length} paid/completed), ${books.length} books, ${prices.length} prices → ${uniqueSales.length} sales rows.`);
  if (skipped) console.log(`Skipped ${skipped} duplicate order number(s).`);
  console.log(`Total paid revenue: ₹${paid.reduce((s, o) => s + o.amountTotal, 0).toLocaleString('en-IN')}`);
  if (DRY_RUN) { console.log('Dry run: nothing written.'); return; }

  const store = createStore({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, getAccessToken: getGoogleAccessToken, refreshMs: 0 });
  await store.db.init();
  const tables = [store.orders, store.sales, store.books, store.prices];
  const nonEmpty = tables.filter(t => t.count() > 0);
  if (nonEmpty.length && !REPLACE) {
    throw new Error(`These tabs already have data: ${nonEmpty.map(t => t.name).join(', ')}. ` +
      'Run again with --replace to clear them first (the Reviews tab is not affected).');
  }
  if (REPLACE && nonEmpty.length) {
    console.log(`Clearing ${nonEmpty.map(t => t.name).join(', ')}…`);
    await store.db.api('POST', '/values:batchClear', { ranges: nonEmpty.map(t => `'${t.name}'!A2:ZZ`) });
    await store.db.loadAll(true);
  }

  console.log('Writing to Google Sheets…');
  const CHUNK = 500;
  for (const [table, rows] of [[store.books, books], [store.prices, prices], [store.orders, orders], [store.sales, uniqueSales]]) {
    for (let i = 0; i < rows.length; i += CHUNK) await table.insertMany(rows.slice(i, i + CHUNK));
    console.log(`  ${table.name}: ${rows.length} rows`);
  }
  console.log('Done. Open the Sheet to check the data, then deploy the new server.');
}

main().catch(error => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
