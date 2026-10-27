'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CoinGeckoEngine } = require('../lib/engine');
const { normalizeSnapshot } = require('../lib/file-store');

let passed = 0, failed = 0;
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coingecko-store-test-'));
  let engine;
  try {
    engine = new CoinGeckoEngine({ rootDir: root, clientOptions: { fixturePath: path.join(__dirname, 'fixture.json') } });
    fn(engine, root);
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}: ${err && err.stack ? err.stack : err}`);
  } finally {
    if (engine) engine.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

test('init creates the file layout and is idempotent', (engine, root) => {
  const first = engine.init();
  assert(first.created.length >= 3, 'expected created files');
  assert(fs.existsSync(path.join(root, '.coingecko', 'assets.json')), 'assets.json missing');
  assert(fs.existsSync(path.join(root, '.coingecko', 'snapshots.jsonl')), 'snapshots.jsonl missing');
  assert(engine.init().created.length === 0, 'second init should create nothing');
});

test('asset add, update, and metadata preservation', (engine) => {
  engine.init();
  engine.addAsset({ coin_id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
  const updated = engine.addAsset({ coin_id: 'bitcoin', name: 'Bitcoin Network' });
  assert(updated.symbol === 'btc', 'symbol was overwritten');
  assert(updated.name === 'Bitcoin Network', 'name not updated');
  assert(engine.listAssets()[0].coin_id === 'bitcoin', 'asset not listed');
});

test('snapshot validation and unique database upsert', (engine, root) => {
  engine.init();
  const input = { coin_id: 'bitcoin', currency: 'usd', price: 67000.5, last_updated_at: '2026-10-27T00:00:00Z', source: 'test' };
  engine.addSnapshot(input);
  engine.addSnapshot(input);
  assert(engine.stats().snapshots === 1, 'duplicate database rows detected');
  const lines = fs.readFileSync(path.join(root, '.coingecko', 'snapshots.jsonl'), 'utf8').trim().split('\n');
  assert(lines.length === 2, 'append-only file history was not preserved');
  assert(engine.listSnapshots({ coinId: 'bitcoin' })[0].price === 67000.5, 'price mismatch');
});

test('invalid snapshots leave files unchanged', (engine, root) => {
  engine.init();
  const file = path.join(root, '.coingecko', 'snapshots.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  let error;
  try { engine.addSnapshot({ coin_id: 'bitcoin', price: -1 }); } catch (err) { error = err; }
  assert(error && error.domain, 'negative price was accepted');
  assert(fs.readFileSync(file, 'utf8') === before, 'invalid snapshot changed the file');
});

test('batch append validates every row before writing', (engine, root) => {
  engine.init();
  const file = path.join(root, '.coingecko', 'snapshots.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  let error;
  try {
    engine.fileStore.appendSnapshots([
      { coin_id: 'bitcoin', price: 100 },
      { coin_id: 'ethereum', price: 'not-a-number' },
    ]);
  } catch (err) { error = err; }
  assert(error && error.domain, 'invalid batch was accepted');
  assert(fs.readFileSync(file, 'utf8') === before, 'partial batch was written');
});

test('corrupt assets are reported without overwriting', (engine, root) => {
  engine.init();
  const file = path.join(root, '.coingecko', 'assets.json');
  fs.writeFileSync(file, '{broken sentinel');
  let error;
  try { engine.addAsset({ coin_id: 'ethereum', price: 1 }); } catch (err) { error = err; }
  assert(error && error.code === 'ECORRUPT', 'corrupt assets were not reported');
  assert(fs.readFileSync(file, 'utf8') === '{broken sentinel', 'corrupt original was overwritten');
});

test('corrupt JSONL reports the exact line', (engine, root) => {
  engine.init();
  const file = path.join(root, '.coingecko', 'snapshots.jsonl');
  fs.writeFileSync(file, '{"coin_id":"bitcoin","price":1}\nnot-json\n');
  let error;
  try { engine.fileStore.readSnapshots(); } catch (err) { error = err; }
  assert(error && error.code === 'ECORRUPT' && error.message.includes(':2'), 'missing JSONL line number');
});

test('API cache honors TTL and deletes malformed values', (engine) => {
  engine.init();
  engine.cache.setApiCache('key', { price: 1 }, 60);
  assert(engine.cache.getApiCache('key').price === 1, 'valid API cache missed');
  engine.cache.setApiCache('expired', { price: 2 }, 0);
  assert(engine.cache.getApiCache('expired') === null, 'expired cache was returned');
  engine.cache.db.prepare('INSERT INTO api_cache(key,value,expires_at,updated_at) VALUES(?,?,?,?)').run('bad', '{bad', Date.now() + 60000, new Date().toISOString());
  assert(engine.cache.getApiCache('bad') === null, 'malformed cache was returned');
});

test('snapshot writes invalidate synthesis cache', (engine) => {
  engine.init();
  engine.cache.setCachedSynthesis('bitcoin:usd:900', 'cached', 1);
  engine.cache.upsertSnapshot(normalizeSnapshot({ coin_id: 'bitcoin', price: 100 }));
  assert(engine.cache.getCachedSynthesis('bitcoin:usd:900') === null, 'coin cache not invalidated');
  engine.cache.setCachedSynthesis('portfolio:usd:900', 'cached', 1);
  engine.cache.upsertSnapshot(normalizeSnapshot({ coin_id: 'bitcoin', price: 101 }));
  assert(engine.cache.getCachedSynthesis('portfolio:usd:900') === null, 'portfolio cache not invalidated');
});

test('duplicate asset ids are rejected before database sync', (engine, root) => {
  engine.init();
  const file = path.join(root, '.coingecko', 'assets.json');
  const text = JSON.stringify({ version: 1, assets: [{ coin_id: 'bitcoin' }, { coin_id: 'bitcoin' }] });
  fs.writeFileSync(file, text);
  let error;
  try { engine.fileStore.readAssets(); } catch (err) { error = err; }
  assert(error && error.code === 'ECORRUPT' && error.message.includes('duplicate coin_id'), 'duplicate assets were not rejected');
  assert(fs.readFileSync(file, 'utf8') === text, 'duplicate source file was modified');
});

test('more than 500 snapshots are fully queryable', (engine) => {
  engine.init();
  const rows = [];
  for (let i = 0; i < 501; i++) {
    rows.push({ coin_id: 'bitcoin', price: 100 + i, last_updated_at: new Date(1700000000000 + i * 1000).toISOString() });
  }
  engine.fileStore.appendSnapshots(rows);
  engine.sync();
  assert(engine.listSnapshots().length === 501, 'history was capped');
  assert(engine.listSnapshots({ limit: 100 }).length === 100, 'explicit limit not honored');
  assert(engine.latestSnapshot('bitcoin').price === 600, 'latest snapshot incorrect');
});

console.log(`RESULT ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
