'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DomainError } = require('./errors');
const { normalizeCoinId, normalizeCurrency, finiteNumber, isoDate, nonEmptyString } = require('./validation');

function atomicWrite(filePath, text) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
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

  appendSnapshots(inputs) {
    this.ensureInitialized();
    const snapshots = inputs.map(normalizeSnapshot);
    if (!snapshots.length) return [];
    const lines = snapshots.map((item) => JSON.stringify(item)).join('\n') + '\n';
    const current = fs.readFileSync(this.snapshotsPath, 'utf8');
    fs.appendFileSync(this.snapshotsPath, (current && !current.endsWith('\n') ? '\n' : '') + lines, 'utf8');
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

  writeSynthesis(feature, markdown) {
    this.ensureInitialized();
    const safe = String(feature || 'portfolio').replace(/[^a-z0-9-]/g, '-');
    const file = path.join(this.synthesisDir, `${safe}.md`);
    atomicWrite(file, markdown.endsWith('\n') ? markdown : markdown + '\n');
    return file;
  }
}

module.exports = { FileStore, normalizeAsset, normalizeSnapshot, atomicWrite };
