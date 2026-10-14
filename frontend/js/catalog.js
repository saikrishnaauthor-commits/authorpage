async function fetchBooks() {
  let data = null;
  // Prefer the backend catalogue so admin changes appear on the live store without editing catalog.json.
  try {
    const response = await fetch(`${API_URL}/api/catalog`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`API catalogue request failed (${response.status})`);
    data = await response.json();
    if (!Array.isArray(data)) throw new Error('Backend catalogue must be an array');
  } catch (apiError) {
    console.warn('Backend catalogue unavailable; trying local catalog.json:', apiError);
    try {
      const response = await fetch('catalog.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`catalog.json request failed (${response.status})`);
      data = await response.json();
      if (!Array.isArray(data)) throw new Error('catalog.json must contain an array');
    } catch (error) {
      console.error('Could not load book catalogue:', error);
      const container = document.getElementById('books-container');
      if (container) container.innerHTML = `<p class="catalog-error">We couldn't load the book catalog. Please refresh the page.</p>`;
      return;
    }
  }
  catalog = data;
  if (typeof sampleChapters === 'object') {
    for (const book of catalog) {
      if (book.pbId && book.sampleText) sampleChapters[book.pbId] = { title: book.sampleTitle || book.title, subtitle: book.sampleSubtitle || 'Sample Chapter Preview', text: book.sampleText };
    }
  }
  renderBooks();
  if (typeof updateCartUI === 'function') updateCartUI();
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function renderBooks() {
  const container = document.getElementById('books-container');
  if (!container) { console.warn('No #books-container on this page.'); return; }
  if (!Array.isArray(catalog) || catalog.length === 0) {
    container.innerHTML = '<p>No books are available right now.</p>'; return;
  }
  container.innerHTML = catalog.map((book, index) => {
    const title = String(book.title || 'Untitled');
    const safeTitle = escapeHTML(title);
    const description = escapeHTML(book.desc || '');
    const image = escapeHTML(book.image || '');
    const pbPrice = Number(book.pbPrice) || 0;
    const ebPrice = Number(book.ebPrice) || 0;
    const pbId = escapeHTML(book.pbId || '');
    const ebId = escapeHTML(book.ebId || '');
    const isKaalYug = /kaalyug/i.test(title);
    const hasTextSample =
      typeof sampleChapters !== 'undefined' &&
      Boolean(sampleChapters[pbId]);

    const hasPdfSample =
      typeof samplePdfByBookId !== 'undefined' &&
      Boolean(samplePdfByBookId[pbId]);

    const previewButton = (hasTextSample || hasPdfSample)
      ? `<button class="preview-button" onclick="openPreview('${pbId}')">Read a sample chapter</button>`
      : '';
    const marketplaceLinks = [
      ['Amazon', book.amazonUrl, 'bg-amber-100 text-amber-900 hover:bg-amber-200'],
      ['Flipkart', book.flipkartUrl, 'bg-blue-100 text-blue-900 hover:bg-blue-200'],
      ['Pothi', book.pothiUrl, 'bg-emerald-100 text-emerald-900 hover:bg-emerald-200']
    ].filter(([label, url]) => typeof url === 'string' && /^https:\/\//i.test(url) &&
      ((label === 'Amazon' && /(^|\.)amazon\.(in|com|co\.uk|ca|com\.au)$/i.test(new URL(url).hostname)) ||
       (label === 'Flipkart' && /(^|\.)flipkart\.com$/i.test(new URL(url).hostname)) ||
       (label === 'Pothi' && /(^|\.)pothi\.com$/i.test(new URL(url).hostname))));
    const marketplaceButtons = marketplaceLinks.length ? `
      <div class="mt-3">
        <p class="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Also available from</p>
        <div class="flex flex-wrap gap-2">${marketplaceLinks.map(([label, url, cls]) =>
          `<a class="rounded-lg px-3 py-2 text-sm font-semibold ${cls}" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Buy on ${label} ↗</a>`
        ).join('')}</div>
      </div>` : '';
    const detailsLink = `<a class="mt-3 inline-flex text-sm font-semibold text-indigo-700 hover:text-indigo-900 underline underline-offset-4" href="book-details.html?id=${encodeURIComponent(book.pbId || book.ebId || book.id || '')}">View book details →</a>`;
    const trailers = isKaalYug ? `
      <div class="trailer-actions">
        <button class="trailer-button" onclick="openTrailer('videos/kaalyug-trailer-1.mp4', 'KaalYug — Trailer 1')"><span aria-hidden="true">▶</span> Watch Trailer 1</button>
        <button class="trailer-button trailer-button-secondary" onclick="openTrailer('videos/kaalyug-trailer-2.mp4', 'KaalYug — Trailer 2')"><span aria-hidden="true">▶</span> Watch Trailer 2</button>
      </div>` : '';
    return `
      <article class="premium-book-card">
        <div class="book-cover-wrap"><span class="book-number">BOOK ${String(index + 1).padStart(2, '0')}</span>
          <img src="${image}" alt="${safeTitle} book cover" class="book-cover" loading="lazy" onerror="this.style.display='none'; this.parentElement.classList.add('cover-missing')"><span class="cover-fallback" aria-hidden="true">✦</span>
        </div>
        <div class="book-card-content"><p class="book-eyebrow">DISCOVER YOUR NEXT READ</p><h3 class="book-title">${safeTitle}</h3><p class="book-description">${description}</p>${trailers}
          ${previewButton}
          <div class="book-purchase-row">
            <button class="purchase-button" onclick="addToCart('${pbId}', '${safeTitle.replace(/'/g, '&#39;')} (Paperback)', ${pbPrice})">Paperback <span>₹${pbPrice}</span></button>
            <button class="purchase-button ebook-purchase" onclick="addToCart('${ebId}', '${safeTitle.replace(/'/g, '&#39;')} (E-book)', ${ebPrice})">E-book <span>₹${ebPrice}</span></button>
          </div>
          ${marketplaceButtons}
          ${detailsLink}
        </div>
      </article>`;
  }).join('');
}
