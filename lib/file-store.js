'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DomainError } = require('./errors');
const { normalizeCoinId, normalizeCurrency, finiteNumber, isoDate, nonEmptyString } = require('./validation');

function atomicWrite(filePath, text) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* best effort */ }
    throw new DomainError(`Cannot write ${filePath}: ${err.message}`, 'EIO');
  }
}

function normalizeAsset(input = {}) {
  const coinId = normalizeCoinId(input.coin_id || input.id);
  const now = new Date().toISOString();
  return {
    coin_id: coinId,
    symbol: String(input.symbol || coinId).trim().toLowerCase(),
    name: String(input.name || coinId).trim(),
    platforms: input.platforms && typeof input.platforms === 'object' && !Array.isArray(input.platforms) ? input.platforms : {},
    created_at: input.created_at ? isoDate(input.created_at, 'created_at') : now,
    updated_at: input.updated_at ? isoDate(input.updated_at, 'updated_at') : now,
    amount: input.amount == null ? null : finiteNumber(input.amount, 'amount', { required: false, min: 0 }),
  };
}

function normalizeSnapshot(input = {}) {
  const coinId = normalizeCoinId(input.coin_id || input.id);
  const fetchedAt = input.fetched_at ? isoDate(input.fetched_at, 'fetched_at') : new Date().toISOString();
  return {
    coin_id: coinId,
    symbol: String(input.symbol || coinId).trim().toLowerCase(),
    name: String(input.name || coinId).trim(),
    currency: normalizeCurrency(input.currency || input.vs_currency || 'usd'),
    price: finiteNumber(input.price, 'price', { min: 0 }),
    market_cap: finiteNumber(input.market_cap, 'market_cap', { required: false, min: 0 }),
    total_volume: finiteNumber(input.total_volume, 'total_volume', { required: false, min: 0 }),
    price_change_percentage_24h: finiteNumber(input.price_change_percentage_24h, 'price_change_percentage_24h', { required: false }),
    last_updated_at: input.last_updated_at ? isoDate(input.last_updated_at, 'last_updated_at') : fetchedAt,
    fetched_at: fetchedAt,
    source: String(input.source || 'manual').trim() || 'manual',
  };
}

class FileStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.dataDir = path.join(this.rootDir, '.coingecko');
    this.assetsPath = path.join(this.dataDir, 'assets.json');
    this.snapshotsPath = path.join(this.dataDir, 'snapshots.jsonl');
    this.synthesisDir = path.join(this.dataDir, 'synthesis');
    this.cacheDir = path.join(this.dataDir, 'cache');
  }

  init() {
    const created = [];
    for (const dir of [this.dataDir, this.synthesisDir, this.cacheDir]) {
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); created.push(dir); }
    }
    if (!fs.existsSync(this.assetsPath)) {
      atomicWrite(this.assetsPath, `${JSON.stringify({ version: 1, assets: [] }, null, 2)}\n`);
      created.push(this.assetsPath);
    }
    if (!fs.existsSync(this.snapshotsPath)) {
      atomicWrite(this.snapshotsPath, '');
      created.push(this.snapshotsPath);
    }
    return { rootDir: this.rootDir, created };
  }

  ensureInitialized() {
    if (!fs.existsSync(this.assetsPath) || !fs.existsSync(this.snapshotsPath)) {
      throw new DomainError(`CoinGecko store is not initialized under ${this.rootDir}. Run "coingecko-mcp init" first.`, 'ENOTINIT');
    }
  }

  readAssets() {
    this.ensureInitialized();
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(this.assetsPath, 'utf8')); }
    catch (err) { throw new DomainError(`Cannot parse ${this.assetsPath}: ${err.message}. The file was not modified.`, 'ECORRUPT'); }
    if (!parsed || !Array.isArray(parsed.assets)) {
      throw new DomainError(`${this.assetsPath} must contain an assets array. The file was not modified.`, 'ECORRUPT');
    }
    try {
      const assets = parsed.assets.map(normalizeAsset);
      const ids = new Set();
      for (const asset of assets) {
        if (ids.has(asset.coin_id)) throw new Error(`duplicate coin_id "${asset.coin_id}"`);
        ids.add(asset.coin_id);
      }
      return assets;
    }
    catch (err) { throw new DomainError(`Invalid asset in ${this.assetsPath}: ${err.message}`, 'ECORRUPT'); }
  }

  writeAssets(assets) {
    atomicWrite(this.assetsPath, `${JSON.stringify({ version: 1, assets }, null, 2)}\n`);
  }

  upsertAsset(input) {
    const coinId = normalizeCoinId(input.coin_id || input.id);
    const assets = this.readAssets();
    const index = assets.findIndex((item) => item.coin_id === coinId);
    const existing = index >= 0 ? assets[index] : {};
    const asset = normalizeAsset({
      ...existing,
      ...input,
      coin_id: coinId,
      created_at: existing.created_at || input.created_at,
      updated_at: input.updated_at || new Date().toISOString(),
    });
    if (index >= 0) assets[index] = asset;
    else assets.push(asset);
    assets.sort((a, b) => a.coin_id.localeCompare(b.coin_id));
    this.writeAssets(assets);
    return asset;
  }

  _needsLeadingNewline() {
    try {
      const { size } = fs.statSync(this.snapshotsPath);
      if (size === 0) return false;
      const fd = fs.openSync(this.snapshotsPath, 'r');
      try {
        const buffer = Buffer.alloc(1);
        fs.readSync(fd, buffer, 0, 1, size - 1);
        return buffer[0] !== 0x0a;
      } finally {
        fs.closeSync(fd);
      }
    } catch (_) {
      return false;
    }
  }

  appendSnapshots(inputs) {
    this.ensureInitialized();
    const snapshots = inputs.map(normalizeSnapshot);
    if (!snapshots.length) return [];
    const lines = snapshots.map((item) => JSON.stringify(item)).join('\n') + '\n';
    fs.appendFileSync(this.snapshotsPath, (this._needsLeadingNewline() ? '\n' : '') + lines, 'utf8');
    return snapshots;
  }

  readSnapshots() {
    this.ensureInitialized();
    const text = fs.readFileSync(this.snapshotsPath, 'utf8');
    const rows = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try { rows.push(normalizeSnapshot(JSON.parse(line))); }
      catch (err) {
        throw new DomainError(`Invalid snapshot at ${this.snapshotsPath}:${index + 1}: ${err.message}. The file was not modified.`, 'ECORRUPT');
      }
    }
    return rows;
  }

  exportSnapshots(format = 'jsonl') {
    const rows = this.readSnapshots();
    if (format === 'csv') {
      const header = ['coin_id', 'symbol', 'name', 'currency', 'price', 'market_cap', 'total_volume', 'price_change_percentage_24h', 'last_updated_at', 'fetched_at', 'source'];
      const escape = (value) => {
        const text = value == null ? '' : String(value);
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const lines = rows.map((row) => header.map((key) => escape(row[key])).join(','));
      return [header.join(','), ...lines].join('\n') + '\n';
    }
    return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  }

  importSnapshots(payload, format = 'jsonl') {
    this.ensureInitialized();
    let inputs;
    if (format === 'csv') {
      const lines = String(payload).split(/\r?\n/).filter((line) => line.trim());
      if (!lines.length) return { imported: 0, skipped: 0, errors: [] };
      const header = parseCsvLine(lines[0]);
      inputs = lines.slice(1).map((line) => {
        const cells = parseCsvLine(line);
        const row = {};
        header.forEach((key, index) => { row[key] = cells[index]; });
        return row;
      });
    } else {
      inputs = String(payload).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    }
    const errors = [];
    const valid = [];
    for (const [index, input] of inputs.entries()) {
      try { valid.push(normalizeSnapshot(input)); }
      catch (err) { errors.push({ line: index + 1, message: err.message }); }
    }
    if (valid.length) this.appendSnapshots(valid);
    return { imported: valid.length, skipped: errors.length, errors };
  }

  writeSynthesis(feature, markdown) {
    this.ensureInitialized();
    const safe = String(feature || 'portfolio').replace(/[^a-z0-9-]/g, '-');
    const file = path.join(this.synthesisDir, `${safe}.md`);
    atomicWrite(file, markdown.endsWith('\n') ? markdown : markdown + '\n');
    return file;
  }
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += char;
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else current += char;
  }
  cells.push(current);
  return cells;
}

module.exports = { FileStore, normalizeAsset, normalizeSnapshot, atomicWrite };
