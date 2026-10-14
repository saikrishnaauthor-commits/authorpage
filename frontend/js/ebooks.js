
(function () {
  'use strict';

  const API = (window.API_URL || 'https://authorpage-gybu.onrender.com')
    .replace(/\/$/, '');

  const TOKEN_KEY = 'sksEbookSession';
  const EMAIL_KEY = 'sksEbookEmail';

  let token = sessionStorage.getItem(TOKEN_KEY) || '';
  let email = sessionStorage.getItem(EMAIL_KEY) || '';
  let currentPdf = null;
  let currentPage = 1;
  let zoom = 1.15;

  const $ = id => document.getElementById(id);

  function showMessage(message, isError) {
    const el = $('ebook-login-message');
    if (!el) return;

    el.textContent = message || '';
    el.className = `text-sm mt-4 ${
      isError ? 'text-red-600' : 'text-emerald-700'
    }`;
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});

    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${API}${path}`, {
      ...options,
      headers,
      cache: 'no-store'
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 401) logout(false);
      throw new Error(data.error || 'Request failed. Please try again.');
    }

    return data;
  }

  function setLoggedIn(signedIn) {
    $('ebook-login-panel')?.classList.toggle('hidden', signedIn);
    $('ebook-library-panel')?.classList.toggle('hidden', !signedIn);

    if (signedIn && $('ebook-signed-in-email')) {
      $('ebook-signed-in-email').textContent = email;
    }
  }

  // Verify the order ID and purchase email, then open the purchased library.
  async function accessLibrary(event) {
    event.preventDefault();
    const button = $('ebook-login-button');
    const orderNumber = $('ebook-order-id')?.value.trim();
    const purchaseEmail = $('ebook-email')?.value.trim().toLowerCase();

    if (!orderNumber || !purchaseEmail) {
      showMessage('Enter your order ID and purchase email.', true);
      return;
    }

    button.disabled = true;
    showMessage('Checking your order details…', false);

    try {
      const data = await api('/api/ebooks/access', {
        method: 'POST',
        body: JSON.stringify({ orderNumber, email: purchaseEmail })
      });

      if (!data.token || !Array.isArray(data.ebooks)) {
        throw new Error('Unexpected server response. Please try again.');
      }

      token = data.token;
      email = data.email || purchaseEmail;
      sessionStorage.setItem(TOKEN_KEY, token);
      sessionStorage.setItem(EMAIL_KEY, email);
      setLoggedIn(true);
      showMessage('');
      renderBooks(data.ebooks);
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  function renderBooks(books) {
    const list = $('ebook-list');
    if (!list) return;

    list.replaceChildren();

    $('ebook-empty')?.classList.toggle('hidden', books.length > 0);

    for (const book of books) {
      const card = document.createElement('article');
      card.className =
        'border border-gray-200 rounded-xl p-5 bg-white shadow-sm flex flex-col';

      const title = document.createElement('h3');
      title.className = 'font-bold text-gray-900';
      title.textContent = book.title || 'Purchased e-book';

      const info = document.createElement('p');
      info.className = 'text-sm text-gray-600 mt-2';
      info.textContent = 'Purchased e-book';

      const button = document.createElement('button');
      button.className =
        'mt-5 w-full bg-indigo-700 hover:bg-indigo-800 text-white rounded-lg px-4 py-3 font-semibold';
      button.textContent = 'Read online';

      button.addEventListener('click', () => openBook(book, button));

      card.append(title, info, button);
      list.append(card);
    }
  }

  async function openBook(book, button) {
    button.disabled = true;
    button.textContent = 'Loading book…';

    try {
      if (!window.pdfjsLib) {
        throw new Error(
          'The online reader did not load. Refresh the page and try again.'
        );
      }

      const response = await fetch(
        `${API}/api/ebooks/${encodeURIComponent(book.id)}/pdf`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store'
        }
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));

        if (response.status === 401) logout(false);

        throw new Error(data.error || 'Could not open this book.');
      }

      const bytes = await response.arrayBuffer();

      currentPdf = await window.pdfjsLib.getDocument({
        data: new Uint8Array(bytes),
        isEvalSupported: false
      }).promise;

      currentPage = 1;
      zoom = 1.15;

      $('ebook-reader-title').textContent = book.title || 'E-book';
      $('ebook-reader-panel').classList.remove('hidden');
      $('ebook-library-panel').classList.add('hidden');
      $('ebook-reader-message').classList.add('hidden');
      $('ebook-page-canvas').classList.remove('hidden');

      await renderPage();

      $('ebook-reader-panel').scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Read online';
    }
  }

  async function renderPage() {
    if (!currentPdf) return;

    const page = await currentPdf.getPage(currentPage);
    const viewport = page.getViewport({ scale: zoom });
    const canvas = $('ebook-page-canvas');
    const context = canvas.getContext('2d', { alpha: false });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    await page.render({
      canvasContext: context,
      viewport,
      transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0]
    }).promise;

    $('ebook-page-count').textContent =
      `Page ${currentPage} of ${currentPdf.numPages}`;

    $('ebook-prev-page').disabled = currentPage <= 1;
    $('ebook-next-page').disabled = currentPage >= currentPdf.numPages;
  }

  function logout(showMessageAfter = true) {
    token = '';
    email = '';
    currentPdf = null;

    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EMAIL_KEY);

    setLoggedIn(false);
    $('ebook-reader-panel')?.classList.add('hidden');
    $('ebook-library-panel')?.classList.add('hidden');
    $('ebook-page-canvas')?.classList.add('hidden');

    if (showMessageAfter) {
      showMessage('You have been logged out.', false);
    }
  }

  async function restoreSession() {
    if (!token || !email) return;

    try {
      const data = await api('/api/ebooks');
      email = data.email || email;

      setLoggedIn(true);
      renderBooks(data.ebooks || []);
    } catch {
      logout(false);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    $('ebook-email-form')?.addEventListener('submit', accessLibrary);

    $('ebook-logout')?.addEventListener('click', () => logout(true));

    $('ebook-close-reader')?.addEventListener('click', () => {
      currentPdf = null;
      $('ebook-reader-panel').classList.add('hidden');
      $('ebook-library-panel').classList.remove('hidden');
    });

    $('ebook-prev-page')?.addEventListener('click', async () => {
      if (currentPage > 1) {
        currentPage--;
        await renderPage();
      }
    });

    $('ebook-next-page')?.addEventListener('click', async () => {
      if (currentPdf && currentPage < currentPdf.numPages) {
        currentPage++;
        await renderPage();
      }
    });

    $('ebook-zoom-in')?.addEventListener('click', async () => {
      zoom = Math.min(2.2, zoom + 0.15);
      await renderPage();
    });

    $('ebook-zoom-out')?.addEventListener('click', async () => {
      zoom = Math.max(0.65, zoom - 0.15);
      await renderPage();
    });

    restoreSession();
  });
})();
