(() => {
  const API_URL = 'https://authorpage-gybu.onrender.com';
  const mount = document.getElementById('site-footer');
  if (!mount) return;
  const safeUrl = (value) => { try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } };
  fetch(`${API_URL}/api/footer-settings`, { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('Could not load footer settings'); return r.json(); })
    .then(data => {
      const footer = document.createElement('footer');
      footer.className = 'border-t border-slate-200 bg-slate-950 text-slate-100';
      const wrap = document.createElement('div');
      wrap.className = 'mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-5 py-8 text-center sm:flex-row sm:text-left';
      const brand = document.createElement('p'); brand.className = 'text-sm text-slate-300'; brand.textContent = `© ${new Date().getFullYear()} Sai Krishna Seelaboyina · Author`; wrap.append(brand);
      const links = document.createElement('div'); links.className = 'flex flex-wrap items-center justify-center gap-x-5 gap-y-3 text-sm';
      if (data.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) { const a = document.createElement('a'); a.href = `mailto:${data.email}`; a.textContent = data.email; a.className = 'hover:text-indigo-300'; links.append(a); }
      for (const [label, key] of [['LinkedIn','linkedin'], ['X (Twitter)','twitter'], ['Instagram','instagram']]) { const url = safeUrl(data[key]); if (!url) continue; const a = document.createElement('a'); a.href = url; a.textContent = label; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'hover:text-indigo-300'; links.append(a); }
      wrap.append(links); footer.append(wrap); mount.replaceWith(footer);
    }).catch(error => console.error('Site footer:', error));
})();
