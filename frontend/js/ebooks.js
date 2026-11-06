// My E-books: library login and a full-screen EPUB / PDF reader.
(function () {
  'use strict';

  const API = (typeof API_URL === 'string' && API_URL ? API_URL : 'https://authorpage-gybu.onrender.com').replace(/\/$/, '');
  const TOKEN_KEY = 'sksEbookSession';
  const EMAIL_KEY = 'sksEbookEmail';
  const PREFS_KEY = 'sksReader:prefs';

  const $ = id => document.getElementById(id);

  let token = sessionStorage.getItem(TOKEN_KEY) || '';
  let email = sessionStorage.getItem(EMAIL_KEY) || '';
  let library = [];
  let covers = null;

  /* ---------------- Local storage helpers ---------------- */

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
    }
  };
  const progressKey = id => `sksReader:progress:${id}`;
  const bookmarksKey = id => `sksReader:bookmarks:${id}`;
  const locationsKey = id => `sksReader:locations:${id}`;

  // spread 'auto' = two pages side by side when the screen is wide enough.
  const SPREAD_MIN_WIDTH = 1000;
  const prefs = Object.assign(
    { theme: 'light', fontSize: 100, font: 'original', lineHeight: 'original', spread: 'auto', pageTurn: 'slide', pdfFit: 'width', pdfScale: null },
    store.get(PREFS_KEY, {})
  );
  // Settings saved before v2 had one-page as the default; move them to the new default once.
  if (prefs.v !== 2) { prefs.spread = 'auto'; prefs.v = 2; }
  const savePrefs = () => store.set(PREFS_KEY, prefs);

  /* ---------------- API ---------------- */

  function showMessage(message, isError) {
    const el = $('ebook-login-message');
    if (!el) return;
    el.textContent = message || '';
    el.className = `text-sm ${isError ? 'text-red-700' : 'text-emerald-700'}`;
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (options.body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${API}${path}`, { ...options, headers, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) logout(false);
      throw new Error(data.error || 'Request failed. Please try again.');
    }
    return data;
  }

  // Download a protected book file, reporting progress as it arrives.
  async function fetchBook(book, format, onProgress) {
    const response = await fetch(`${API}/api/ebooks/${encodeURIComponent(book.id)}/${format}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) logout(false);
      const err = new Error(data.error || `Could not load the ${format.toUpperCase()} edition.`);
      err.status = response.status;
      throw err;
    }
    const total = Number(response.headers.get('content-length')) || 0;
    if (!response.body || !response.body.getReader) return response.arrayBuffer();
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes.buffer;
  }

  // Cover images come from the public catalogue. Cards render straight away
  // and pick up covers when (if) the catalogue arrives.
  function loadCovers() {
    if (covers) return covers;
    covers = (async () => {
      const map = new Map();
      try {
        const response = await fetch(`${API}/api/catalog`, { cache: 'no-store' });
        const books = response.ok ? await response.json() : [];
        for (const b of Array.isArray(books) ? books : []) {
          if (b.ebId && b.image) map.set(b.ebId, b.image);
        }
      } catch { /* covers are optional */ }
      return map;
    })();
    return covers;
  }

  function fillCover(slot, image) {
    if (!image || slot.querySelector('img')) return;
    const img = document.createElement('img');
    img.src = image;
    img.alt = '';
    img.onload = () => { slot.textContent = ''; slot.append(img); };
    img.onerror = () => img.remove();
  }

  /* ---------------- Login & library ---------------- */

  function setLoggedIn(signedIn) {
    $('ebook-login-panel')?.classList.toggle('hidden', signedIn);
    $('ebook-library-panel')?.classList.toggle('hidden', !signedIn);
    if (signedIn && $('ebook-signed-in-email')) $('ebook-signed-in-email').textContent = email;
  }

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
      if (!data.token || !Array.isArray(data.ebooks)) throw new Error('Unexpected server response. Please try again.');
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
    library = books;
    const list = $('ebook-list');
    if (!list) return;
    list.replaceChildren();
    $('ebook-empty')?.classList.toggle('hidden', books.length > 0);
    const coverSlots = new Map();

    for (const book of books) {
      const progress = store.get(progressKey(book.id), null);
      const percent = progress && typeof progress.percent === 'number' ? Math.round(progress.percent * 100) : null;

      const card = document.createElement('article');
      card.className = 'library-card';

      const cover = document.createElement('div');
      cover.className = 'library-card__cover';
      cover.textContent = '✦';
      coverSlots.set(book.id, cover);

      const body = document.createElement('div');
      body.className = 'library-card__body';
      const format = document.createElement('span');
      format.className = 'library-card__format';
      format.textContent = book.hasEpub ? 'EPUB' : 'PDF';
      const title = document.createElement('h3');
      title.className = 'library-card__title';
      title.textContent = book.title || 'Purchased e-book';
      const bar = document.createElement('div');
      bar.className = 'library-card__progress';
      const fill = document.createElement('span');
      fill.style.width = `${percent || 0}%`;
      bar.append(fill);
      const meta = document.createElement('p');
      meta.className = 'library-card__meta';
      meta.textContent = percent == null ? 'Not started' : percent >= 99 ? 'Finished' : `${percent}% read`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-navy !py-2.5 text-sm';
      button.textContent = percent == null ? 'Start reading' : 'Continue reading';
      button.addEventListener('click', () => Reader.open(book));

      body.append(format, title, bar, meta, button);
      card.append(cover, body);
      list.append(card);
    }

    loadCovers().then(map => {
      for (const [id, slot] of coverSlots) if (slot.isConnected) fillCover(slot, map.get(id));
    });
  }

  function logout(showMessageAfter = true) {
    token = '';
    email = '';
    Reader.close({ fromHistory: true });
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EMAIL_KEY);
    setLoggedIn(false);
    if (showMessageAfter) showMessage('You have been logged out.', false);
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

  /* ---------------- Reader shell ---------------- */

  const Reader = (() => {
    let engine = null;
    let book = null;
    let openToken = 0;
    let lastFocus = null;

    const el = id => $(id);

    function setLoading(text) {
      el('reader-loading').hidden = !text;
      if (text) el('reader-loading-text').textContent = text;
    }

    function showError(message) {
      setLoading('');
      el('reader-error-text').textContent = message;
      el('reader-error').hidden = false;
    }

    function formatBytes(n) {
      return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
    }

    async function open(target) {
      const myToken = ++openToken;
      close({ keepOpen: true });
      book = target;
      lastFocus = document.activeElement;

      const root = el('reader');
      root.hidden = false;
      root.dataset.theme = prefs.theme;
      root.dataset.format = target.hasEpub && window.ePub ? 'epub' : 'pdf';
      document.body.classList.add('reader-open');
      el('reader-title').textContent = target.title || 'E-book';
      el('reader-chapter').textContent = '';
      el('reader-position').textContent = '';
      el('reader-percent').textContent = '';
      el('reader-error').hidden = true;
      el('reader-slider').disabled = true;
      el('reader-slider').value = 0;
      el('reader-fullscreen-btn').hidden = !document.fullscreenEnabled;
      if (!history.state || !history.state.sksReader) history.pushState({ sksReader: true }, '');
      el('reader-close').focus();
      syncSettingsUI();

      const onProgress = (received, total) => {
        setLoading(total ? `Downloading… ${Math.round((received / total) * 100)}%` : `Downloading… ${formatBytes(received)}`);
      };

      try {
        setLoading('Opening book…');
        if (root.dataset.format === 'epub') {
          try {
            const bytes = await fetchBook(target, 'epub', onProgress);
            if (myToken !== openToken) return;
            setLoading('Preparing pages…');
            engine = await EpubEngine.create(target, bytes);
          } catch (error) {
            if (myToken !== openToken || error.status === 401 || error.status === 403) throw error;
            console.warn('EPUB failed, trying PDF edition:', error);
            root.dataset.format = 'pdf';
            setLoading('Opening book…');
            const bytes = await fetchBook(target, 'pdf', onProgress);
            if (myToken !== openToken) return;
            engine = await PdfEngine.create(target, bytes);
          }
        } else {
          if (!window.pdfjsLib) throw new Error('The reader did not load. Refresh the page and try again.');
          const bytes = await fetchBook(target, 'pdf', onProgress);
          if (myToken !== openToken) return;
          setLoading('Preparing pages…');
          engine = await PdfEngine.create(target, bytes);
        }
        if (myToken !== openToken) { engine?.destroy(); engine = null; return; }
        setLoading('');
        renderToc();
        renderBookmarks();
      } catch (error) {
        if (myToken !== openToken) return;
        console.error(error);
        showError(error.message || 'Please check your connection and try again.');
      }
    }

    function close({ keepOpen = false, fromHistory = false } = {}) {
      try { engine?.destroy(); } catch (e) { console.warn(e); }
      engine = null;
      closePanels();
      el('reader-epub').replaceChildren();
      el('reader-pdf').replaceChildren();
      el('reader-epub').hidden = true;
      el('reader-pdf').hidden = true;
      setLoading('');
      if (keepOpen) return;
      openToken++;
      const root = el('reader');
      if (root.hidden) return;
      root.hidden = true;
      document.body.classList.remove('reader-open');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (!fromHistory && history.state && history.state.sksReader) history.back();
      if (library.length) renderBooks(library);
      lastFocus?.focus?.();
      book = null;
    }

    /* Status bar & navigation state, reported by the engines. */
    function update({ chapter, position, percent, atStart, atEnd, sliderValue, sliderEnabled, bookmarked }) {
      if (chapter !== undefined) el('reader-chapter').textContent = chapter || '';
      if (position !== undefined) el('reader-position').textContent = position || '';
      if (percent !== undefined) el('reader-percent').textContent = percent == null ? '' : `${Math.round(percent * 100)}%`;
      if (atStart !== undefined) el('reader-prev').disabled = atStart;
      if (atEnd !== undefined) el('reader-next').disabled = atEnd;
      if (sliderEnabled !== undefined) el('reader-slider').disabled = !sliderEnabled;
      if (sliderValue !== undefined && document.activeElement !== el('reader-slider')) el('reader-slider').value = Math.round(sliderValue * 1000);
      if (bookmarked !== undefined) {
        el('reader-bookmark-btn').setAttribute('aria-pressed', String(bookmarked));
        el('reader-bookmark-btn').setAttribute('aria-label', bookmarked ? 'Remove bookmark' : 'Bookmark this page');
      }
      if (chapter !== undefined) highlightToc();
    }

    /* Contents drawer */
    function renderToc() {
      const list = el('reader-toc');
      list.replaceChildren();
      const items = engine?.toc() || [];
      if (!items.length) {
        const empty = document.createElement('li');
        empty.className = 'reader-empty';
        empty.textContent = 'This book has no table of contents.';
        list.append(empty);
        return;
      }
      for (const item of items) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.style.paddingLeft = `${12 + item.depth * 16}px`;
        button.textContent = item.label;
        button.dataset.label = item.label;
        button.addEventListener('click', () => { closePanels(); engine?.goTo(item.target); });
        li.append(button);
        list.append(li);
      }
      highlightToc();
    }

    function highlightToc() {
      const current = el('reader-chapter').textContent;
      for (const button of el('reader-toc').querySelectorAll('button')) {
        button.setAttribute('aria-current', String(Boolean(current) && button.dataset.label === current));
      }
    }

    /* Bookmarks */
    function getBookmarks() { return book ? store.get(bookmarksKey(book.id), []) : []; }
    function setBookmarks(list) { if (book) store.set(bookmarksKey(book.id), list); }

    function toggleBookmark() {
      if (!engine || !book) return;
      const list = getBookmarks();
      const existing = list.findIndex(b => engine.isOnScreen(b.at));
      if (existing >= 0) list.splice(existing, 1);
      else list.push(Object.assign({ createdAt: Date.now() }, engine.bookmarkData()));
      list.sort((a, b) => (a.percent || 0) - (b.percent || 0));
      setBookmarks(list);
      renderBookmarks();
      engine.refreshState();
    }

    function renderBookmarks() {
      const list = el('reader-bookmarks');
      list.replaceChildren();
      const items = getBookmarks();
      el('reader-bookmarks-empty').hidden = items.length > 0;
      items.forEach((mark, index) => {
        const li = document.createElement('li');
        li.className = 'reader-bookmark-row';
        const go = document.createElement('button');
        go.type = 'button';
        const label = document.createElement('span');
        label.textContent = mark.label || 'Bookmark';
        const small = document.createElement('small');
        small.textContent = typeof mark.percent === 'number' ? `${Math.round(mark.percent * 100)}%` : '';
        go.append(label, small);
        go.addEventListener('click', () => { closePanels(); engine?.goTo(mark.at); });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'reader-bookmark-remove';
        remove.setAttribute('aria-label', `Remove bookmark: ${mark.label || ''}`);
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
          const next = getBookmarks();
          next.splice(index, 1);
          setBookmarks(next);
          renderBookmarks();
          engine?.refreshState();
        });
        li.append(go, remove);
        list.append(li);
      });
    }

    /* Panels */
    function openDrawer(tab = 'contents') {
      closePanels();
      el('reader-drawer').hidden = false;
      el('reader-scrim').hidden = false;
      el('reader-toc-btn').setAttribute('aria-expanded', 'true');
      selectTab(tab);
      const current = el('reader-toc').querySelector('[aria-current="true"]');
      (current || el(`tab-${tab}`)).focus();
      current?.scrollIntoView({ block: 'center' });
    }

    function selectTab(tab) {
      for (const name of ['contents', 'bookmarks']) {
        el(`tab-${name}`).setAttribute('aria-selected', String(name === tab));
        el(`panel-${name}`).hidden = name !== tab;
      }
    }

    function toggleSettings() {
      const open = el('reader-settings').hidden;
      closePanels();
      if (open) {
        el('reader-settings').hidden = false;
        el('reader-settings-btn').setAttribute('aria-expanded', 'true');
        syncSettingsUI();
      }
    }

    function closePanels() {
      el('reader-drawer').hidden = true;
      el('reader-scrim').hidden = true;
      el('reader-settings').hidden = true;
      el('reader-toc-btn').setAttribute('aria-expanded', 'false');
      el('reader-settings-btn').setAttribute('aria-expanded', 'false');
    }

    function panelsOpen() {
      return !el('reader-drawer').hidden || !el('reader-settings').hidden;
    }

    /* Settings */
    function syncSettingsUI() {
      el('reader').dataset.theme = prefs.theme;
      for (const b of document.querySelectorAll('[data-theme-option]')) b.setAttribute('aria-pressed', String(b.dataset.themeOption === prefs.theme));
      for (const group of document.querySelectorAll('#reader-settings [data-pref]')) {
        const value = prefs[group.dataset.pref];
        for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === value && !(group.dataset.pref === 'pdfFit' && prefs.pdfScale)));
      }
      el('reader-font-value').textContent = `${prefs.fontSize}%`;
      el('reader-zoom-value').textContent = engine?.zoomLabel ? engine.zoomLabel() : '';
      if (engine?.pageCount) el('reader-goto-input').max = engine.pageCount();
    }

    function setPref(name, value) {
      prefs[name] = value;
      savePrefs();
      syncSettingsUI();
      engine?.applyPrefs(name);
    }

    function wire() {
      el('reader-close').addEventListener('click', () => close());
      el('reader-error-close').addEventListener('click', () => close());
      el('reader-prev').addEventListener('click', () => engine?.prev());
      el('reader-next').addEventListener('click', () => engine?.next());
      el('reader-toc-btn').addEventListener('click', () => (el('reader-drawer').hidden ? openDrawer('contents') : closePanels()));
      el('reader-settings-btn').addEventListener('click', toggleSettings);
      el('reader-bookmark-btn').addEventListener('click', toggleBookmark);
      el('reader-scrim').addEventListener('click', closePanels);
      el('tab-contents').addEventListener('click', () => selectTab('contents'));
      el('tab-bookmarks').addEventListener('click', () => selectTab('bookmarks'));
      el('reader-fullscreen-btn').addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else el('reader').requestFullscreen?.().catch(() => {});
      });

      const slider = el('reader-slider');
      slider.addEventListener('input', () => {
        el('reader-percent').textContent = `${Math.round(slider.value / 10)}%`;
      });
      slider.addEventListener('change', () => engine?.seek(slider.value / 1000));

      for (const b of document.querySelectorAll('[data-theme-option]')) {
        b.addEventListener('click', () => setPref('theme', b.dataset.themeOption));
      }
      for (const group of document.querySelectorAll('#reader-settings [data-pref]')) {
        for (const b of group.querySelectorAll('button')) {
          b.addEventListener('click', () => {
            if (group.dataset.pref === 'pdfFit') prefs.pdfScale = null;
            setPref(group.dataset.pref, b.dataset.value);
          });
        }
      }
      el('reader-font-up').addEventListener('click', () => setPref('fontSize', Math.min(200, prefs.fontSize + 10)));
      el('reader-font-down').addEventListener('click', () => setPref('fontSize', Math.max(70, prefs.fontSize - 10)));
      el('reader-zoom-in').addEventListener('click', () => engine?.zoomBy(1.2));
      el('reader-zoom-out').addEventListener('click', () => engine?.zoomBy(1 / 1.2));
      el('reader-goto').addEventListener('submit', event => {
        event.preventDefault();
        const page = Number(el('reader-goto-input').value);
        if (page >= 1) { engine?.goTo(page); closePanels(); }
      });

      document.addEventListener('keydown', handleKey);
      window.addEventListener('popstate', () => { if (!el('reader').hidden) close({ fromHistory: true }); });

      let resizeTimer = 0;
      new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => engine?.resize(), 150);
      }).observe(el('reader-stage'));
    }

    function handleKey(event) {
      if (el('reader').hidden) return;
      const tag = (event.target && event.target.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (event.key === 'Escape') {
        if (panelsOpen()) { closePanels(); event.preventDefault(); }
        return;
      }
      if (panelsOpen() || !engine) return;
      if (event.key === 'ArrowRight' || (event.key === 'PageDown' && engine.kind === 'epub') || (event.key === ' ' && engine.kind === 'epub')) {
        engine.next(); event.preventDefault();
      } else if (event.key === 'ArrowLeft' || (event.key === 'PageUp' && engine.kind === 'epub')) {
        engine.prev(); event.preventDefault();
      }
    }

    return {
      open, close, update, wire, handleKey, renderBookmarks,
      bookmarks: getBookmarks,
      saveProgress(data) { if (book) store.set(progressKey(book.id), Object.assign({ updatedAt: Date.now() }, data)); },
      loadProgress(id) { return store.get(progressKey(id), null) || legacyProgress(id); },
      onEngineReady() { syncSettingsUI(); }
    };
  })();

  // Positions saved by the previous reader version (session-only).
  function legacyProgress(id) {
    try {
      const cfi = sessionStorage.getItem(`sksEbookProgress:${id}`);
      return cfi ? { cfi } : null;
    } catch { return null; }
  }

  /* ---------------- EPUB engine ---------------- */

  const EPUB_THEMES = {
    light: { bg: '#fbfaf7', fg: '#24211d', link: '#8a5a12', sel: 'rgba(214,173,96,.35)' },
    sepia: { bg: '#f4ecd8', fg: '#433422', link: '#8a5a12', sel: 'rgba(138,90,18,.25)' },
    dark: { bg: '#16181d', fg: '#d9d6d0', link: '#e2bd77', sel: 'rgba(226,189,119,.3)' }
  };
  const EPUB_FONTS = {
    serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif',
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'
  };
  const EPUB_LINE_HEIGHTS = { normal: '1.6', relaxed: '1.9' };

  const EpubEngine = {
    async create(book, bytes) {
      if (!window.ePub) throw new Error('The EPUB reader did not load. Refresh the page and try again.');
      const host = $('reader-epub');
      host.hidden = false;
      // Page turns move by a whole number of pixels. If the reading area is a
      // fractional width (e.g. 377.2px on some phones) every turn falls short by
      // the fraction and long chapters drift sideways, clipping text. Snap the
      // area to whole pixels (CSS insets decide the space, we round it down).
      const snapHostSize = () => {
        host.style.width = '';
        host.style.height = '';
        host.style.right = '';
        host.style.bottom = '';
        const rect = host.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
        host.style.width = `${Math.floor(rect.width)}px`;
        host.style.height = `${Math.floor(rect.height)}px`;
      };
      snapHostSize();
      const epub = window.ePub(bytes);
      const rendition = epub.renderTo(host, {
        width: '100%',
        height: '100%',
        flow: 'paginated',
        spread: prefs.spread === 'auto' ? 'auto' : 'none',
        minSpreadWidth: SPREAD_MIN_WIDTH,
        manager: 'default',
        allowScriptedContent: false
      });

      let current = null;
      let toc = [];
      let locationsReady = false;
      let destroyed = false;
      let touchStart = null;
      let suppressClickUntil = 0;

      const css = () => {
        const t = EPUB_THEMES[prefs.theme] || EPUB_THEMES.light;
        // Layout guards: some books (e.g. exported from Word or Google Docs) size
        // blocks to the screen (width: 100vw / large min-width) or make <body> a
        // flex/grid box. Either breaks page columns: lines run across pages or text
        // drops off the bottom. Keep body a block and every element within a column.
        let out = `body { display: block !important; float: none !important; min-width: 0 !important; }
          body * { max-width: 100% !important; min-width: 0 !important; box-sizing: border-box; }
          body, p, div, li, td, th, a, span { overflow-wrap: break-word; }
          pre { white-space: pre-wrap !important; }
          img, svg, video { height: auto; }
          html, body { background: ${t.bg} !important; color: ${t.fg} !important; }
          body { font-size: ${prefs.fontSize}% !important; }
          p, li, blockquote, span, div, h1, h2, h3, h4, h5, h6, td, th, em, strong, i, b, small { color: inherit !important; }
          a, a * { color: ${t.link} !important; }
          ::selection { background: ${t.sel}; }`;
        if (prefs.font !== 'original' && EPUB_FONTS[prefs.font]) {
          out += `body, p, li, blockquote, div, span, td, th { font-family: ${EPUB_FONTS[prefs.font]} !important; }`;
        }
        if (EPUB_LINE_HEIGHTS[prefs.lineHeight]) {
          out += `p, li, blockquote { line-height: ${EPUB_LINE_HEIGHTS[prefs.lineHeight]} !important; }`;
        }
        return out;
      };
      // The reader paginates by giving each chapter's <body> a fixed width (one
      // page) and CSS columns. Some books override that width with
      // `body.calibre { width: auto !important }`, which turns the chapter into
      // one column several pages wide (lines run across pages). Re-apply the
      // reader's width as !important every time it is set, so the book can't win.
      const pinBodyWidth = contents => {
        const body = contents.document?.body;
        const width = body?.style.getPropertyValue('width');
        if (width && body.style.getPropertyPriority('width') !== 'important') {
          body.style.setProperty('width', width, 'important');
        }
      };
      const guardWidth = contents => {
        if (contents.__sksWidthGuard || typeof contents.width !== 'function') return;
        contents.__sksWidthGuard = true;
        const setWidth = contents.width.bind(contents);
        contents.width = (...args) => {
          const result = setWidth(...args);
          pinBodyWidth(contents);
          // epub.js expects the resulting width back, so measure it again after pinning.
          const measured = parseInt(contents.window.getComputedStyle(contents.document.body).width, 10);
          return Number.isFinite(measured) ? measured : result;
        };
        pinBodyWidth(contents);
      };

      const inject = contents => {
        const doc = contents.document;
        if (!doc || !doc.head) return;
        guardWidth(contents);
        let style = doc.getElementById('sks-reader-style');
        if (!style) {
          style = doc.createElement('style');
          style.id = 'sks-reader-style';
          doc.head.appendChild(style);
        }
        style.textContent = css();
      };
      rendition.hooks.content.register(inject);

      const flattenToc = (items, depth = 0, out = []) => {
        for (const item of items || []) {
          const label = String(item.label || '').trim();
          if (label) out.push({ label, target: item.href, depth, spineIndex: epub.spine.get(item.href)?.index ?? -1 });
          flattenToc(item.subitems, depth + 1, out);
        }
        return out;
      };

      const chapterFor = location => {
        const index = location?.start?.index;
        if (index == null) return '';
        let match = '';
        for (const item of toc) if (item.spineIndex !== -1 && item.spineIndex <= index) match = item.label;
        return match;
      };

      const cfiCompare = (a, b) => {
        try { return new window.ePub.CFI().compare(a, b); } catch { return a === b ? 0 : NaN; }
      };
      const isOnScreen = cfi => {
        if (!current?.start?.cfi || !current?.end?.cfi || typeof cfi !== 'string') return false;
        return cfiCompare(cfi, current.start.cfi) >= 0 && cfiCompare(cfi, current.end.cfi) <= 0;
      };
      const percentOf = cfi => (locationsReady ? epub.locations.percentageFromCfi(cfi) : null);

      const refreshState = () => {
        if (!current) return;
        const start = current.start;
        const percent = start?.cfi ? percentOf(start.cfi) : null;
        const page = start?.displayed?.page;
        const pages = start?.displayed?.total;
        const bookmarked = Reader.bookmarks().some(b => isOnScreen(b.at));
        Reader.update({
          chapter: chapterFor(current),
          position: page && pages ? `Page ${page} of ${pages} in this chapter` : '',
          percent: locationsReady ? percent : undefined,
          atStart: Boolean(current.atStart),
          atEnd: Boolean(current.atEnd),
          sliderEnabled: locationsReady,
          sliderValue: percent == null ? undefined : percent,
          bookmarked
        });
        if (!locationsReady) $('reader-percent').textContent = 'Calculating pages…';
      };

      rendition.on('relocated', location => {
        current = location;
        refreshState();
        const cfi = location?.start?.cfi;
        if (cfi) Reader.saveProgress({ cfi, percent: percentOf(cfi) });
      });

      // Tap the left/right edge of the page to turn it.
      rendition.on('click', event => {
        if (Date.now() < suppressClickUntil) return;
        if (event.target?.closest?.('a')) return;
        const selection = event.view?.getSelection?.();
        if (selection && String(selection).trim()) return;
        const frame = event.view?.frameElement;
        if (!frame) return;
        const frameRect = frame.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const x = (frameRect.left + event.clientX - hostRect.left) / hostRect.width;
        if (x < 0.25) engine.prev();
        else if (x > 0.75) engine.next();
      });
      rendition.on('touchstart', event => {
        const t = event.changedTouches?.[0];
        touchStart = t ? { x: t.screenX, y: t.screenY, time: Date.now() } : null;
      });
      rendition.on('touchend', event => {
        const t = event.changedTouches?.[0];
        if (!t || !touchStart) return;
        const dx = t.screenX - touchStart.x;
        const dy = t.screenY - touchStart.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - touchStart.time < 800) {
          suppressClickUntil = Date.now() + 500;
          if (dx < 0) engine.next(); else engine.prev();
        }
        touchStart = null;
      });
      rendition.on('keydown', event => Reader.handleKey(event));

      // Two pages side by side when the setting allows it and the screen is wide
      // enough; the class draws the fold shadow down the middle.
      const markSpread = () => {
        host.classList.toggle('is-spread', prefs.spread === 'auto' && host.clientWidth >= SPREAD_MIN_WIDTH);
      };

      // Page-turn motion: the page slides out to one side and the next one
      // slides in from the other. Skipped when switched off in settings or when
      // the device asks for reduced motion. Presses made during a slide are
      // queued and applied straight after it (no animation), so fast readers
      // never lose a turn and the library never runs two turns at once.
      let turning = false;
      let queued = 0;
      const step = direction => (direction > 0 ? rendition.next() : rendition.prev());
      const turn = async direction => {
        if (turning) { queued += direction; return; }
        const atEdge = direction > 0 ? current?.atEnd : current?.atStart;
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        turning = true;
        try {
          if (atEdge || prefs.pageTurn === 'none' || reduceMotion || !host.animate) await step(direction);
          else await slide(direction);
          while (queued && !destroyed) {
            const d = Math.sign(queued);
            queued -= d;
            await step(d);
          }
        } finally {
          queued = 0;
          turning = false;
        }
      };
      const slide = async direction => {
        let moved = false;
        const go = async () => { moved = true; await step(direction); };
        const distance = Math.min(90, host.clientWidth * 0.06) * direction;
        try {
          await host.animate(
            [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${-distance}px)`, opacity: 0 }],
            { duration: 130, easing: 'ease-in' }
          ).finished;
          host.style.opacity = '0';
          await go();
          host.style.opacity = '';
          await host.animate(
            [{ transform: `translateX(${distance}px)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
            { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' }
          ).finished;
        } catch {
          // An interrupted animation must never leave the page hidden or unturned.
          host.style.opacity = '';
          if (!moved) await go();
        } finally {
          host.style.opacity = '';
        }
      };

      const engine = {
        kind: 'epub',
        next: () => turn(1),
        prev: () => turn(-1),
        goTo: target => rendition.display(target).catch(err => console.warn('Could not open that location', err)),
        seek: fraction => {
          if (!locationsReady) return;
          const cfi = epub.locations.cfiFromPercentage(Math.max(0, Math.min(1, fraction)));
          if (cfi) rendition.display(cfi);
        },
        toc: () => toc,
        isOnScreen,
        refreshState,
        bookmarkData: () => {
          const cfi = current?.start?.cfi;
          const percent = cfi ? percentOf(cfi) : null;
          return { at: cfi, percent, label: chapterFor(current) || 'Bookmark' };
        },
        applyPrefs: async name => {
          if (destroyed) return;
          const cfi = current?.start?.cfi;
          if (name === 'spread') { rendition.spread(prefs.spread === 'auto' ? 'auto' : 'none', SPREAD_MIN_WIDTH); markSpread(); }
          if (name === 'pageTurn') return;
          rendition.getContents().forEach(inject);
          if (name !== 'theme' && cfi) {
            await new Promise(r => setTimeout(r, 60));
            if (!destroyed) rendition.display(cfi).catch(() => {});
          }
        },
        resize: () => {
          if (destroyed) return;
          snapHostSize();
          rendition.resize();
          markSpread();
        },
        destroy: () => {
          destroyed = true;
          host.removeAttribute('style');
          host.classList.remove('is-spread');
          try { rendition.destroy(); } catch {}
          try { epub.destroy(); } catch {}
        }
      };

      await epub.ready;
      try { toc = flattenToc((await epub.loaded.navigation).toc); } catch { toc = []; }

      const saved = Reader.loadProgress(book.id);
      try { await rendition.display(saved?.cfi || undefined); }
      catch { await rendition.display(); }

      // Locations give real book-wide percentages. Cache them per book: generating takes a few seconds.
      const cachedLocations = store.get(locationsKey(book.id), null);
      if (cachedLocations) {
        try { epub.locations.load(cachedLocations); locationsReady = epub.locations.length() > 0; } catch { locationsReady = false; }
      }
      if (locationsReady) refreshState();
      else {
        epub.locations.generate(1200).then(() => {
          if (destroyed) return;
          locationsReady = epub.locations.length() > 0;
          if (locationsReady) store.set(locationsKey(book.id), epub.locations.save());
          refreshState();
          const cfi = current?.start?.cfi;
          if (cfi) Reader.saveProgress({ cfi, percent: percentOf(cfi) });
        }).catch(err => console.warn('Could not calculate EPUB locations', err));
      }

      markSpread();
      Reader.onEngineReady();
      return engine;
    }
  };

  /* ---------------- PDF engine ---------------- */

  const PdfEngine = {
    async create(book, bytes) {
      if (!window.pdfjsLib) throw new Error('The PDF reader did not load. Refresh the page and try again.');
      const container = $('reader-pdf');
      container.hidden = false;
      container.replaceChildren();

      const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
      const pdf = await loadingTask.promise;
      const first = await pdf.getPage(1);
      const base = first.getViewport({ scale: 1 });
      const total = pdf.numPages;
      const pages = [];
      let scale = 1;
      let layoutVersion = 0;
      let currentPage = 1;
      let outline = [];
      let destroyed = false;
      let scrollFrame = 0;

      for (let n = 1; n <= total; n++) {
        const wrap = document.createElement('div');
        wrap.className = 'pdf-page';
        wrap.dataset.page = n;
        wrap.setAttribute('aria-label', `Page ${n}`);
        wrap.textContent = String(n);
        container.append(wrap);
        pages.push({ n, wrap, aspect: base.height / base.width, canvas: null, task: null, state: 'empty' });
      }

      const fitScale = mode => {
        const availW = Math.max(200, container.clientWidth - 24);
        const availH = Math.max(200, container.clientHeight - 48);
        const widthScale = Math.min(availW, 960) / base.width;
        return mode === 'page' ? Math.min(widthScale, availH / base.height) : widthScale;
      };

      const unrender = p => {
        try { p.task?.cancel(); } catch {}
        p.task = null;
        p.canvas?.remove();
        p.canvas = null;
        p.state = 'empty';
      };

      const renderPage = async p => {
        if (p.state !== 'empty' || destroyed) return;
        p.state = 'rendering';
        const version = layoutVersion;
        try {
          const page = await pdf.getPage(p.n);
          if (destroyed || version !== layoutVersion) { p.state = 'empty'; return; }
          const viewport = page.getViewport({ scale });
          const aspect = viewport.height / viewport.width;
          if (Math.abs(aspect - p.aspect) > 0.01) {
            p.aspect = aspect;
            p.wrap.style.height = `${Math.round(p.wrap.offsetWidth * aspect)}px`;
          }
          let dpr = Math.min(window.devicePixelRatio || 1, 2);
          const maxPixels = 12e6;
          if (viewport.width * viewport.height * dpr * dpr > maxPixels) dpr = Math.sqrt(maxPixels / (viewport.width * viewport.height));
          const renderViewport = page.getViewport({ scale: scale * dpr });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(renderViewport.width);
          canvas.height = Math.floor(renderViewport.height);
          const ctx = canvas.getContext('2d', { alpha: false });
          p.task = page.render({ canvasContext: ctx, viewport: renderViewport });
          await p.task.promise;
          if (destroyed || version !== layoutVersion) { p.state = 'empty'; return; }
          p.task = null;
          p.canvas = canvas;
          p.wrap.textContent = '';
          p.wrap.append(canvas);
          p.state = 'done';
        } catch (error) {
          p.state = 'empty';
          if (error?.name !== 'RenderingCancelledException') console.warn(`Page ${p.n} failed`, error);
        }
      };

      const detectCurrent = () => {
        const mid = container.scrollTop + container.clientHeight * 0.35;
        let found = 1;
        for (const p of pages) {
          if (p.wrap.offsetTop <= mid) found = p.n; else break;
        }
        return found;
      };

      const bookmarked = () => Reader.bookmarks().some(b => b.at === currentPage);

      const refreshState = () => {
        Reader.update({
          chapter: chapterFor(currentPage),
          position: `Page ${currentPage} of ${total}`,
          percent: total > 1 ? (currentPage - 1) / (total - 1) : 1,
          atStart: currentPage <= 1,
          atEnd: currentPage >= total,
          sliderEnabled: total > 1,
          sliderValue: total > 1 ? (currentPage - 1) / (total - 1) : 0,
          bookmarked: bookmarked()
        });
      };

      let saveTimer = 0;
      const onScroll = () => {
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = 0;
          if (destroyed) return;
          const now = detectCurrent();
          for (const p of pages) {
            const distance = p.n - now;
            if (distance >= -2 && distance <= 3) renderPage(p);
            else if (Math.abs(distance) > 8 && p.state !== 'empty') unrender(p);
          }
          if (now !== currentPage) {
            currentPage = now;
            refreshState();
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => Reader.saveProgress({ page: currentPage, percent: total > 1 ? (currentPage - 1) / (total - 1) : 1 }), 300);
          }
        });
      };
      container.addEventListener('scroll', onScroll, { passive: true });

      // While a smooth scroll is running, remember where it is heading so quick
      // repeated Next/Previous presses keep counting from there.
      let pendingPage = 0;
      let pendingTimer = 0;
      const scrollToPage = (n, smooth) => {
        const page = Math.max(1, Math.min(total, Math.round(n)));
        const target = pages[page - 1];
        if (!target) return;
        pendingPage = smooth ? page : 0;
        clearTimeout(pendingTimer);
        if (smooth) pendingTimer = setTimeout(() => { pendingPage = 0; }, 700);
        container.scrollTo({ top: target.wrap.offsetTop - 16, behavior: smooth ? 'smooth' : 'auto' });
        onScroll();
      };
      const basePage = () => pendingPage || detectCurrent();

      const layout = keepPage => {
        const anchor = keepPage || currentPage;
        layoutVersion++;
        scale = prefs.pdfScale || fitScale(prefs.pdfFit);
        const width = Math.round(base.width * scale);
        for (const p of pages) {
          unrender(p);
          p.wrap.textContent = String(p.n);
          p.wrap.style.width = `${width}px`;
          p.wrap.style.height = `${Math.round(width * p.aspect)}px`;
        }
        scrollToPage(anchor, false);
      };

      const chapterFor = n => {
        let label = '';
        for (const item of outline) if (item.page && item.page <= n) label = item.label;
        return label;
      };

      // Resolve the PDF's outline (bookmarks panel in PDF viewers) to page numbers.
      const resolveOutline = async () => {
        let raw = [];
        try { raw = (await pdf.getOutline()) || []; } catch { raw = []; }
        const out = [];
        const walk = async (items, depth) => {
          for (const item of items) {
            let page = null;
            try {
              let dest = item.dest;
              if (typeof dest === 'string') dest = await pdf.getDestination(dest);
              if (Array.isArray(dest) && dest[0]) {
                page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
              }
            } catch { page = null; }
            const label = String(item.title || '').trim();
            if (label && page) out.push({ label, target: page, page, depth });
            if (item.items?.length) await walk(item.items, depth + 1);
          }
        };
        await walk(raw, 0);
        return out.sort((a, b) => a.page - b.page);
      };

      const engine = {
        kind: 'pdf',
        next: () => scrollToPage(basePage() + 1, true),
        prev: () => scrollToPage(basePage() - 1, true),
        goTo: n => scrollToPage(Number(n), false),
        seek: fraction => scrollToPage(1 + Math.round(fraction * (total - 1)), false),
        toc: () => outline,
        isOnScreen: at => at === currentPage,
        refreshState,
        bookmarkData: () => ({ at: currentPage, percent: total > 1 ? (currentPage - 1) / (total - 1) : 1, label: chapterFor(currentPage) ? `${chapterFor(currentPage)} · page ${currentPage}` : `Page ${currentPage}` }),
        applyPrefs: name => {
          if (name === 'pdfFit' || name === 'pdfScale') { layout(); Reader.onEngineReady(); }
        },
        zoomBy: factor => {
          prefs.pdfScale = Math.max(0.4, Math.min(4, scale * factor));
          savePrefs();
          layout();
          Reader.onEngineReady();
        },
        zoomLabel: () => `${Math.round(scale * 100)}%`,
        pageCount: () => total,
        resize: () => { if (!prefs.pdfScale) layout(); },
        destroy: () => {
          destroyed = true;
          container.removeEventListener('scroll', onScroll);
          cancelAnimationFrame(scrollFrame);
          clearTimeout(saveTimer);
          pages.forEach(unrender);
          try { pdf.destroy(); } catch {}
        }
      };

      outline = await resolveOutline();
      const saved = Reader.loadProgress(book.id);
      currentPage = saved?.page ? Math.min(total, Math.max(1, saved.page)) : 1;
      layout(currentPage);
      refreshState();
      container.focus({ preventScroll: true });
      Reader.onEngineReady();
      return engine;
    }
  };

  /* ---------------- Start ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
    $('ebook-email-form')?.addEventListener('submit', accessLibrary);
    $('ebook-logout')?.addEventListener('click', () => logout(true));
    Reader.wire();
    restoreSession();
  });
})();
