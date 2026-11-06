// Customer order lookup for order-status.html (POST /api/order-status).
(() => {
  const form = document.getElementById('order-lookup-form');
  if (!form) return;

  const $ = id => document.getElementById(id);
  const message = $('lookup-message');
  const result = $('lookup-result');
  const submit = $('lookup-submit');
  const STAGES = ['Order Received', 'Order Confirmed', 'Shipped', 'Delivered'];
  const STAGE_LABELS = {
    'Order Received': 'Order received',
    'Order Confirmed': 'Confirmed',
    Shipped: 'Shipped',
    Delivered: 'Delivered'
  };

  const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value) || 0);
  const date = value => {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };
  const safeUrl = value => {
    try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
  };

  const setMessage = (text, tone) => {
    message.textContent = text;
    message.className = `text-sm ${tone === 'error' ? 'text-red-700' : 'text-slate-600'}`;
  };

  function render(order) {
    result.replaceChildren();
    const card = el('div', 'mt-2 space-y-6 border-t border-[#efeae0] pt-6');

    const head = el('div', 'flex flex-wrap items-start justify-between gap-3');
    const meta = el('div');
    meta.append(
      el('p', 'text-xs font-bold uppercase tracking-widest text-[#a77a2d]', 'Order'),
      el('p', 'mt-1 break-all font-display text-xl font-semibold text-[#101b35]', order.orderNumber),
      el('p', 'mt-1 text-sm text-slate-500', `Placed ${date(order.createdAt)}`)
    );
    const digital = order.fulfillmentStatus === 'Digital Delivery';
    const status = order.fulfillmentStatus === 'In Transit' ? 'Shipped' : order.fulfillmentStatus;
    head.append(meta, el('span', 'rounded-full bg-[#faf3e3] px-3 py-1 text-sm font-bold text-[#73511b]', digital ? 'E-book — ready to read' : STAGE_LABELS[status] || status));
    card.append(head);

    if (!digital) {
      const current = Math.max(0, STAGES.indexOf(status));
      const steps = el('ol', 'grid grid-cols-4 gap-2');
      steps.setAttribute('aria-label', 'Delivery progress');
      STAGES.forEach((stage, index) => {
        const done = index <= current;
        const li = el('li', 'text-center');
        const bar = el('div', `h-1.5 rounded-full ${done ? 'bg-[#d6ad60]' : 'bg-slate-200'}`);
        const label = el('p', `mt-2 text-xs font-semibold ${done ? 'text-[#101b35]' : 'text-slate-400'}`, STAGE_LABELS[stage]);
        if (index === current) li.setAttribute('aria-current', 'step');
        li.append(bar, label);
        steps.append(li);
      });
      card.append(steps);

      if (order.courierName || order.trackingNumber) {
        const tracking = el('div', 'rounded-xl bg-[#f7f7f5] p-4 text-sm');
        tracking.append(el('p', 'font-semibold text-[#101b35]', 'Shipment'));
        if (order.courierName) tracking.append(el('p', 'mt-1 text-slate-600', `Courier: ${order.courierName}`));
        if (order.trackingNumber) tracking.append(el('p', 'text-slate-600 break-all', `Tracking number: ${order.trackingNumber}`));
        const url = safeUrl(order.trackingUrl);
        if (url) {
          const a = el('a', 'mt-2 inline-block font-semibold text-[#101b35] underline decoration-[#d6ad60] underline-offset-4', 'Track with courier ↗');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          tracking.append(a);
        }
        card.append(tracking);
      }
    } else {
      const note = el('p', 'rounded-xl bg-[#f7f7f5] p-4 text-sm text-slate-600', 'This is a digital order. ');
      const a = el('a', 'font-semibold text-[#101b35] underline decoration-[#d6ad60] underline-offset-4', 'Open My E-books →');
      a.href = 'ebooks.html';
      note.append(a);
      card.append(note);
    }

    const items = el('div', 'space-y-2');
    items.append(el('p', 'text-sm font-semibold text-[#101b35]', 'Items'));
    for (const item of order.items || []) {
      const row = el('div', 'flex justify-between gap-4 text-sm text-slate-600');
      const qty = Number(item.quantity) || 1;
      row.append(el('span', '', `${item.name || item.id || 'Book'} × ${qty}`), el('span', 'shrink-0', money((Number(item.price) || 0) * qty)));
      items.append(row);
    }
    const total = el('div', 'flex justify-between border-t border-[#efeae0] pt-2 font-bold text-[#101b35]');
    total.append(el('span', '', 'Total'), el('span', '', money(order.amountTotal)));
    items.append(total);
    card.append(items);

    result.append(card);
    result.classList.remove('hidden');
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const orderNumber = $('lookup-order-number').value.trim();
    const email = $('lookup-email').value.trim();
    if (!orderNumber || !email) return;

    submit.disabled = true;
    submit.textContent = 'Looking up your order…';
    result.classList.add('hidden');
    setMessage('');
    try {
      const response = await fetch(`${API_URL}/api/order-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber, email }),
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not look up this order. Please try again.');
      render(data);
    } catch (error) {
      setMessage(error.message === 'Failed to fetch' ? 'Could not reach the store. Please check your connection and try again.' : error.message, 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Find my order';
    }
  });
})();
