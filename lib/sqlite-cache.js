'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { asPublicAsset, asPublicSnapshot } = require('./validation');

class SQLiteCache {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        coin_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        platforms TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        currency TEXT NOT NULL,
        price REAL NOT NULL,
        market_cap REAL,
        total_volume REAL,
        price_change_percentage_24h REAL,
        last_updated_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        source TEXT NOT NULL,
        UNIQUE(coin_id, currency, last_updated_at)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_coin_time ON snapshots(coin_id, currency, last_updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_fetched ON snapshots(fetched_at DESC);
      CREATE TABLE IF NOT EXISTS api_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS synthesis_cache (
        feature TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  sync({ assets, snapshots }) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM assets; DELETE FROM snapshots; DELETE FROM synthesis_cache;');
      const assetStmt = this.db.prepare('INSERT INTO assets(coin_id,symbol,name,platforms,created_at,updated_at) VALUES(?,?,?,?,?,?)');
      for (const row of assets) assetStmt.run(row.coin_id, row.symbol, row.name, JSON.stringify(row.platforms || {}), row.created_at, row.updated_at);
      const snapshotStmt = this.db.prepare(`INSERT INTO snapshots
        (coin_id,symbol,name,currency,price,market_cap,total_volume,price_change_percentage_24h,last_updated_at,fetched_at,source)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(coin_id,currency,last_updated_at) DO UPDATE SET
          symbol=excluded.symbol,name=excluded.name,price=excluded.price,market_cap=excluded.market_cap,
          total_volume=excluded.total_volume,price_change_percentage_24h=excluded.price_change_percentage_24h,
          fetched_at=excluded.fetched_at,source=excluded.source`);
      for (const row of snapshots) snapshotStmt.run(
        row.coin_id, row.symbol, row.name, row.currency, row.price, row.market_cap, row.total_volume,
        row.price_change_percentage_24h, row.last_updated_at, row.fetched_at, row.source,
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { assets: assets.length, snapshots: snapshots.length };
  }

  upsertAsset(row) {
    this.db.prepare(`INSERT INTO assets(coin_id,symbol,name,platforms,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(coin_id) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,platforms=excluded.platforms,updated_at=excluded.updated_at`
    ).run(row.coin_id, row.symbol, row.name, JSON.stringify(row.platforms || {}), row.created_at, row.updated_at);
    this.invalidateSynthesis(row.coin_id);
    this.invalidateSynthesis('portfolio');
    return asPublicAsset(this.getAsset(row.coin_id));
  }

  upsertSnapshot(row) {
    const result = this.db.prepare(`INSERT INTO snapshots
      (coin_id,symbol,name,currency,price,market_cap,total_volume,price_change_percentage_24h,last_updated_at,fetched_at,source)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(coin_id,currency,last_updated_at) DO UPDATE SET
        symbol=excluded.symbol,name=excluded.name,price=excluded.price,market_cap=excluded.market_cap,
        total_volume=excluded.total_volume,price_change_percentage_24h=excluded.price_change_percentage_24h,
        fetched_at=excluded.fetched_at,source=excluded.source`
    ).run(row.coin_id, row.symbol, row.name, row.currency, row.price, row.market_cap, row.total_volume,
      row.price_change_percentage_24h, row.last_updated_at, row.fetched_at, row.source);
    this.invalidateSynthesis(row.coin_id);
    this.invalidateSynthesis('portfolio');
    return { id: Number(result.lastInsertRowid), changed: true };
  }

  getAsset(coinId) {
    return this.db.prepare('SELECT * FROM assets WHERE coin_id=?').get(coinId) || null;
  }

  listAssets({ query, limit = null } = {}) {
    let sql = 'SELECT * FROM assets';
    const params = [];
    if (query) {
      sql += ' WHERE coin_id LIKE ? OR symbol LIKE ? OR name LIKE ?';
      const like = `%${String(query).toLowerCase()}%`;
      params.push(like, like, like);
    }
    sql += ' ORDER BY coin_id';
    if (limit !== null) { sql += ' LIMIT ?'; params.push(Math.max(1, Number(limit) || 50)); }
    return this.db.prepare(sql).all(...params).map(asPublicAsset);
  }

  listSnapshots({ coinId, currency, since, until, limit = null, order = 'recent' } = {}) {
    const where = [], params = [];
    if (coinId) { where.push('coin_id=?'); params.push(coinId); }
    if (currency) { where.push('currency=?'); params.push(currency); }
    if (since) { where.push('last_updated_at>=?'); params.push(since); }
    if (until) { where.push('last_updated_at<=?'); params.push(until); }
    let sql = 'SELECT * FROM snapshots' + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    sql += order === 'oldest' ? ' ORDER BY last_updated_at,id' : ' ORDER BY last_updated_at DESC,id DESC';
    if (limit !== null) { sql += ' LIMIT ?'; params.push(Math.max(1, Number(limit) || 50)); }
    return this.db.prepare(sql).all(...params).map(asPublicSnapshot);
  }

  latestSnapshot(coinId, currency = 'usd') {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE coin_id=? AND currency=? ORDER BY last_updated_at DESC,id DESC LIMIT 1').get(coinId, currency);
    return asPublicSnapshot(row);
  }

  latestSnapshots(currency = 'usd') {
    return this.db.prepare(`SELECT s.* FROM snapshots s
      JOIN (SELECT coin_id,currency,MAX(last_updated_at) AS latest FROM snapshots WHERE currency=? GROUP BY coin_id,currency) x
      ON x.coin_id=s.coin_id AND x.currency=s.currency AND x.latest=s.last_updated_at
      ORDER BY s.coin_id`).all(currency).map(asPublicSnapshot);
  }

  getApiCache(key) {
    const row = this.db.prepare('SELECT value,expires_at FROM api_cache WHERE key=?').get(key);
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
      this.db.prepare('DELETE FROM api_cache WHERE key=?').run(key);
      return null;
    }
    try { return JSON.parse(row.value); }
    catch (_) {
      this.db.prepare('DELETE FROM api_cache WHERE key=?').run(key);
      return null;
    }
  }

  setApiCache(key, value, ttlSeconds = 30) {
    const ttl = Math.max(0, Number(ttlSeconds) || 0);
    this.db.prepare(`INSERT INTO api_cache(key,value,expires_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at,updated_at=excluded.updated_at`
    ).run(key, JSON.stringify(value), Date.now() + Math.round(ttl * 1000), new Date().toISOString());
  }

  purgeExpired() {
    return this.db.prepare('DELETE FROM api_cache WHERE expires_at<=?').run(Date.now()).changes;
  }

  getCachedSynthesis(feature) {
    const row = this.db.prepare('SELECT * FROM synthesis_cache WHERE feature=?').get(feature);
    return row || null;
  }

  setCachedSynthesis(feature, content, wordCount) {
    this.db.prepare(`INSERT INTO synthesis_cache(feature,content,word_count,created_at) VALUES(?,?,?,?)
      ON CONFLICT(feature) DO UPDATE SET content=excluded.content,word_count=excluded.word_count,created_at=excluded.created_at`
    ).run(feature, content, Number(wordCount), new Date().toISOString());
  }

  invalidateSynthesis(feature) {
    if (feature) this.db.prepare('DELETE FROM synthesis_cache WHERE feature=? OR feature LIKE ?').run(feature, `${feature}:%`);
    else this.db.exec('DELETE FROM synthesis_cache');
  }

  stats() {
    return {
      assets: Number(this.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n),
      snapshots: Number(this.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n),
      apiCacheEntries: Number(this.db.prepare('SELECT COUNT(*) AS n FROM api_cache').get().n),
      synthesisEntries: Number(this.db.prepare('SELECT COUNT(*) AS n FROM synthesis_cache').get().n),
      dbPath: this.dbPath,
    };
  }

  close() {
    try { this.db.close(); } catch (_) { /* already closed */ }
  }
}

module.exports = { SQLiteCache };
