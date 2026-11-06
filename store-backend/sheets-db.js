// A small table layer on top of the Google Sheets API.
//
// Each table is one tab: row 1 holds column names, every other row is a record.
// - The whole spreadsheet is cached in memory, so reads are instant.
// - Writes go through one queue (no two writes interleave) and are sent with
//   valueInputOption=RAW, so text typed by customers is never run as a formula.
// - Columns are matched by header name: you may reorder columns or add your own
//   note columns in the Sheet without breaking the server.
// - Before updating, the row is re-located by its key column, so sorting or
//   inserting rows by hand in the Sheet cannot make the server overwrite the
//   wrong record.
// - The cache is re-read from the Sheet periodically, so edits made by hand in
//   the Sheet reach the website within about a minute.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/* ---------------- Cell conversion ---------------- */

function formatDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

function parseDate(value) {
  if (value === '' || value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    // A date typed by hand into the Sheet arrives as a serial day number (IST).
    return new Date(Math.round((value - 25569) * 86400000) - IST_OFFSET_MS);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(text)) {
    const iso = text.length === 10 ? `${text}T00:00:00` : text.replace(' ', 'T');
    const d = new Date(`${iso}+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

const TYPES = {
  string: {
    toCell: v => (v == null ? '' : String(v)),
    fromCell: v => (v == null ? '' : String(v))
  },
  number: {
    toCell: v => (v === '' || v == null || !Number.isFinite(Number(v)) ? '' : Number(v)),
    fromCell: v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v))
  },
  boolean: {
    toCell: v => Boolean(v),
    fromCell: v => (v === '' || v == null ? null : v === true || /^(true|yes|y|1)$/i.test(String(v).trim()))
  },
  date: {
    toCell: v => (v ? formatDate(v) : ''),
    fromCell: parseDate
  },
  json: {
    toCell: v => (v == null ? '' : JSON.stringify(v)),
    fromCell: v => {
      if (v === '' || v == null) return null;
      try { return JSON.parse(v); } catch { return null; }
    }
  }
};

function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const quote = name => `'${String(name).replace(/'/g, "''")}'`;
const clone = value => structuredClone(value);
const sameCell = (a, b) => (a === '' || a == null ? '' : a) === (b === '' || b == null ? '' : b) ||
  (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

/* ---------------- Table ---------------- */

class Table {
  constructor(db, def) {
    this.db = db;
    this.name = def.name;
    this.key = def.key || null;
    this.columns = def.columns.map(([name, type, extra]) => ({ name, type: type || 'string', ...(extra || {}) }));
    this.toRow = def.toRow || (obj => obj);
    this.fromRow = def.fromRow || (row => row);
    this.header = [];
    this.colIndex = new Map();
    this.rows = []; // [{ row: sheetRowNumber, data, cells }]
  }

  /* --- parsing --- */

  applyValues(values) {
    const header = (values[0] || []).map(h => String(h).trim());
    const missing = this.columns.filter(c => !header.includes(c.name));
    if (missing.length) {
      if (this.header.length) {
        this.db.log.warn(`[sheets] "${this.name}" is missing column(s) ${missing.map(c => c.name).join(', ')}; keeping previous data until it is fixed.`);
        return false;
      }
      throw new Error(`Sheet "${this.name}" is missing column(s): ${missing.map(c => c.name).join(', ')}`);
    }
    this.header = header;
    this.colIndex = new Map(header.map((h, i) => [h, i]));
    const rows = [];
    for (let i = 1; i < values.length; i++) {
      const raw = values[i] || [];
      const cells = {};
      for (const col of this.columns) {
        const v = raw[this.colIndex.get(col.name)];
        cells[col.name] = v === undefined ? '' : v;
      }
      if (this.key && (cells[this.key] === '' || cells[this.key] == null)) continue;
      if (!this.key && this.columns.every(c => cells[c.name] === '')) continue;
      const typed = {};
      for (const col of this.columns) {
        const parsed = TYPES[col.type].fromCell(cells[col.name]);
        typed[col.name] = parsed == null && col.default !== undefined ? col.default : parsed;
      }
      rows.push({ row: i + 1, data: this.fromRow(typed), cells });
    }
    this.rows = rows;
    return true;
  }

  cellsFor(obj) {
    const plain = this.toRow(obj);
    const cells = {};
    for (const col of this.columns) cells[col.name] = TYPES[col.type].toCell(plain[col.name]);
    return cells;
  }

  /* --- reads (synchronous, from cache) --- */

  all() { return this.rows.map(r => clone(r.data)); }
  find(predicate) { return this.rows.filter(r => predicate(r.data)).map(r => clone(r.data)); }
  findOne(predicate) { const r = this.rows.find(x => predicate(x.data)); return r ? clone(r.data) : null; }
  get(keyValue) { return this.findOne(d => this.keyOf(d) === String(keyValue)); }
  count() { return this.rows.length; }
  keyOf(data) { return String(this.cellsFor(data)[this.key] ?? ''); }

  /* --- writes (queued) --- */

  insert(obj) { return this.insertMany([obj]).then(list => list[0]); }

  insertMany(objects) {
    if (!objects.length) return Promise.resolve([]);
    return this.db.enqueue(() => this.appendNow(objects, false));
  }

  // Insert only the records whose key is not already present (checked and
  // written in one queued step, so concurrent callers cannot double-insert).
  ensureMany(objects) {
    if (!objects.length) return Promise.resolve([]);
    return this.db.enqueue(() => this.appendNow(objects, true));
  }

  async appendNow(objects, skipExisting) {
    let prepared = objects.map(o => ({ data: clone(o), cells: this.cellsFor(o) }));
    if (this.key) {
      const keys = new Set(this.rows.map(r => String(r.cells[this.key])));
      const kept = [];
      for (const p of prepared) {
        const k = String(p.cells[this.key]);
        if (!k) throw new Error(`${this.name}: missing ${this.key}`);
        if (keys.has(k)) {
          if (skipExisting) continue;
          throw new Error(`${this.name}: duplicate ${this.key} "${k}"`);
        }
        keys.add(k);
        kept.push(p);
      }
      prepared = kept;
    }
    if (!prepared.length) return [];
    {
      const width = this.header.length;
      const values = prepared.map(p => {
        const row = new Array(width).fill('');
        for (const col of this.columns) row[this.colIndex.get(col.name)] = p.cells[col.name];
        return row;
      });
      const result = await this.db.api('POST',
        `/values/${encodeURIComponent(`${quote(this.name)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { values });
      const start = Number(/![A-Z]+(\d+)/.exec(result?.updates?.updatedRange || '')?.[1]);
      prepared.forEach((p, i) => {
        this.rows.push({ row: Number.isFinite(start) ? start + i : NaN, data: p.data, cells: p.cells });
      });
      if (!Number.isFinite(start)) await this.reload();
      return prepared.map(p => clone(p.data));
    }
  }

  update(keyValue, patch) {
    return this.updateMany([{ key: keyValue, patch }]).then(list => list[0]);
  }

  // patch: object of fields to merge, or a function (current) => next.
  updateMany(changes) {
    if (!changes.length) return Promise.resolve([]);
    if (!this.key) return Promise.reject(new Error(`${this.name} has no key column`));
    return this.db.enqueue(() => this.updateNow(changes));
  }

  async updateNow(changes) {
    {
      const keyCol = columnLetter(this.colIndex.get(this.key));
      // Re-read the key column so rows moved by hand in the Sheet are still found.
      const keyRange = `${quote(this.name)}!${keyCol}:${keyCol}`;
      const live = await this.db.api('GET', `/values/${encodeURIComponent(keyRange)}?valueRenderOption=UNFORMATTED_VALUE`);
      const rowOfKey = new Map();
      (live.values || []).forEach((v, i) => { if (i > 0 && v && v[0] !== '' && v[0] != null) rowOfKey.set(String(v[0]), i + 1); });

      const data = [];
      const results = [];
      for (const { key, patch } of changes) {
        const entry = this.rows.find(r => String(r.cells[this.key]) === String(key));
        const sheetRow = rowOfKey.get(String(key));
        if (!entry || !sheetRow) throw Object.assign(new Error(`${this.name}: "${key}" not found`), { status: 404 });
        const next = typeof patch === 'function' ? patch(clone(entry.data)) : Object.assign(clone(entry.data), patch);
        const cells = this.cellsFor(next);
        if (String(cells[this.key]) !== String(key)) throw new Error(`${this.name}: the ${this.key} column cannot be changed`);
        for (const col of this.columns) {
          if (!sameCell(cells[col.name], entry.cells[col.name])) {
            data.push({ range: `${quote(this.name)}!${columnLetter(this.colIndex.get(col.name))}${sheetRow}`, values: [[cells[col.name]]] });
          }
        }
        results.push({ entry, next, cells, sheetRow });
      }
      if (data.length) await this.db.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data });
      for (const r of results) {
        r.entry.row = r.sheetRow;
        r.entry.data = clone(r.next);
        r.entry.cells = r.cells;
      }
      return results.map(r => clone(r.next));
    }
  }

  // Insert, or replace the existing row with the same key, as one queued step.
  upsert(obj) {
    return this.db.enqueue(async () => {
      const key = this.keyOf(obj);
      const exists = this.rows.some(r => String(r.cells[this.key]) === key);
      const [saved] = exists
        ? await this.updateNow([{ key, patch: () => obj }])
        : await this.appendNow([obj], false);
      return saved;
    });
  }

  async reload() {
    const res = await this.db.api('GET', `/values/${encodeURIComponent(`${quote(this.name)}!A1:ZZ`)}?valueRenderOption=UNFORMATTED_VALUE`);
    this.applyValues(res.values || []);
  }
}

/* ---------------- Database ---------------- */

class SheetsDB {
  constructor({ spreadsheetId, getAccessToken, fetch: fetchImpl, refreshMs = 60_000, log = console }) {
    if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_ID is not set.');
    this.spreadsheetId = spreadsheetId;
    this.getAccessToken = getAccessToken;
    this.fetch = fetchImpl || globalThis.fetch;
    this.refreshMs = refreshMs;
    this.log = log;
    this.tables = [];
    this.queue = Promise.resolve();
    this.pendingWrites = 0;
    this.writeVersion = 0;
    this.ready = false;
    this.timer = null;
  }

  define(def) {
    const table = new Table(this, def);
    this.tables.push(table);
    return table;
  }

  async api(method, path, body) {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getAccessToken();
      const res = await this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 3) {
        const err = new Error(`Google Sheets: ${data?.error?.message || `HTTP ${res.status}`}`);
        err.status = res.status;
        throw err;
      }
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
    }
  }

  enqueue(fn) {
    this.pendingWrites++;
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run.finally(() => { this.pendingWrites--; this.writeVersion++; });
  }

  // Create missing tabs and header cells, then load everything.
  async init() {
    const meta = await this.api('GET', '?fields=sheets.properties(title)');
    const existing = new Set((meta.sheets || []).map(s => s.properties.title));
    const toAdd = this.tables.filter(t => !existing.has(t.name));
    if (toAdd.length) {
      await this.api('POST', ':batchUpdate', {
        requests: toAdd.map(t => ({ addSheet: { properties: { title: t.name, gridProperties: { frozenRowCount: 1 } } } }))
      });
    }
    const headers = await this.batchGet(this.tables.map(t => `${quote(t.name)}!1:1`));
    const fixes = [];
    this.tables.forEach((t, i) => {
      const header = ((headers[i] || [])[0] || []).map(h => String(h).trim());
      const missing = t.columns.map(c => c.name).filter(n => !header.includes(n));
      if (missing.length) {
        fixes.push({ range: `${quote(t.name)}!${columnLetter(header.length)}1`, values: [missing] });
      }
    });
    if (fixes.length) await this.api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: fixes });
    await this.loadAll(true);
    this.ready = true;
  }

  async batchGet(ranges) {
    const qs = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
    const res = await this.api('GET', `/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE`);
    return (res.valueRanges || []).map(v => v.values || []);
  }

  async loadAll(strict = false) {
    const versionBefore = this.writeVersion;
    const all = await this.batchGet(this.tables.map(t => `${quote(t.name)}!A1:ZZ`));
    // A write finished while we were reading: our snapshot may be older than the cache.
    if (!strict && (this.pendingWrites > 0 || this.writeVersion !== versionBefore)) return false;
    this.tables.forEach((t, i) => t.applyValues(all[i]));
    return true;
  }

  startAutoRefresh() {
    if (this.timer || !this.refreshMs) return;
    this.timer = setInterval(() => {
      if (this.pendingWrites > 0) return;
      this.loadAll().catch(err => this.log.warn('[sheets] refresh failed:', err.message));
    }, this.refreshMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}

module.exports = { SheetsDB, formatDate, parseDate, columnLetter };
