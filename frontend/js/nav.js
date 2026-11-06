// Shared header behaviour: highlight the current page and run the mobile menu.
(() => {
  const nav = document.getElementById('site-nav');
  const toggle = document.querySelector('.nav-toggle');
  if (!nav) return;

  const current = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const page = current === 'book-details.html' ? 'books.html' : current;
  for (const link of nav.querySelectorAll('a')) {
    if (link.getAttribute('href').toLowerCase() === page) link.setAttribute('aria-current', 'page');
  }

  if (!toggle) return;
  const setOpen = open => {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    toggle.textContent = open ? '✕' : '☰';
  };
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && nav.classList.contains('is-open')) {
      setOpen(false);
      toggle.focus();
    }
  });
  window.matchMedia('(min-width: 901px)').addEventListener('change', event => {
    if (event.matches) setOpen(false);
  });
})();
