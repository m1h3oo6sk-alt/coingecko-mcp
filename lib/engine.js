'use strict';
const path = require('node:path');
const { DomainError } = require('./errors');
const { FileStore } = require('./file-store');
const { SQLiteCache } = require('./sqlite-cache');
const { CoinGeckoClient } = require('./coingecko-client');
const { SynthesisEngine } = require('./synthesis-engine');
const { normalizeCoinId, normalizeCurrency, asPublicAsset, asPublicSnapshot, isoDate, finiteNumber } = require('./validation');

class CoinGeckoEngine {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || process.env.COINGECKO_ROOT || process.cwd());
    this.fileStore = options.fileStore || new FileStore(this.rootDir);
    this.cache = options.cache || new SQLiteCache(path.join(this.fileStore.cacheDir, 'market.db'));
    this.client = options.client || new CoinGeckoClient(options.clientOptions);
    this.synthesizer = options.synthesizer || new SynthesisEngine(this.cache);
    this._ready = false;
  }

  ready() {
    if (!this._ready) {
      this.fileStore.init();
      this.cache.sync({ assets: this.fileStore.readAssets(), snapshots: this.fileStore.readSnapshots() });
      this._ready = true;
    }
    return this;
  }

  init() {
    const result = this.fileStore.init();
    this.ready();
    return { ...result, stats: this.stats() };
  }

  sync() {
    const result = this.cache.sync({ assets: this.fileStore.readAssets(), snapshots: this.fileStore.readSnapshots() });
    this._ready = true;
    return result;
  }

  addAsset(input) {
    this.ready();
    const coinId = normalizeCoinId(input.coin_id || input.id);
    const asset = this.fileStore.upsertAsset({ ...input, coin_id: coinId });
    this.cache.upsertAsset(asset);
    return asPublicAsset(this.cache.getAsset(coinId));
  }

  addSnapshot(input) {
    this.ready();
    const coinId = normalizeCoinId(input.coin_id || input.id);
    const existing = this.cache.getAsset(coinId);
    const asset = this.fileStore.upsertAsset({
      coin_id: coinId,
      symbol: input.symbol || (existing && existing.symbol),
      name: input.name || (existing && existing.name),
      amount: input.amount !== undefined ? input.amount : (existing && existing.amount),
    });
    this.cache.upsertAsset(asset);
    const [stored] = this.fileStore.appendSnapshots([input]);
    this.cache.upsertSnapshot(stored);
    return asPublicSnapshot({ ...stored, id: this.cache.latestSnapshot(coinId, stored.currency)?.id ?? null });
  }

  listAssets(filter = {}) {
    this.ready();
    return this.cache.listAssets(filter);
  }

  listSnapshots(filter = {}) {
    this.ready();
    if (filter.order && !['recent', 'oldest'].includes(filter.order)) {
      throw new DomainError('order must be "recent" or "oldest".', 'EINVALID');
    }
    return this.cache.listSnapshots({
      ...filter,
      coinId: filter.coinId ? normalizeCoinId(filter.coinId) : undefined,
      currency: filter.currency ? normalizeCurrency(filter.currency) : undefined,
      since: filter.since ? isoDate(filter.since, 'since') : undefined,
      until: filter.until ? isoDate(filter.until, 'until') : undefined,
    });
  }

  latestSnapshot(coinId, currency = 'usd') {
    this.ready();
    return this.cache.latestSnapshot(normalizeCoinId(coinId), normalizeCurrency(currency));
  }

  latestSnapshots(currency = 'usd') {
    this.ready();
    return this.cache.latestSnapshots(normalizeCurrency(currency));
  }

  _fromResponse(data, ids, currencies) {
    const snapshots = [], missing = [];
    const now = new Date().toISOString();
    for (const coinId of ids) {
      const asset = this.cache.getAsset(coinId);
      const record = data[coinId] || {};
      for (const currency of currencies) {
        if (record[currency] === undefined || record[currency] === null) {
          missing.push({ coin_id: coinId, currency });
          continue;
        }
        const updated = record.last_updated_at;
        snapshots.push({
          coin_id: coinId,
          symbol: asset ? asset.symbol : coinId,
          name: asset ? asset.name : coinId,
          currency,
          price: record[currency],
          market_cap: record[`${currency}_market_cap`] ?? null,
          total_volume: record[`${currency}_24h_vol`] ?? null,
          price_change_percentage_24h: record[`${currency}_24h_change`] ?? null,
          last_updated_at: typeof updated === 'number' ? new Date(updated * 1000).toISOString() : (updated || now),
          fetched_at: now,
          source: 'coingecko',
        });
      }
    }
    return { snapshots, missing };
  }

  _persistConverted(converted) {
    if (!converted.snapshots.length) return [];
    const stored = [];
    for (const row of converted.snapshots) {
      const asset = this.fileStore.upsertAsset(row);
      this.cache.upsertAsset(asset);
      const [saved] = this.fileStore.appendSnapshots([row]);
      this.cache.upsertSnapshot(saved);
      stored.push(asPublicSnapshot({ ...saved, id: this.cache.latestSnapshot(saved.coin_id, saved.currency)?.id ?? null }));
    }
    return stored;
  }

  async getPrice({ ids, currencies = ['usd'], persist = false, forceRefresh = false, cacheTtl = 30 } = {}) {
    this.ready();
    if (!Array.isArray(ids) || !ids.length) throw new DomainError('ids must contain at least one coin id.', 'EINVALID');
    const seen = new Set();
    ids = ids.map(normalizeCoinId).filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
    currencies = [...new Set(currencies.map(normalizeCurrency))];
    const key = `${this.client.baseUrl}|simplePrice|${ids.slice().sort().join(',')}|${currencies.slice().sort().join(',')}`;
    if (!forceRefresh) {
      const cached = this.cache.getApiCache(key);
      if (cached) {
        if (!persist || (Array.isArray(cached.snapshots) && cached.snapshots.length)) {
          return { ...cached, cached: true };
        }
        const convertedCached = this._fromResponse(cached.data, ids, currencies);
        const snapshots = this._persistConverted(convertedCached);
        return { ...cached, missing: convertedCached.missing, snapshots, cached: true };
      }
    }
    const data = await this.client.simplePrice({ ids, currencies });
    const converted = this._fromResponse(data, ids, currencies);
    const result = { data, missing: converted.missing, snapshots: [], cached: false, source: 'coingecko' };
    if (persist) result.snapshots = this._persistConverted(converted);
    const cacheable = { ...result, snapshots: result.snapshots.map(({ id, ...rest }) => ({ ...rest, id: null })) };
    this.cache.setApiCache(key, cacheable, Math.min(3600, Math.max(0, cacheTtl)));
    return result;
  }

  async refresh({ coinId, currency = 'usd' } = {}) {
    this.ready();
    currency = normalizeCurrency(currency);
    let ids;
    if (coinId) {
      ids = [normalizeCoinId(coinId)];
      if (!this.cache.getAsset(ids[0])) throw new DomainError(`Unknown tracked asset "${ids[0]}".`, 'ENOTFOUND');
    } else {
      ids = this.cache.listAssets().map((asset) => asset.coin_id);
    }
    if (!ids.length) throw new DomainError('No tracked assets. Add an asset before refresh.', 'ENOTFOUND');
    const result = await this.getPrice({ ids, currencies: [currency], persist: true, forceRefresh: true });
    if (!result.snapshots.length) throw new DomainError('CoinGecko returned no usable prices for refresh.', 'ENODATA', { missing: result.missing });
    return {
      refreshed: result.snapshots.length,
      snapshots: result.snapshots,
      missing: result.missing,
      currency,
      cached: false,
    };
  }

  async ping() {
    this.ready();
    return this.client.ping();
  }

  synthesize(options = {}) {
    this.ready();
    return options.write === false
      ? this.synthesizer.synthesize(options)
      : this.synthesizer.synthesizeToFile(this.fileStore, options);
  }

  portfolio({ currency = 'usd' } = {}) {
    this.ready();
    currency = normalizeCurrency(currency);
    const assets = this.cache.listAssets();
    const latest = this.cache.latestSnapshots(currency);
    const latestByCoin = new Map(latest.map((row) => [row.coin_id, row]));
    const positions = [];
    let totalValue = 0;
    let totalCost = 0;
    for (const asset of assets) {
      const amount = asset.amount == null ? null : Number(asset.amount);
      const row = latestByCoin.get(asset.coin_id);
      const price = row ? row.price : null;
      const value = amount != null && price != null ? amount * price : null;
      if (value != null) totalValue += value;
      positions.push({
        coin_id: asset.coin_id,
        symbol: asset.symbol,
        name: asset.name,
        amount,
        price,
        value,
        currency,
        price_change_percentage_24h: row ? row.price_change_percentage_24h : null,
        last_updated_at: row ? row.last_updated_at : null,
      });
    }
    return {
      currency,
      positions,
      totals: {
        assets: assets.length,
        priced: positions.filter((p) => p.value != null).length,
        value: totalValue,
        cost: totalCost || null,
        pnl: totalCost ? totalValue - totalCost : null,
        pnlPercentage: totalCost ? ((totalValue - totalCost) / totalCost) * 100 : null,
      },
    };
  }

  async marketChart({ coinId, currency = 'usd', days = 1, persist = false } = {}) {
    this.ready();
    const id = normalizeCoinId(coinId);
    currency = normalizeCurrency(currency);
    const result = await this.client.marketChart({ id, currency, days });
    const prices = (result.prices || []).map(([timestamp, price]) => ({
      timestamp: new Date(timestamp).toISOString(),
      price,
    }));
    const volumes = (result.total_volumes || []).map(([timestamp, volume]) => ({
      timestamp: new Date(timestamp).toISOString(),
      volume,
    }));
    return { coin_id: id, currency, days, prices, volumes, count: prices.length };
  }

  async addMarkets({ currency = 'usd', perPage = 10, page = 1, persist = true } = {}) {
    this.ready();
    currency = normalizeCurrency(currency);
    const rows = await this.client.markets({ currency, perPage, page });
    const added = [];
    for (const row of rows) {
      const coinId = normalizeCoinId(row.id);
      const asset = this.fileStore.upsertAsset({
        coin_id: coinId,
        symbol: row.symbol,
        name: row.name,
      });
      this.cache.upsertAsset(asset);
      if (persist && row.current_price != null) {
        const [stored] = this.fileStore.appendSnapshots([{
          coin_id: coinId,
          symbol: row.symbol,
          name: row.name,
          currency,
          price: row.current_price,
          market_cap: row.market_cap,
          total_volume: row.total_volume,
          price_change_percentage_24h: row.price_change_percentage_24h,
          last_updated_at: row.last_updated ? new Date(row.last_updated).toISOString() : undefined,
          source: 'coingecko',
        }]);
        this.cache.upsertSnapshot(stored);
        added.push(asPublicSnapshot({ ...stored, id: this.cache.latestSnapshot(coinId, currency)?.id ?? null }));
      }
    }
    return { tracked: rows.length, persisted: added.length, assets: rows.map((row) => row.id) };
  }

  alert({ above = null, below = null, currency = 'usd' } = {}) {
    this.ready();
    currency = normalizeCurrency(currency);
    if (above == null && below == null) {
      throw new DomainError('Provide at least one of above or below thresholds.', 'EINVALID');
    }
    const aboveValue = above == null ? null : finiteNumber(above, 'above', { min: 0 });
    const belowValue = below == null ? null : finiteNumber(below, 'below', { min: 0 });
    const latest = this.cache.latestSnapshots(currency);
    const triggers = [];
    for (const row of latest) {
      const reasons = [];
      if (aboveValue != null && row.price >= aboveValue) reasons.push(`price ${row.price} >= above ${aboveValue}`);
      if (belowValue != null && row.price <= belowValue) reasons.push(`price ${row.price} <= below ${belowValue}`);
      if (reasons.length) triggers.push({ coin_id: row.coin_id, symbol: row.symbol, price: row.price, currency: row.currency, reasons, last_updated_at: row.last_updated_at });
    }
    return {
      currency,
      thresholds: { above: aboveValue, below: belowValue },
      checked: latest.length,
      triggered: triggers.length,
      triggers,
    };
  }

  exportSnapshots({ format = 'jsonl' } = {}) {
    this.ready();
    if (!['jsonl', 'csv'].includes(format)) {
      throw new DomainError('format must be "jsonl" or "csv".', 'EINVALID');
    }
    return { format, content: this.fileStore.exportSnapshots(format) };
  }

  importSnapshots({ payload, format = 'jsonl' } = {}) {
    this.ready();
    if (!['jsonl', 'csv'].includes(format)) {
      throw new DomainError('format must be "jsonl" or "csv".', 'EINVALID');
    }
    if (typeof payload !== 'string' || !payload.trim()) {
      throw new DomainError('payload must be a non-empty string.', 'EINVALID');
    }
    const result = this.fileStore.importSnapshots(payload, format);
    this.sync();
    return result;
  }

  stats() {
    this.ready();
    return { rootDir: this.rootDir, ...this.cache.stats() };
  }

  close() {
    this.cache.close();
    this._ready = false;
  }
}

module.exports = { CoinGeckoEngine };
