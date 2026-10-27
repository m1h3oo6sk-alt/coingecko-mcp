'use strict';
const path = require('node:path');
const { DomainError } = require('./errors');
const { FileStore } = require('./file-store');
const { SQLiteCache } = require('./sqlite-cache');
const { CoinGeckoClient } = require('./coingecko-client');
const { SynthesisEngine } = require('./synthesis-engine');
const { normalizeCoinId, normalizeCurrency, asPublicAsset, isoDate } = require('./validation');

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
    this.fileStore.upsertAsset({ ...input, coin_id: coinId });
    this.sync();
    return asPublicAsset(this.cache.getAsset(coinId));
  }

  addSnapshot(input) {
    this.ready();
    const coinId = normalizeCoinId(input.coin_id || input.id);
    const existing = this.cache.getAsset(coinId);
    this.fileStore.upsertAsset({
      coin_id: coinId,
      symbol: input.symbol || (existing && existing.symbol),
      name: input.name || (existing && existing.name),
    });
    const snapshots = this.fileStore.appendSnapshots([input]);
    this.sync();
    return this.cache.latestSnapshot(coinId, snapshots[0].currency);
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
    for (const row of converted.snapshots) this.fileStore.upsertAsset(row);
    const stored = this.fileStore.appendSnapshots(converted.snapshots);
    this.sync();
    return stored.map((row) => this.cache.latestSnapshot(row.coin_id, row.currency));
  }

  async getPrice({ ids, currencies = ['usd'], persist = false, forceRefresh = false, cacheTtl = 30 } = {}) {
    this.ready();
    if (!Array.isArray(ids) || !ids.length) throw new DomainError('ids must contain at least one coin id.', 'EINVALID');
    ids = ids.map(normalizeCoinId);
    currencies = currencies.map(normalizeCurrency);
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
    this.cache.setApiCache(key, result, Math.min(3600, Math.max(0, cacheTtl)));
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
