
async function fetchBooks() {
  try {
    const response = await fetch('catalog.json');

    if (!response.ok) {
      throw new Error(`Catalog request failed (${response.status})`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error('catalog.json must contain an array');
    }

    catalog = data;
  } catch (error) {
    console.error('Could not load catalog.json:', error);
    const container = document.getElementById('books-container');

    if (container) {
      container.innerHTML = `
        <p class="catalog-error">
          We couldn't load the book catalog. Please refresh the page.
        </p>`;
    }
    return;
  }

  renderBooks();

  if (typeof updateCartUI === 'function') {
    updateCartUI();
  }
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
    const pbId = escapeHTML(book.pbId || '');
    const ebId = escapeHTML(book.ebId || '');
    const isKaalYug = /kaalyug/i.test(title);

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

          <button class="preview-button"
            onclick="openPreview('${pbId}')">
            Read a sample chapter
          </button>

          <div class="book-purchase-row">
            <button class="purchase-button"
              onclick="addToCart('${pbId}', '${escapeHTML(title).replace(/'/g, '&#39;')} (Paperback)', ${pbPrice})">
              Paperback <span>₹${pbPrice}</span>
            </button>
            <button class="purchase-button ebook-purchase"
              onclick="addToCart('${ebId}', '${escapeHTML(title).replace(/'/g, '&#39;')} (E-book)', ${ebPrice})">
              E-book <span>₹${ebPrice}</span>
            </button>
          </div>
        </div>
      </article>`;
  }).join('');
}
