// End-to-end tests for the store API against a fake Google Sheets backend.
// Run with: npm test
const assert = require('assert');
const crypto = require('crypto');
const { createFakeSheets } = require('./fake-sheets');
const { createStore } = require('../store');
const { createApp, seedIfEmpty } = require('../server');

const ENV = {
  ADMIN_TOKEN: 'admin-test-token',
  SESSION_SECRET: 'session-test-secret',
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  SMTP_HOST: 'smtp.test', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'store@test'
};

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.stack}`);
    process.exitCode = 1;
  }
}

async function main() {
  const sheets = createFakeSheets();
  sheets.tabs.set('Reviews', [['id', 'status'], ['r1', 'approved']]); // must never be touched
  const store = createStore({ spreadsheetId: 'test-sheet', getAccessToken: async () => 'token', fetch: sheets.fetch, refreshMs: 0, log: { warn() {}, log() {}, error() {} } });
  const mail = [];
  let rzpCounter = 0;
  const app = createApp({
    store,
    env: ENV,
    razorpay: { orders: { create: async ({ amount, currency }) => ({ id: `order_test_${++rzpCounter}`, amount, currency }) } },
    mailer: { sendMail: async m => { mail.push(m); } },
    getAccessToken: async () => 'token',
    log: { log() {}, warn() {}, error() {} }
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const admin = { Authorization: `Bearer ${ENV.ADMIN_TOKEN}` };
  const sign = (orderId, paymentId) => crypto.createHmac('sha256', ENV.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  const rows = title => sheets.read(`'${title}'!A1:ZZ`);
  const header = title => rows(title)[0];
  const cell = (title, keyCol, key, col) => {
    const r = rows(title);
    const h = r[0];
    return r.find(x => x[h.indexOf(keyCol)] === key)?.[h.indexOf(col)];
  };

  console.log('Start-up');
  await test('API answers 503 until the Sheet is loaded', async () => {
    const r = await call('GET', '/api/catalog');
    assert.equal(r.status, 503);
  });
  await test('creates tabs with headers and seeds the default books', async () => {
    await store.db.init();
    await seedIfEmpty(store);
    for (const t of ['Orders', 'Sales', 'Books', 'Prices']) assert.ok(sheets.tabs.has(t), `${t} tab`);
    assert.deepEqual(header('Books').slice(0, 4), ['id', 'sortOrder', 'title', 'published']);
    assert.equal(rows('Books').length, 4);
    assert.deepEqual(rows('Reviews'), [['id', 'status'], ['r1', 'approved']]);
  });

  console.log('Catalogue');
  await test('public catalogue lists books and creates price rows', async () => {
    const r = await call('GET', '/api/catalog');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(b => b.title), ['KaalYug: Shadows of Dark Web', 'Pages of Us', 'The Indestructible Kali']);
    assert.equal(r.body[0].pbPrice, 249);
    assert.equal(rows('Prices').length, 7);
  });
  await test('parallel first requests do not duplicate price rows', async () => {
    await Promise.all([call('GET', '/api/books'), call('GET', '/api/catalog'), call('GET', '/api/books')]);
    assert.equal(rows('Prices').length, 7);
  });

  console.log('Admin catalogue');
  let newBookId;
  await test('admin endpoints reject a wrong token', async () => {
    assert.equal((await call('GET', '/api/admin/books', undefined, { Authorization: 'Bearer nope' })).status, 401);
  });
  await test('adds a book; formula-like text is stored as plain text', async () => {
    const r = await call('POST', '/api/admin/books', { title: '=HYPERLINK("http://x","y")', desc: 'New', pbPrice: 199, ebPrice: 49, trailers: 'https://youtu.be/abc\nhttps://www.youtube.com/watch?v=def', sellPaperback: true, sellEbook: true, published: true }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    newBookId = r.body.book.id;
    assert.equal(cell('Books', 'id', newBookId, 'title'), '=HYPERLINK("http://x","y")');
    assert.equal(cell('Books', 'id', newBookId, 'trailers'), 'https://youtu.be/abc\nhttps://www.youtube.com/watch?v=def');
    assert.ok(sheets.log.filter(l => l.method === 'POST' && /append|batchUpdate/.test(l.path) && l.body?.data).every(l => l.body.valueInputOption === 'RAW'));
  });
  await test('edits, reorders and unpublishes books', async () => {
    let r = await call('PUT', `/api/admin/books/${newBookId}`, { title: 'Fourth Book', desc: 'Edited', pbPrice: 199, ebPrice: 49 }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = (await call('GET', '/api/admin/books', undefined, admin)).body;
    const order = [newBookId, ...list.map(b => b.id).filter(id => id !== newBookId)];
    r = await call('PUT', '/api/admin/books/order', { order }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call('GET', '/api/catalog')).body[0].title, 'Fourth Book');
    r = await call('DELETE', `/api/admin/books/${newBookId}`, undefined, admin);
    assert.equal(r.status, 200);
    assert.ok(!(await call('GET', '/api/catalog')).body.some(b => b.id === newBookId));
    assert.equal(cell('Books', 'id', newBookId, 'published'), false);
  });
  await test('price validation and update', async () => {
    let r = await call('PUT', '/api/admin/prices', { prices: [{ bookId: 'book_1_pb', mrp: 100, currentPrice: 200 }] }, admin);
    assert.equal(r.status, 400);
    r = await call('PUT', '/api/admin/prices', { prices: [{ bookId: 'book_1_pb', mrp: 299, currentPrice: 249 }, { bookId: 'book_1_eb', mrp: 49, currentPrice: 25 }] }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(cell('Prices', 'bookId', 'book_1_pb', 'mrp'), 299);
  });

  console.log('Checkout');
  let paidOrder;
  await test('paperback orders need a shipping address', async () => {
    const r = await call('POST', '/api/create-order', { customerEmail: 'reader@example.com', items: [{ id: 'book_1_pb', quantity: 1 }] });
    assert.equal(r.status, 400);
  });
  await test('rejects unknown books, bad quantities and unpublished books', async () => {
    assert.equal((await call('POST', '/api/create-order', { customerEmail: 'a@b.co', items: [{ id: 'nope', quantity: 1 }] })).status, 400);
    assert.equal((await call('POST', '/api/create-order', { customerEmail: 'a@b.co', items: [{ id: 'book_1_eb', quantity: 0 }] })).status, 400);
    const hidden = cell('Books', 'id', newBookId, 'ebId');
    assert.equal((await call('POST', '/api/create-order', { customerEmail: 'a@b.co', items: [{ id: hidden, quantity: 1 }] })).status, 400);
  });
  await test('creates a Razorpay order with server-side prices', async () => {
    const r = await call('POST', '/api/create-order', {
      customerEmail: ' Reader@Example.com ',
      items: [{ id: 'book_1_pb', quantity: 2, price: 1 }, { id: 'book_1_eb', quantity: 1 }],
      shippingAddress: { address: '12 MG Road', city: 'Hyderabad', pincode: '500001' }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, (249 * 2 + 25) * 100);
    paidOrder = r.body;
    assert.equal(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'status'), 'created');
    assert.equal(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'shipCity'), 'Hyderabad');
    assert.equal(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'customerEmail'), 'reader@example.com');
    assert.match(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'items'), /KaalYug.*× 2/);
    assert.equal(rows('Sales').length, 1, 'only the header row: unpaid orders are not sales');
  });
  await test('rejects a forged payment signature', async () => {
    const r = await call('POST', '/api/verify-payment', { razorpay_order_id: paidOrder.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'ab'.repeat(32) });
    assert.equal(r.status, 400);
    assert.equal(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'status'), 'created');
  });
  await test('verifies payment once, even when called twice at the same time', async () => {
    const body = { razorpay_order_id: paidOrder.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign(paidOrder.orderId, 'pay_1') };
    const [a, b] = await Promise.all([call('POST', '/api/verify-payment', body), call('POST', '/api/verify-payment', body)]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'status'), 'paid');
    assert.equal(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'fulfillmentStatus'), 'Order Received');
    const saleRows = rows('Sales').slice(1);
    assert.equal(saleRows.length, 2, 'one Sales row per book');
    const h = header('Sales');
    const pb = saleRows.find(r => r[h.indexOf('bookId')] === 'book_1_pb');
    assert.equal(pb[h.indexOf('lineTotal')], 498);
    assert.equal(pb[h.indexOf('format')], 'Paperback');
    assert.equal(pb[h.indexOf('book')], 'KaalYug: Shadows of Dark Web');
    assert.equal(mail.filter(m => m.subject.startsWith('Order Confirmation')).length, 1, 'one confirmation email');
    assert.ok(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'confirmationEmailSentAt'));
  });
  await test('a different payment for a paid order is refused', async () => {
    const r = await call('POST', '/api/verify-payment', { razorpay_order_id: paidOrder.orderId, razorpay_payment_id: 'pay_2', razorpay_signature: sign(paidOrder.orderId, 'pay_2') });
    assert.equal(r.status, 409);
  });
  await test('free orders complete immediately and are recorded as sales', async () => {
    await call('PUT', '/api/admin/prices', { prices: [{ bookId: 'book_2_eb', mrp: 25, currentPrice: 0 }] }, admin);
    const r = await call('POST', '/api/create-order', { customerEmail: 'free@example.com', items: [{ id: 'book_2_eb', quantity: 1 }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.freeOrder, true);
    assert.equal(cell('Orders', 'orderNumber', r.body.orderNumber, 'status'), 'completed');
    assert.equal(cell('Orders', 'orderNumber', r.body.orderNumber, 'fulfillmentStatus'), 'Digital Delivery');
    assert.equal(cell('Sales', 'saleId', `${r.body.orderNumber}-book_2_eb`, 'paymentId'), 'FREE');
  });

  console.log('Customers');
  await test('order status lookup needs the matching email', async () => {
    assert.equal((await call('POST', '/api/order-status', { orderNumber: paidOrder.orderNumber, email: 'other@example.com' })).status, 404);
    const r = await call('POST', '/api/order-status', { orderNumber: paidOrder.orderNumber, email: 'READER@example.com' });
    assert.equal(r.status, 200);
    assert.equal(r.body.fulfillmentStatus, 'Order Received');
    assert.equal(r.body.items.length, 2);
  });
  let ebookToken;
  await test('e-book access lists only purchased e-books', async () => {
    assert.equal((await call('POST', '/api/ebooks/access', { orderNumber: paidOrder.orderNumber, email: 'x@example.com' })).status, 401);
    const r = await call('POST', '/api/ebooks/access', { orderNumber: paidOrder.orderNumber, email: 'reader@example.com' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.ebooks.map(b => b.id), ['book_1_eb']);
    ebookToken = r.body.token;
    const list = await call('GET', '/api/ebooks', undefined, { Authorization: `Bearer ${ebookToken}` });
    assert.deepEqual(list.body.ebooks.map(b => b.id), ['book_1_eb']);
    assert.equal((await call('GET', '/api/ebooks', undefined, { Authorization: 'Bearer forged.token' })).status, 401);
  });
  await test('cannot stream an e-book that was not bought', async () => {
    const r = await call('GET', '/api/ebooks/book_3_eb/pdf', undefined, { Authorization: `Bearer ${ebookToken}` });
    assert.equal(r.status, 403);
  });

  console.log('Fulfilment');
  await test('admin order list shows paid orders newest first', async () => {
    const r = await call('GET', '/api/orders', undefined, admin);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2);
    assert.ok(r.body.every(o => ['paid', 'completed'].includes(o.status)));
  });
  await test('status moves one step at a time and needs tracking to ship', async () => {
    const path = `/api/orders/${paidOrder.orderNumber}/fulfillment`;
    assert.equal((await call('PATCH', path, { fulfillmentStatus: 'Delivered', courierName: 'X', trackingNumber: '1' }, admin)).status, 400);
    assert.equal((await call('PATCH', path, { fulfillmentStatus: 'Order Confirmed' }, admin)).status, 200);
    assert.equal((await call('PATCH', path, { fulfillmentStatus: 'Shipped' }, admin)).status, 400);
    const r = await call('PATCH', path, { fulfillmentStatus: 'Shipped', courierName: 'India Post', trackingNumber: 'EE123IN' }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.order.fulfillmentHistory.length, 3);
    assert.equal(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'trackingNumber'), 'EE123IN');
  });

  console.log('Editing the Sheet by hand');
  await test('sorting rows by hand does not make the server update the wrong row', async () => {
    // Add more orders, then reverse the data rows as if sorted in Google Sheets.
    for (let i = 0; i < 3; i++) {
      await call('POST', '/api/create-order', { customerEmail: `buyer${i}@example.com`, items: [{ id: 'book_3_eb', quantity: 1 }] });
    }
    const tab = sheets.tabs.get('Orders');
    sheets.tabs.set('Orders', [tab[0], ...tab.slice(1).reverse()]);
    const r = await call('PATCH', `/api/orders/${paidOrder.orderNumber}/fulfillment`, { fulfillmentStatus: 'Delivered', courierName: 'India Post', trackingNumber: 'EE123IN' }, admin);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(cell('Orders', 'orderNumber', paidOrder.orderNumber, 'fulfillmentStatus'), 'Delivered');
    const others = rows('Orders').slice(1).filter(x => x[0] !== paidOrder.orderNumber);
    const fs = header('Orders').indexOf('fulfillmentStatus');
    assert.ok(others.every(x => x[fs] !== 'Delivered'), 'no other order was changed');
  });
  await test('moving columns and editing cells by hand is picked up on refresh', async () => {
    const tab = sheets.tabs.get('Books');
    const ti = tab[0].indexOf('title');
    for (const row of tab) { const [t] = row.splice(ti, 1); row.push(t); } // move "title" to the end
    const h = tab[0];
    const kaal = tab.find(r => r[h.indexOf('pbId')] === 'book_1_pb');
    kaal[h.indexOf('title')] = 'KaalYug (edited in Sheet)';
    tab.push([]); // a stray empty row
    assert.equal(await store.db.loadAll(), true);
    const r = await call('GET', '/api/catalog');
    assert.ok(r.body.some(b => b.title === 'KaalYug (edited in Sheet)'));
    // A later server write lands in the moved column.
    await call('PUT', `/api/admin/books/${kaal[h.indexOf('id')]}`, { title: 'KaalYug: Shadows of Dark Web', pbPrice: 249, ebPrice: 25 }, admin);
    assert.equal(sheets.tabs.get('Books').find(r => r[h.indexOf('pbId')] === 'book_1_pb')[h.indexOf('title')], 'KaalYug: Shadows of Dark Web');
  });
  await test('a deleted header column is restored on start-up', async () => {
    const tab = sheets.tabs.get('Prices');
    const i = tab[0].indexOf('updatedAt');
    tab[0][i] = '';
    const fresh = createStore({ spreadsheetId: 'test-sheet', getAccessToken: async () => 'token', fetch: sheets.fetch, refreshMs: 0, log: { warn() {}, log() {}, error() {} } });
    await fresh.db.init();
    assert.ok(sheets.tabs.get('Prices')[0].includes('updatedAt'));
    assert.equal(fresh.prices.count(), store.prices.count());
  });
  await test('dates are readable in the Sheet and survive a reload', async () => {
    const created = cell('Orders', 'orderNumber', paidOrder.orderNumber, 'createdAt');
    assert.match(created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const fresh = createStore({ spreadsheetId: 'test-sheet', getAccessToken: async () => 'token', fetch: sheets.fetch, refreshMs: 0, log: { warn() {}, log() {}, error() {} } });
    await fresh.db.init();
    const a = store.orders.get(paidOrder.orderNumber).createdAt.getTime();
    const b = fresh.orders.get(paidOrder.orderNumber).createdAt.getTime();
    assert.ok(Math.abs(a - b) < 1000, 'within a second (sheet stores whole seconds)');
    assert.deepEqual(fresh.orders.get(paidOrder.orderNumber).items, store.orders.get(paidOrder.orderNumber).items);
  });
  await test('the Reviews tab was never touched', async () => {
    assert.deepEqual(rows('Reviews'), [['id', 'status'], ['r1', 'approved']]);
  });

  server.close();
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
}

main().catch(error => { console.error(error); process.exit(1); });
