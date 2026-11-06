// Reader reviews: list approved reviews and submit new ones.
// Used by reviews.html (list + form) and book-details.html (list for one book).
const ReviewUI = (() => {
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = text;
    return node;
  };

  const stars = rating => '★'.repeat(rating) + '☆'.repeat(5 - rating);

  function card(review, { showBook = true } = {}) {
    const rating = Math.min(5, Math.max(1, Math.round(Number(review.rating) || 0)));
    const figure = el('figure', 'surface-card review-card');
    if (showBook && review.bookTitle) figure.append(el('span', 'review-tag', review.bookTitle));
    const starRow = el('div', 'review-stars', stars(rating));
    starRow.setAttribute('role', 'img');
    starRow.setAttribute('aria-label', `${rating} out of 5 stars`);
    figure.append(starRow);
    if (review.title) figure.append(el('p', 'font-semibold text-[#101b35]', review.title));
    const quote = el('blockquote', 'review-card__text', review.text);
    figure.append(quote);

    const caption = el('figcaption', 'border-t border-[#efeae0] pt-4 text-sm');
    caption.append(el('span', 'block font-semibold text-[#101b35]', review.name));
    const meta = el('span', 'text-slate-500');
    const date = new Date(review.createdAt);
    const parts = [];
    if (review.verified) parts.push('✓ Verified purchase');
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }));
    meta.textContent = parts.join(' · ');
    caption.append(meta);
    figure.append(caption);
    return figure;
  }

  const enabled = () => typeof REVIEWS_API_URL === 'string' && /^https:\/\//.test(REVIEWS_API_URL);

  async function fetchReviews(bookId) {
    if (!enabled()) return [];
    const url = new URL(REVIEWS_API_URL);
    url.searchParams.set('action', 'list');
    if (bookId) url.searchParams.set('bookId', bookId);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Reviews request failed (${response.status})`);
    const data = await response.json();
    if (data && data.error) throw new Error(data.error);
    return Array.isArray(data) ? data : [];
  }

  // Apps Script cannot answer CORS preflights, so send JSON as text/plain.
  async function post(payload) {
    if (!enabled()) throw new Error('Reviews are not open yet. Please try again soon.');
    const response = await fetch(REVIEWS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || 'Could not reach the review service. Please try again.');
    return data;
  }

  function summary(reviews) {
    if (!reviews.length) return '';
    const avg = reviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / reviews.length;
    return `★ ${avg.toFixed(1)} average · ${reviews.length} review${reviews.length === 1 ? '' : 's'}`;
  }

  return { card, fetchReviews, summary, post, enabled };
})();

// Reviews page: approved reviews list.
(() => {
  const section = document.getElementById('latest-reviews');
  const list = document.getElementById('reviews-list');
  const more = document.getElementById('reviews-more');
  if (!section || !list) return;
  const PAGE = 9;
  let reviews = [];
  let shown = 0;

  const showNext = () => {
    reviews.slice(shown, shown + PAGE).forEach(r => list.append(ReviewUI.card(r)));
    shown = Math.min(reviews.length, shown + PAGE);
    more.classList.toggle('hidden', shown >= reviews.length);
  };
  more?.addEventListener('click', showNext);

  ReviewUI.fetchReviews()
    .then(data => {
      reviews = data;
      if (!reviews.length) return;
      document.getElementById('reviews-summary').textContent = ReviewUI.summary(reviews);
      section.classList.remove('hidden');
      showNext();
    })
    .catch(error => console.warn('Reviews unavailable:', error));
})();

// Reviews page: submission form.
(() => {
  const form = document.getElementById('review-form');
  if (!form) return;
  const $ = id => document.getElementById(id);
  const select = $('review-book');
  const message = $('review-message');
  const submit = $('review-submit');
  const text = $('review-text');
  const requested = new URLSearchParams(location.search).get('book');

  const setMessage = (value, tone) => {
    message.textContent = value;
    message.className = `text-sm ${tone === 'error' ? 'text-red-700' : tone === 'success' ? 'font-semibold text-emerald-700' : 'text-slate-600'}`;
  };

  text.addEventListener('input', () => { $('review-count').textContent = `${text.value.length} / 2000`; });

  if (!ReviewUI.enabled()) {
    submit.disabled = true;
    submit.textContent = 'Reviews open soon';
    setMessage('Review submissions are not switched on yet. Please check back soon.');
  }

  async function loadBooks() {
    let books = [];
    try {
      const r = await fetch(`${API_URL}/api/catalog`, { cache: 'no-store' });
      if (r.ok) books = await r.json();
    } catch {}
    if (!Array.isArray(books) || !books.length) {
      try { const r = await fetch('catalog.json', { cache: 'no-store' }); if (r.ok) books = await r.json(); } catch {}
    }
    select.replaceChildren();
    const placeholder = new Option('Choose a book', '');
    select.append(placeholder);
    for (const book of Array.isArray(books) ? books : []) {
      const id = book.pbId || book.ebId;
      if (!id) continue;
      const option = new Option(book.title || 'Untitled', id);
      if (requested && [book.pbId, book.ebId].includes(requested)) option.selected = true;
      select.append(option);
    }
    if (select.options.length === 1) placeholder.textContent = 'Books unavailable — please refresh';
  }
  loadBooks();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const orderNumber = (data.orderNumber || '').trim();
    const email = (data.email || '').trim();
    if (Boolean(orderNumber) !== Boolean(email)) {
      form.querySelector('details').open = true;
      setMessage('To verify your purchase, enter both your order number and checkout email — or leave both empty.', 'error');
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Submitting…';
    setMessage('');
    try {
      await ReviewUI.post({
        action: 'submit',
        bookId: data.bookId,
        bookTitle: select.options[select.selectedIndex]?.text || '',
        name: (data.name || '').trim(),
        rating: Number(data.rating),
        title: (data.title || '').trim(),
        text: (data.text || '').trim(),
        orderNumber,
        email,
        website: data.website || ''
      });
      form.reset();
      $('review-count').textContent = '0 / 2000';
      setMessage('Thank you! Your review has been received and will appear once it has been checked.', 'success');
    } catch (error) {
      setMessage(error.message === 'Failed to fetch' ? 'Could not reach the store. Please check your connection and try again.' : error.message, 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Submit review';
    }
  });
})();
