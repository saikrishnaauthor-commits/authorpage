// The store's tables in Google Sheets. Column order here is only used when a
// tab is first created; afterwards columns are matched by their header names.
const { SheetsDB } = require('./sheets-db');

const money = n => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function itemsSummary(items) {
  return (items || []).map(i => `${i.name || i.id} × ${i.quantity || 1} (${money(i.price)})`).join('; ');
}

const isPaperbackItem = item => String(item.type || item.id || '').toLowerCase().includes('paperback') || String(item.id || '').endsWith('_pb');

// One Sales row per book in a paid/completed order.
function salesRows(order) {
  return (order.items || []).map(item => {
    const quantity = Number(item.quantity) || 1;
    const unitPrice = Number(item.price) || 0;
    return {
      saleId: `${order.orderNumber}-${item.id}`,
      date: order.createdAt || new Date(),
      orderNumber: order.orderNumber,
      customerEmail: order.customerEmail,
      book: String(item.name || item.id).replace(/\s*\((Paperback|E-Book)\)\s*$/i, ''),
      format: isPaperbackItem(item) ? 'Paperback' : 'E-book',
      bookId: item.id,
      quantity,
      unitPrice,
      mrp: Number(item.mrp) || unitPrice,
      lineTotal: unitPrice * quantity,
      paymentId: order.razorpayPaymentId || (Number(order.amountTotal) === 0 ? 'FREE' : ''),
      orderStatus: order.status
    };
  });
}

function createStore(options) {
  const db = new SheetsDB(options);

  // One row per order (including unpaid checkouts, status "created").
  const orders = db.define({
    name: 'Orders',
    key: 'orderNumber',
    columns: [
      ['orderNumber'], ['createdAt', 'date'], ['status'], ['customerEmail'], ['items'], ['amountTotal', 'number'],
      ['fulfillmentStatus'], ['courierName'], ['trackingNumber'], ['trackingUrl'],
      ['shipAddress'], ['shipCity'], ['shipPincode'],
      ['razorpayOrderId'], ['razorpayPaymentId'], ['confirmationEmailSentAt', 'date'], ['updatedAt', 'date'],
      ['itemsJson', 'json'], ['fulfillmentHistoryJson', 'json']
    ],
    toRow: o => ({
      ...o,
      items: itemsSummary(o.items),
      itemsJson: o.items || [],
      fulfillmentHistoryJson: o.fulfillmentHistory || [],
      shipAddress: o.shippingAddress?.address || '',
      shipCity: o.shippingAddress?.city || '',
      shipPincode: o.shippingAddress?.pincode || ''
    }),
    fromRow: r => ({
      orderNumber: r.orderNumber,
      createdAt: r.createdAt,
      status: r.status || 'created',
      customerEmail: String(r.customerEmail || '').trim().toLowerCase(),
      items: Array.isArray(r.itemsJson) ? r.itemsJson : [],
      amountTotal: r.amountTotal ?? 0,
      fulfillmentStatus: r.fulfillmentStatus || '',
      courierName: r.courierName,
      trackingNumber: r.trackingNumber,
      trackingUrl: r.trackingUrl,
      shippingAddress: r.shipAddress || r.shipCity || r.shipPincode
        ? { address: r.shipAddress, city: r.shipCity, pincode: r.shipPincode }
        : null,
      razorpayOrderId: r.razorpayOrderId,
      razorpayPaymentId: r.razorpayPaymentId,
      confirmationEmailSentAt: r.confirmationEmailSentAt,
      updatedAt: r.updatedAt,
      fulfillmentHistory: Array.isArray(r.fulfillmentHistoryJson) ? r.fulfillmentHistoryJson : []
    })
  });

  // One row per book in a paid/completed order: the sales report.
  const sales = db.define({
    name: 'Sales',
    key: 'saleId',
    columns: [
      ['saleId'], ['date', 'date'], ['orderNumber'], ['customerEmail'], ['book'], ['format'], ['bookId'],
      ['quantity', 'number'], ['unitPrice', 'number'], ['mrp', 'number'], ['lineTotal', 'number'],
      ['paymentId'], ['orderStatus']
    ]
  });

  const books = db.define({
    name: 'Books',
    key: 'id',
    columns: [
      ['id'], ['sortOrder', 'number', { default: 0 }], ['title'], ['published', 'boolean', { default: true }], ['series'],
      ['pbId'], ['ebId'], ['pbPrice', 'number', { default: 0 }], ['ebPrice', 'number', { default: 0 }],
      ['sellPaperback', 'boolean', { default: true }], ['sellEbook', 'boolean', { default: true }],
      ['desc'], ['image'], ['ebookDriveFileId'], ['ebookEpubDriveFileId'], ['trailers'],
      ['amazonUrl'], ['flipkartUrl'], ['pothiUrl'],
      ['sampleTitle'], ['sampleSubtitle'], ['sampleText'], ['createdAt', 'date'], ['updatedAt', 'date']
    ],
    // Trailers are stored one URL per line so the cell stays readable.
    toRow: b => ({ ...b, trailers: (b.trailers || []).join('\n') }),
    fromRow: r => ({
      ...r,
      series: r.series || '',
      trailers: String(r.trailers || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    })
  });

  const prices = db.define({
    name: 'Prices',
    key: 'bookId',
    columns: [['bookId'], ['name'], ['type'], ['mrp', 'number', { default: 0 }], ['currentPrice', 'number', { default: 0 }], ['updatedAt', 'date']]
  });

  return { db, orders, sales, books, prices, itemsSummary };
}

module.exports = { createStore, itemsSummary, salesRows, isPaperbackItem };
