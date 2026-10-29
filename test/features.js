'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoinGeckoEngine } = require('../lib/engine');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (err) { results.push({ name, ok: false, err }); console.log(`FAIL ${name}: ${err.message}`); }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coingecko-features-'));
  const fixturePath = path.join(__dirname, 'fixture.json');
  const engine = new CoinGeckoEngine({ rootDir: root, clientOptions: { fixturePath } });
  engine.init();

  await check('addSnapshot returns the exact inserted snapshot even for backfill', () => {
    const row = engine.addSnapshot({
      coin_id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', currency: 'usd',
      price: 50000, last_updated_at: '2026-10-27T00:00:00Z', source: 'manual',
    });
    assert.strictEqual(row.price, 50000);
    assert.strictEqual(row.last_updated_at, '2026-10-27T00:00:00.000Z');
    const row2 = engine.addSnapshot({
      coin_id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', currency: 'usd',
      price: 67000.25, last_updated_at: '2026-10-28T00:00:00Z', source: 'manual',
    });
    assert.strictEqual(row2.price, 67000.25);
    assert.strictEqual(row2.last_updated_at, '2026-10-28T00:00:00.000Z');
  });

  await check('asset amount is stored and returned', () => {
    const asset = engine.addAsset({ coin_id: 'ethereum', symbol: 'eth', name: 'Ethereum', amount: 2.5 });
    assert.strictEqual(asset.amount, 2.5);
  });

  await check('portfolio values holdings with amounts', () => {
    engine.addSnapshot({ coin_id: 'ethereum', currency: 'usd', price: 3500, source: 'manual' });
    const result = engine.portfolio({ currency: 'usd' });
    const eth = result.positions.find((p) => p.coin_id === 'ethereum');
    assert.ok(eth, 'ethereum position exists');
    assert.strictEqual(eth.amount, 2.5);
    assert.ok(Math.abs(eth.value - 8750) < 1e-9, `expected value 8750 got ${eth.value}`);
    assert.ok(result.totals.value > 0);
  });

  await check('portfolio reports unpriced holdings with null value', () => {
    engine.addAsset({ coin_id: 'dogecoin', symbol: 'doge', name: 'Dogecoin', amount: 100 });
    const result = engine.portfolio();
    const doge = result.positions.find((p) => p.coin_id === 'dogecoin');
    assert.strictEqual(doge.value, null);
    assert.strictEqual(doge.price, null);
  });

  await check('marketChart returns priced time series from fixture', async () => {
    const result = await engine.marketChart({ coinId: 'bitcoin', currency: 'usd', days: 1 });
    assert.strictEqual(result.coin_id, 'bitcoin');
    assert.ok(result.prices.length >= 2);
    assert.ok(result.prices[0].timestamp && typeof result.prices[0].price === 'number');
    assert.ok(result.volumes.length >= 2);
  });

  await check('addMarkets tracks and persists market rows', async () => {
    const result = await engine.addMarkets({ currency: 'usd', perPage: 2, page: 1, persist: true });
    assert.strictEqual(result.tracked, 2);
    assert.strictEqual(result.persisted, 2);
    assert.ok(result.assets.includes('bitcoin'));
  });

  await check('alert triggers above and below thresholds', () => {
    const above = engine.alert({ above: 60000, currency: 'usd' });
    assert.ok(above.triggered >= 1, 'above 60000 should trigger bitcoin');
    const below = engine.alert({ below: 100, currency: 'usd' });
    assert.strictEqual(below.triggered, 0, 'below 100 should not trigger');
    const both = engine.alert({ above: 60000, below: 100, currency: 'usd' });
    assert.ok(both.triggered >= 1);
  });

  await check('alert rejects missing thresholds', () => {
    assert.throws(() => engine.alert({}), /at least one of above or below/);
  });

  await check('export snapshots as jsonl and csv', () => {
    const jsonl = engine.exportSnapshots({ format: 'jsonl' });
    assert.strictEqual(jsonl.format, 'jsonl');
    assert.ok(jsonl.content.split('\n').filter(Boolean).length >= 3);
    const csv = engine.exportSnapshots({ format: 'csv' });
    assert.strictEqual(csv.format, 'csv');
    const lines = csv.content.trim().split('\n');
    assert.ok(lines[0].startsWith('coin_id,symbol'));
    assert.ok(lines.length >= 4);
  });

  await check('import snapshots round-trips through jsonl', () => {
    const before = engine.listSnapshots({ limit: null }).length;
    const payload = JSON.stringify({ coin_id: 'litecoin', symbol: 'ltc', name: 'Litecoin', currency: 'usd', price: 80, source: 'import' }) + '\n';
    const result = engine.importSnapshots({ payload, format: 'jsonl' });
    assert.strictEqual(result.imported, 1);
    assert.strictEqual(result.skipped, 0);
    const after = engine.listSnapshots({ limit: null }).length;
    assert.strictEqual(after, before + 1);
  });

  await check('import snapshots skips invalid rows and reports them', () => {
    const payload = [
      JSON.stringify({ coin_id: 'cardano', currency: 'usd', price: 0.5, source: 'import' }),
      JSON.stringify({ coin_id: 'bad id!', currency: 'usd', price: 1 }),
    ].join('\n') + '\n';
    const result = engine.importSnapshots({ payload, format: 'jsonl' });
    assert.strictEqual(result.imported, 1);
    assert.strictEqual(result.skipped, 1);
    assert.strictEqual(result.errors.length, 1);
  });

  await check('import rejects empty payload', () => {
    assert.throws(() => engine.importSnapshots({ payload: '  ' }), /non-empty/);
  });

  await check('import rejects unknown format', () => {
    assert.throws(() => engine.importSnapshots({ payload: 'x', format: 'xml' }), /format must be/);
  });

  await check('getPrice deduplicates ids and currencies', async () => {
    const result = await engine.getPrice({ ids: ['bitcoin', 'bitcoin', 'ethereum'], currencies: ['usd', 'usd'], forceRefresh: true, persist: true });
    assert.ok(result.snapshots.length >= 2);
    const bitcoinRows = result.snapshots.filter((s) => s.coin_id === 'bitcoin');
    assert.strictEqual(bitcoinRows.length, 1);
  });

  await check('getPrice cached results carry no stale row ids', async () => {
    await engine.getPrice({ ids: ['solana'], currencies: ['usd'], persist: true, forceRefresh: true });
    const cached = await engine.getPrice({ ids: ['solana'], currencies: ['usd'], persist: true, cacheTtl: 300 });
    if (cached.cached && Array.isArray(cached.snapshots)) {
      for (const snap of cached.snapshots) {
        assert.strictEqual(snap.id, null, 'cached snapshots must not carry row ids');
      }
    }
  });

  await check('listSnapshots supports since and until filters', () => {
    const rows = engine.listSnapshots({ coinId: 'bitcoin', since: '2026-10-28T00:00:00Z', until: '2026-10-28T23:59:59Z' });
    assert.ok(rows.length >= 1);
    for (const row of rows) assert.ok(row.last_updated_at >= '2026-10-28');
  });

  await check('listSnapshots rejects invalid order', () => {
    assert.throws(() => engine.listSnapshots({ order: 'sideways' }), /order must be/);
  });

  await check('finiteNumber rejects whitespace-only strings', () => {
    const { finiteNumber } = require('../lib/validation');
    assert.throws(() => finiteNumber(' ', 'price'), /finite number/);
    assert.strictEqual(finiteNumber(' ', 'price', { required: false }), null);
  });

  await check('isoDate rejects non-ISO loose dates', () => {
    const { isoDate } = require('../lib/validation');
    assert.throws(() => isoDate('October 27, 2026', 'date'), /ISO-8601/);
    assert.strictEqual(isoDate('2026-10-27T00:00:00Z', 'date'), '2026-10-27T00:00:00.000Z');
  });

  await check('synthesis sorts null change below real values', () => {
    engine.addAsset({ coin_id: 'tether', symbol: 'usdt', name: 'Tether' });
    engine.addSnapshot({ coin_id: 'tether', currency: 'usd', price: 1.0, price_change_percentage_24h: null, source: 'manual' });
    const brief = engine.synthesize({ feature: 'portfolio', currency: 'usd', write: false, refresh: true });
    const tetherIdx = brief.content.indexOf('Tether');
    const bitcoinIdx = brief.content.indexOf('Bitcoin');
    assert.ok(tetherIdx > bitcoinIdx, 'null-change entry must sort after real change entries');
  });

  engine.close();
  fs.rmSync(root, { recursive: true, force: true });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`RESULT ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
