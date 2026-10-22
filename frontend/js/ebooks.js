
(function () {
  'use strict';

  const API = (window.API_URL || 'https://authorpage-gybu.onrender.com')
    .replace(/\/$/, '');

  const TOKEN_KEY = 'sksEbookSession';
  const EMAIL_KEY = 'sksEbookEmail';

  let token = sessionStorage.getItem(TOKEN_KEY) || '';
  let email = sessionStorage.getItem(EMAIL_KEY) || '';
  let currentPdf = null;
  let currentEpub = null;
  let currentRendition = null;
  let currentPage = 1;
  let zoom = 1.15;
  let fontScale = 100;
  let currentTheme = 'light';
  let touchStartX = 0;

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

  // Login directly using the order ID and purchase email; no OTP is sent.
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
    showMessage('Verifying your order…', false);
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
      $('ebook-reader-title').textContent = book.title || 'E-book';
      $('ebook-reader-panel').classList.remove('hidden');
      $('ebook-library-panel').classList.add('hidden');
      $('ebook-reader-message').classList.add('hidden');
      $('ebook-reader-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      destroyCurrentReader();

      if (book.hasEpub && window.ePub) {
        await openEpubBook(book);
      } else {
        await openPdfBook(book);
      }
    } catch (error) {
      $('ebook-reader-message').textContent = error.message || 'Could not open this book.';
      $('ebook-reader-message').classList.remove('hidden');
      $('ebook-reader-panel').classList.add('hidden');
      $('ebook-library-panel').classList.remove('hidden');
      alert(error.message || 'Could not open this book.');
    } finally {
      button.disabled = false;
      button.textContent = 'Read online';
    }
  }

  function destroyCurrentReader() {
    try { currentRendition?.destroy(); } catch {}
    try { currentEpub?.destroy(); } catch {}
    currentPdf = null;
    currentEpub = null;
    currentRendition = null;
    $('ebook-epub-view')?.classList.add('hidden');
    $('ebook-pdf-view')?.classList.add('hidden');
    $('ebook-epub-view')?.replaceChildren();
    $('ebook-page-canvas')?.classList.remove('hidden');
  }

  async function protectedBytes(book, format) {
    const response = await fetch(`${API}/api/ebooks/${encodeURIComponent(book.id)}/${format}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) logout(false);
      throw new Error(data.error || `Could not load the ${format.toUpperCase()} book.`);
    }
    return response.arrayBuffer();
  }

  async function openEpubBook(book) {
    if (!window.ePub) throw new Error('The EPUB reader did not load. Refresh the page and try again.');
    const bytes = await protectedBytes(book, 'epub');
    currentEpub = window.ePub(bytes);
    const host = $('ebook-epub-view');
    host.classList.remove('hidden');
    $('ebook-pdf-view').classList.add('hidden');
    currentRendition = currentEpub.renderTo(host, {
      width: '100%',
      height: '100%',
      spread: 'none',
      flow: 'paginated',
      manager: 'default',
      allowScriptedContent: false
    });
    applyEpubTheme();
    await currentRendition.display();
    currentRendition.on('relocated', location => {
      const percentage = location?.start?.percentage || 0;
      $('ebook-progress').style.width = `${Math.max(0, Math.min(100, percentage * 100))}%`;
      const cfi = location?.start?.cfi;
      $('ebook-page-count').textContent = `${Math.round(percentage * 100)}% read`;
      $('ebook-prev-page').disabled = !location?.start || (location.start.percentage || 0) <= 0.001;
      $('ebook-next-page').disabled = Boolean(location?.atEnd);
      if (cfi) {
        try { sessionStorage.setItem(`sksEbookProgress:${book.id}`, cfi); } catch {}
      }
    });
    const savedCfi = sessionStorage.getItem(`sksEbookProgress:${book.id}`);
    if (savedCfi) {
      try { await currentRendition.display(savedCfi); } catch { /* stale bookmark: start at the beginning */ }
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (currentRendition && host.isConnected) {
          currentRendition.resize(
            host.clientWidth,
            host.clientHeight
          );
        }
      });
    });
  }

  async function openPdfBook(book) {
    if (!window.pdfjsLib) throw new Error('The online reader did not load. Refresh the page and try again.');
    const bytes = await protectedBytes(book, 'pdf');
    currentPdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
    currentPage = 1;
    zoom = 1;
    $('ebook-pdf-view').classList.remove('hidden');
    $('ebook-epub-view').classList.add('hidden');
    $('ebook-page-canvas').classList.remove('hidden');
    await renderPage();
  }

  async function renderPage() {
    if (!currentPdf) return;
    const page = await currentPdf.getPage(currentPage);
    const container = $('ebook-pdf-view');
    const base = page.getViewport({ scale: 1 });
    const fitScale = Math.max(0.5, Math.min(1.8, (container.clientWidth - 24) / base.width));
    const scale = fitScale * zoom;
    const viewport = page.getViewport({ scale });
    const canvas = $('ebook-page-canvas');
    const context = canvas.getContext('2d', { alpha: false });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    await page.render({ canvasContext: context, viewport, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] }).promise;
    $('ebook-page-count').textContent = `Page ${currentPage} of ${currentPdf.numPages}`;
    $('ebook-progress').style.width = `${(currentPage / currentPdf.numPages) * 100}%`;
    $('ebook-prev-page').disabled = currentPage <= 1;
    $('ebook-next-page').disabled = currentPage >= currentPdf.numPages;
  }

  function applyEpubTheme() {
    if (!currentRendition) return;
    const themes = {
      light: { body: { color: '#292524', background: '#f5f5f4' } },
      sepia: { body: { color: '#433525', background: '#f4ead5' } },
      dark: { body: { color: '#e8eaed', background: '#202124' } }
    };
    currentRendition.themes.default(themes[currentTheme] || themes.light);
    currentRendition.themes.fontSize(`${fontScale}%`);
    $('ebook-reader-shell').classList.toggle('sepia', currentTheme === 'sepia');
    $('ebook-reader-shell').classList.toggle('dark', currentTheme === 'dark');
    $('ebook-theme-toggle').textContent = currentTheme === 'light' ? 'Sepia mode' : currentTheme === 'sepia' ? 'Dark mode' : 'Light mode';
  }

  async function turnPage(direction) {
    if (currentRendition) {
      if (direction < 0) await currentRendition.prev(); else await currentRendition.next();
    } else if (currentPdf) {
      const next = currentPage + direction;
      if (next >= 1 && next <= currentPdf.numPages) { currentPage = next; await renderPage(); }
    }
  }

  function logout(showMessageAfter = true) {
    token = '';
    email = '';
    destroyCurrentReader();

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
      destroyCurrentReader();
      $('ebook-reader-panel').classList.add('hidden');
      $('ebook-library-panel').classList.remove('hidden');
    });

    $('ebook-prev-page')?.addEventListener('click', () => turnPage(-1).catch(console.error));
    $('ebook-next-page')?.addEventListener('click', () => turnPage(1).catch(console.error));

    $('ebook-zoom-in')?.addEventListener('click', async () => {
      if (currentRendition) { fontScale = Math.min(180, fontScale + 10); applyEpubTheme(); }
      else if (currentPdf) { zoom = Math.min(2.2, zoom + 0.15); await renderPage(); }
    });
    $('ebook-zoom-out')?.addEventListener('click', async () => {
      if (currentRendition) { fontScale = Math.max(70, fontScale - 10); applyEpubTheme(); }
      else if (currentPdf) { zoom = Math.max(0.65, zoom - 0.15); await renderPage(); }
    });
    $('ebook-theme-toggle')?.addEventListener('click', () => {
      currentTheme = currentTheme === 'light' ? 'sepia' : currentTheme === 'sepia' ? 'dark' : 'light';
      applyEpubTheme();
    });
    $('ebook-fit')?.addEventListener('click', async () => {
      if (currentRendition) currentRendition.resize();
      if (currentPdf) { zoom = 1; await renderPage(); }
    });
    $('ebook-fullscreen')?.addEventListener('click', async () => {
      const shell = $('ebook-reader-shell');
      try {
        if (!document.fullscreenElement) await shell.requestFullscreen();
        else await document.exitFullscreen();
        setTimeout(() => { currentRendition?.resize(); if (currentPdf) renderPage(); }, 150);
      } catch { /* Full screen may be unavailable in embedded browsers. */ }
    });
    $('ebook-epub-view')?.addEventListener('touchstart', event => { touchStartX = event.changedTouches?.[0]?.screenX || 0; }, { passive: true });
    $('ebook-epub-view')?.addEventListener('touchend', event => {
      const endX = event.changedTouches?.[0]?.screenX || 0;
      const delta = endX - touchStartX;
      if (Math.abs(delta) > 55) turnPage(delta > 0 ? -1 : 1).catch(console.error);
    }, { passive: true });
    document.addEventListener('keydown', event => {
      if ($('ebook-reader-panel')?.classList.contains('hidden')) return;
      if (event.key === 'ArrowLeft') turnPage(-1).catch(console.error);
      if (event.key === 'ArrowRight') turnPage(1).catch(console.error);
    });
    window.addEventListener('resize', () => { currentRendition?.resize(); if (currentPdf) renderPage(); });

    restoreSession();
  });
})();
