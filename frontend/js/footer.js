// Shared site footer. Renders straight away, then adds contact and social
// links from the admin settings once the backend responds.
(() => {
  const API_URL = 'https://authorpage-gybu.onrender.com';
  const mount = document.getElementById('site-footer');
  if (!mount) return;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const link = (href, text, external) => {
    const li = el('li');
    const a = el('a', '', text);
    a.href = href;
    if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    li.append(a);
    return li;
  };
  const safeUrl = value => {
    try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; }
  };

  const footer = el('footer', 'site-footer');
  const inner = el('div', 'site-footer__inner');

  const about = el('div', 'site-footer__about');
  about.append(
    el('p', 'site-footer__brand', 'Sai Krishna Seelaboyina'),
    el('p', 'site-footer__tagline', 'Stories of myth, technology, time and human connection — available in paperback and e-book, direct from the author.')
  );

  const explore = el('div');
  const exploreList = el('ul');
  [['books.html', 'Books'], ['about.html', 'About the Author'], ['reviews.html', 'Reader Reviews']]
    .forEach(([href, text]) => exploreList.append(link(href, text)));
  explore.append(el('h2', '', 'Explore'), exploreList);

  const readers = el('div');
  const readerList = el('ul');
  [['ebooks.html', 'My E-books'], ['order-status.html', 'Order Status']]
    .forEach(([href, text]) => readerList.append(link(href, text)));
  readers.append(el('h2', '', 'Readers'), readerList);

  inner.append(about, explore, readers);
  const bottom = el('div', 'site-footer__bottom', `© ${new Date().getFullYear()} Sai Krishna Seelaboyina. All rights reserved.`);
  footer.append(inner, bottom);
  mount.replaceWith(footer);

  fetch(`${API_URL}/api/footer-settings`, { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('Could not load footer settings'); return r.json(); })
    .then(data => {
      const list = el('ul');
      if (data.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) list.append(link(`mailto:${data.email}`, data.email));
      for (const [label, key] of [['Instagram', 'instagram'], ['LinkedIn', 'linkedin'], ['X (Twitter)', 'twitter']]) {
        const url = safeUrl(data[key]);
        if (url) list.append(link(url, label, true));
      }
      if (!list.children.length) return;
      const connect = el('div');
      connect.append(el('h2', '', 'Connect'), list);
      inner.append(connect);
      inner.classList.add('site-footer__inner--four');
    })
    .catch(error => console.error('Site footer:', error));
})();
