// In-memory stand-in for the Google Sheets v4 REST API, covering the calls
// sheets-db.js makes. Like the real API it trims trailing empty cells/rows.
function createFakeSheets() {
  const tabs = new Map(); // title -> array of row arrays
  const log = [];

  const colNumber = letters => letters.split('').reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
  const colLetters = n => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

  function parseRange(range) {
    const m = /^'((?:[^']|'')+)'!(.*)$/.exec(range) || /^([^!]+)!(.*)$/.exec(range);
    if (!m) throw new Error(`bad range ${range}`);
    const title = m[1].replace(/''/g, "'");
    const ref = m[2];
    let r;
    if ((r = /^(\d+):(\d+)$/.exec(ref))) return { title, c1: 1, c2: Infinity, r1: +r[1], r2: +r[2] };
    if ((r = /^([A-Z]+):([A-Z]+)$/.exec(ref))) return { title, c1: colNumber(r[1]), c2: colNumber(r[2]), r1: 1, r2: Infinity };
    if ((r = /^([A-Z]+)(\d+):([A-Z]+)(\d*)$/.exec(ref))) return { title, c1: colNumber(r[1]), r1: +r[2], c2: colNumber(r[3]), r2: r[4] ? +r[4] : Infinity };
    if ((r = /^([A-Z]+)(\d+)$/.exec(ref))) return { title, c1: colNumber(r[1]), r1: +r[2], c2: colNumber(r[1]), r2: +r[2] };
    throw new Error(`bad ref ${ref}`);
  }

  function tab(title) {
    if (!tabs.has(title)) throw Object.assign(new Error(`Unable to parse range: ${title}`), { status: 400 });
    return tabs.get(title);
  }

  function read(range) {
    const { title, c1, c2, r1, r2 } = parseRange(range);
    const rows = tab(title);
    const out = [];
    for (let r = r1; r <= Math.min(r2, rows.length); r++) {
      const row = (rows[r - 1] || []).slice(c1 - 1, c2 === Infinity ? undefined : c2);
      while (row.length && (row[row.length - 1] === '' || row[row.length - 1] == null)) row.pop();
      out.push(row);
    }
    while (out.length && !out[out.length - 1].length) out.pop();
    return out;
  }

  function write(range, values) {
    const { title, c1, r1 } = parseRange(range);
    const rows = tab(title);
    values.forEach((vals, i) => {
      const r = r1 - 1 + i;
      while (rows.length <= r) rows.push([]);
      vals.forEach((v, j) => {
        const row = rows[r];
        while (row.length < c1 + j) row.push('');
        row[c1 - 1 + j] = v;
      });
    });
  }

  function lastUsedRow(rows) {
    for (let i = rows.length - 1; i >= 0; i--) if ((rows[i] || []).some(v => v !== '' && v != null)) return i + 1;
    return 0;
  }

  async function handle(method, path, body) {
    log.push({ method, path, body });
    const [p, q = ''] = path.split('?');
    const query = new URLSearchParams(q);
    if (method === 'GET' && p === '') return { sheets: [...tabs.keys()].map(title => ({ properties: { title } })) };
    if (method === 'POST' && p === ':batchUpdate') {
      for (const req of body.requests) if (req.addSheet) tabs.set(req.addSheet.properties.title, []);
      return {};
    }
    if (method === 'GET' && p === '/values:batchGet') {
      return { valueRanges: query.getAll('ranges').map(range => ({ range, values: read(range) })) };
    }
    if (method === 'POST' && p === '/values:batchUpdate') {
      if (body.valueInputOption !== 'RAW') throw new Error('expected RAW');
      for (const d of body.data) write(d.range, d.values);
      return {};
    }
    if (method === 'POST' && p === '/values:batchClear') {
      for (const range of body.ranges) {
        const { title, r1 } = parseRange(range);
        tabs.set(title, tab(title).slice(0, r1 - 1));
      }
      return {};
    }
    let m;
    if (method === 'POST' && (m = /^\/values\/(.+):append$/.exec(p))) {
      if (query.get('valueInputOption') !== 'RAW') throw new Error('expected RAW');
      const { title } = parseRange(decodeURIComponent(m[1]));
      const rows = tab(title);
      const start = lastUsedRow(rows) + 1;
      write(`'${title}'!A${start}`, body.values);
      const end = start + body.values.length - 1;
      return { updates: { updatedRange: `'${title}'!A${start}:${colLetters(body.values[0].length)}${end}` } };
    }
    if (method === 'GET' && (m = /^\/values\/(.+)$/.exec(p))) {
      return { values: read(decodeURIComponent(m[1])) };
    }
    throw new Error(`fake sheets: unhandled ${method} ${path}`);
  }

  // A fetch() that answers sheets.googleapis.com calls.
  async function fetch(url, opts = {}) {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v4\/spreadsheets\/[^/:]+/, '') + (u.search || '');
    try {
      const data = await handle(opts.method || 'GET', path, opts.body ? JSON.parse(opts.body) : undefined);
      return new Response(JSON.stringify(data), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ error: { message: error.message } }), { status: error.status || 500 });
    }
  }

  return { tabs, log, fetch, read: range => read(range) };
}

module.exports = { createFakeSheets };
