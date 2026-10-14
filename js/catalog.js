
async function fetchBooks() {
  try {
    const response = await fetch(`${API_URL}/api/catalog`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Catalogue request failed (${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('The server returned an invalid catalogue.');

    catalog = data.map(book => ({
      ...book,
      pbMrp: Number(book.pbMrp) || 0,
      pbPrice: Number(book.pbPrice) || 0,
      ebMrp: Number(book.ebMrp) || 0,
      ebPrice: Number(book.ebPrice) || 0
    }));

    // Refresh saved cart prices from the same server-managed catalogue.
    if (typeof cart !== 'undefined' && Array.isArray(cart)) {
      const priceById = new Map();
      for (const book of catalog) {
        priceById.set(book.pbId, { price: book.pbPrice, name: `${book.title} (Paperback)` });
        priceById.set(book.ebId, { price: book.ebPrice, name: `${book.title} (E-book)` });
      }
      cart.forEach(item => {
        const latest = priceById.get(item.id);
        if (latest) { item.price = latest.price; item.name = latest.name; }
      });
      if (typeof saveCart === 'function') saveCart();
    }
  } catch (error) {
    console.error('Could not load public catalogue:', error);
    const container = document.getElementById('books-container');
    if (container) container.innerHTML = '<p class="catalog-error">We could not load the book catalogue. Please refresh the page.</p>';
    return;
  }
  renderBooks();
  if (typeof updateCartUI === 'function') updateCartUI();
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}


function renderBooks() {
  const container = document.getElementById('books-container');

  if (!container) {
    console.warn('No #books-container on this page.');
    return;
  }

  if (!Array.isArray(catalog) || catalog.length === 0) {
    container.innerHTML = '<p>No books are available right now.</p>';
    return;
  }

  container.innerHTML = catalog.map((book, index) => {
    const title = String(book.title || 'Untitled');
    const safeTitle = escapeHTML(title);
    const description = escapeHTML(book.desc || '');
    const image = escapeHTML(book.image || '');
    const pbPrice = Number(book.pbPrice) || 0;
    const ebPrice = Number(book.ebPrice) || 0;
    const pbMrp = Number(book.pbMrp) || 0;
    const ebMrp = Number(book.ebMrp) || 0;
    const displayPrice = (mrp, current) => {
      if (current === 0) {
        return `${mrp > 0 ? `<del class="book-mrp">₹${mrp}</del> ` : ''}<strong class="book-current-price">FREE</strong>`;
      }
      if (current === mrp) return `<strong class="book-current-price">₹${current}</strong>`;
      return `<del class="book-mrp">₹${mrp}</del> <strong class="book-current-price">₹${current}</strong>`;
    };
    const pbId = escapeHTML(book.pbId || '');
    const ebId = escapeHTML(book.ebId || '');
    const isKaalYug = /kaalyug/i.test(title);

    // Sample chapter details from catalog.json
    const samplePdf = escapeHTML(book.samplePdf || '');

    const sampleSubtitle = /pages of us/i.test(title)
      ? 'The Lake at Dawn'
      : /kaalyug/i.test(title)
        ? 'Order and Chaos'
        : /indestructible kali/i.test(title)
          ? 'The Weight of Justice'
          : 'Sample Chapter';

    const trailers = isKaalYug ? `
      <div class="trailer-actions">
        <button class="trailer-button"
          onclick="openTrailer('videos/kaalyug-trailer-1.mp4', 'KaalYug — Trailer 1')">
          <span aria-hidden="true">▶</span> Watch Trailer 1
        </button>
        <button class="trailer-button trailer-button-secondary"
          onclick="openTrailer('videos/kaalyug-trailer-2.mp4', 'KaalYug — Trailer 2')">
          <span aria-hidden="true">▶</span> Watch Trailer 2
        </button>
      </div>` : '';

    const sampleButton = samplePdf ? `
      <button class="preview-button"
        onclick="openPreview('${samplePdf}', '${safeTitle}', '${escapeHTML(sampleSubtitle)}')">
        Read a sample chapter
      </button>` : `
      <button class="preview-button" disabled>
        Sample coming soon
      </button>`;

    return `
      <article class="premium-book-card">
        <div class="book-cover-wrap">
          <span class="book-number">BOOK ${String(index + 1).padStart(2, '0')}</span>
          <img
            src="${image}"
            alt="${safeTitle} book cover"
            class="book-cover"
            loading="lazy"
            onerror="this.style.display='none'; this.parentElement.classList.add('cover-missing')">
          <span class="cover-fallback" aria-hidden="true">✦</span>
        </div>

        <div class="book-card-content">
          <p class="book-eyebrow">DISCOVER YOUR NEXT READ</p>
          <h3 class="book-title">${safeTitle}</h3>
          <p class="book-description">${description}</p>

          ${trailers}
          ${sampleButton}

          <div class="book-purchase-row">
            <button class="purchase-button"
              onclick="addToCart('${pbId}', '${safeTitle.replace(/'/g, '&#39;')} (Paperback)', ${pbPrice})">
              Paperback <span class="purchase-price">${displayPrice(pbMrp, pbPrice)}</span>
            </button>
            <button class="purchase-button ebook-purchase"
              onclick="addToCart('${ebId}', '${safeTitle.replace(/'/g, '&#39;')} (E-book)', ${ebPrice})">
              E-book <span class="purchase-price">${displayPrice(ebMrp, ebPrice)}</span>
            </button>
          </div>
        </div>
      </article>`;
  }).join('');
}
