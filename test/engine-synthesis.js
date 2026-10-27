'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CoinGeckoEngine } = require('../lib/engine');
const { CoinGeckoClient } = require('../lib/coingecko-client');

const FIXTURE = path.join(__dirname, 'fixture.json');
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message); }

test('ping uses the CoinGecko client contract', async (engine) => {
  engine.init();
  assert((await engine.ping()).status === 'ok', 'ping failed');
});

test('refresh persists every tracked asset', async (engine, root) => {
  engine.init();
  for (const coin of ['bitcoin', 'ethereum', 'solana']) engine.addAsset({ coin_id: coin });
  const result = await engine.refresh();
  assert(result.refreshed === 3, 'refresh count mismatch');
  assert(engine.stats().snapshots === 3, 'snapshots not persisted');
  const lines = fs.readFileSync(path.join(root, '.coingecko', 'snapshots.jsonl'), 'utf8').trim().split('\n');
  assert(lines.length === 3, 'file history count mismatch');
  assert(engine.latestSnapshot('solana').price === 155.5, 'latest price mismatch');
});

test('getPrice uses TTL, persist-on-cache, and force refresh', async (engine) => {
  engine.init();
  engine.addAsset({ coin_id: 'bitcoin' });
  let calls = 0;
  const original = engine.client.simplePrice.bind(engine.client);
  engine.client.simplePrice = async (...args) => { calls++; return original(...args); };
  const first = await engine.getPrice({ ids: ['bitcoin'] });
  const second = await engine.getPrice({ ids: ['bitcoin'] });
  assert(calls === 1 && !first.cached && second.cached, 'TTL cache was not used');
  const persisted = await engine.getPrice({ ids: ['bitcoin'], persist: true });
  assert(calls === 1 && persisted.cached && persisted.snapshots.length === 1, 'cached data was not persisted');
  await engine.getPrice({ ids: ['bitcoin'], forceRefresh: true });
  assert(calls === 2, 'force refresh did not bypass cache');
});

test('multiple currencies and missing assets are explicit', async (engine) => {
  engine.init();
  const result = await engine.getPrice({ ids: ['bitcoin'], currencies: ['usd', 'eur'], persist: true });
  assert(result.snapshots.length === 2, 'currency snapshots missing');
  assert(result.snapshots.some((row) => row.currency === 'eur'), 'EUR snapshot missing');
  const missing = await engine.getPrice({ ids: ['unknown-coin'], persist: true });
  assert(missing.missing.length === 1 && missing.snapshots.length === 0, 'missing asset not reported');
  engine.addAsset({ coin_id: 'unknown-coin' });
  let error;
  try { await engine.refresh({ coinId: 'unknown-coin' }); } catch (err) { error = err; }
  assert(error && error.code === 'ENODATA', 'empty refresh did not fail clearly');
});

test('synthesis is bounded, cached, invalidated, and written', async (engine) => {
  engine.init();
  for (const coin of ['bitcoin', 'ethereum', 'solana']) engine.addAsset({ coin_id: coin });
  await engine.refresh();
  const first = engine.synthesize({ write: false });
  assert(first.wordCount > 50 && first.wordCount <= 900, 'synthesis bound failed');
  assert(first.content.includes('solana') && first.content.includes('24h'), 'market content missing');
  const second = engine.synthesize({ write: false });
  assert(second.cached && second.content === first.content, 'synthesis cache not used');
  engine.addSnapshot({ coin_id: 'bitcoin', price: 68000, last_updated_at: '2026-10-28T00:00:00Z' });
  assert(!engine.synthesize({ write: false }).cached, 'synthesis cache not invalidated');
  const written = engine.synthesize();
  assert(fs.existsSync(written.filePath), 'synthesis file not written');
  let error;
  try { engine.synthesize({ feature: 'unknown', write: false }); } catch (err) { error = err; }
  assert(error && error.code === 'ENOTFOUND', 'unknown feature did not fail');
});

test('250 assets cannot bypass the synthesis cap', async (engine) => {
  engine.init();
  const snapshots = [];
  for (let i = 0; i < 250; i++) {
    const coinId = `coin-${i}`;
    engine.fileStore.upsertAsset({ coin_id: coinId, symbol: `c${i}`, name: `Coin ${i}` });
    snapshots.push({ coin_id: coinId, price: 100 + i, market_cap: 1000000 + i, total_volume: 50000 + i,
      price_change_percentage_24h: i, last_updated_at: new Date(1700000000000 + i * 1000).toISOString(), source: 'stress' });
  }
  engine.fileStore.appendSnapshots(snapshots);
  engine.sync();
  const brief = engine.synthesize({ write: false });
  assert(brief.wordCount <= 900 && brief.wordCount > 300, `bad stress word count ${brief.wordCount}`);
  assert(brief.omitted > 0 && brief.content.includes('Coin 249'), 'priority content or omitted count missing');
});

test('client retries transient responses and keeps API keys out of URLs', async () => {
  const calls = [];
  const client = new CoinGeckoClient({ apiKey: 'secret-key', retries: 1, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    if (calls.length === 1) return { ok: false, status: 429, headers: { get: () => '0' }, text: async () => 'rate limited' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ bitcoin: { usd: 1 } }) };
  } });
  const result = await client.simplePrice({ ids: ['bitcoin'] });
  assert(calls.length === 2 && result.bitcoin.usd === 1, 'transient retry failed');
  assert(calls[0].headers['x-cg-demo-api-key'] === 'secret-key', 'demo API header missing');
  assert(!calls[0].url.includes('secret-key'), 'API key leaked into URL');
});

test('client does not retry permanent API errors', async () => {
  let calls = 0;
  const client = new CoinGeckoClient({ retries: 3, fetchImpl: async () => {
    calls++;
    return { ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad request' };
  } });
  let error;
  try { await client.ping(); } catch (err) { error = err; }
  assert(error && error.code === 'EAPI' && calls === 1, 'permanent error was retried');
});

test('snapshot filters validate dates, currencies, and order', async (engine) => {
  engine.init();
  engine.addSnapshot({ coin_id: 'bitcoin', price: 100, currency: 'usd' });
  assert(engine.listSnapshots({ coinId: 'BITCOIN', currency: 'USD' }).length === 1, 'normalized filters failed');
  let error;
  try { engine.listSnapshots({ order: 'sideways' }); } catch (err) { error = err; }
  assert(error && error.code === 'EINVALID', 'invalid order was accepted');
  error = null;
  try { engine.listSnapshots({ since: 'not-a-date' }); } catch (err) { error = err; }
  assert(error && error.code === 'EINVALID', 'invalid date was accepted');
});

test('client rejects malformed simple-price responses', async () => {
  const client = new CoinGeckoClient({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }) });
  let error;
  try { await client.simplePrice({ ids: ['bitcoin'] }); } catch (err) { error = err; }
  assert(error && error.code === 'EAPI', 'malformed response shape was accepted');
});

test('CLI executes init, add, list, refresh, price, stats, and synthesis', async (engine, root) => {
  const cli = path.join(__dirname, '..', 'bin', 'cli.js');
  const env = { ...process.env, COINGECKO_FIXTURE: FIXTURE };
  const run = (args) => spawnSync(process.execPath, [cli, ...args, '--root', root], { env, encoding: 'utf8', timeout: 20000 });
  assert(run(['init']).status === 0, 'CLI init failed');
  assert(run(['add', 'asset', 'bitcoin', '--symbol', 'btc', '--name', 'Bitcoin']).status === 0, 'CLI add asset failed');
  assert(run(['add', 'snapshot', 'bitcoin', '--price', '100']).status === 0, 'CLI add snapshot failed');
  const assets = run(['list', 'assets', '--json']);
  assert(assets.status === 0 && JSON.parse(assets.stdout).length === 1, 'CLI list assets failed');
  const refreshed = run(['refresh']);
  assert(refreshed.status === 0 && JSON.parse(refreshed.stdout).refreshed === 1, `CLI refresh failed: ${refreshed.stderr}`);
  const priced = run(['get-price', 'bitcoin', '--persist']);
  assert(priced.status === 0 && JSON.parse(priced.stdout).snapshots.length === 1, `CLI get-price failed: ${priced.stderr}`);
  const stats = run(['stats']);
  assert(stats.status === 0 && JSON.parse(stats.stdout).snapshots >= 2, 'CLI stats failed');
  const synthesis = run(['synthesize', 'portfolio', '--stdout']);
  assert(synthesis.status === 0 && synthesis.stdout.includes('CoinGecko Portfolio Synthesis'), 'CLI synthesis failed');
});

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coingecko-engine-test-'));
    const engine = new CoinGeckoEngine({ rootDir: root, clientOptions: { fixturePath: FIXTURE } });
    try {
      await fn(engine, root);
      passed++;
      console.log(`PASS ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${name}: ${err && err.stack ? err.stack : err}`);
    } finally {
      engine.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`RESULT ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
