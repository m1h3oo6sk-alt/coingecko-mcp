#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { CoinGeckoEngine } = require('../lib/engine');
const { startMcpServer } = require('../mcp-server');

const USAGE = `coingecko-mcp — CoinGecko market data and price feeds

Usage:
  coingecko-mcp init [--root DIR]
  coingecko-mcp add asset <coin_id> [--symbol S] [--name N] [--amount N] [--platforms JSON]
  coingecko-mcp add snapshot <coin_id> --price N [options]
  coingecko-mcp list assets [--query Q] [--limit N] [--json]
  coingecko-mcp list snapshots [--coin ID] [--currency usd] [--since ISO] [--until ISO] [--order recent|oldest] [--limit N] [--json]
  coingecko-mcp get-price <id1,id2> [--currencies usd,eur] [--persist] [--force-refresh]
  coingecko-mcp refresh [coin_id] [--currency usd]
  coingecko-mcp synthesize [feature|portfolio] [--currency usd] [--words N] [--stdout]
  coingecko-mcp portfolio [--currency usd] [--json]
  coingecko-mcp market-chart <coin_id> [--currency usd] [--days N] [--json]
  coingecko-mcp markets [--currency usd] [--per-page N] [--page N] [--no-persist] [--json]
  coingecko-mcp alert [--above N] [--below N] [--currency usd] [--json]
  coingecko-mcp export snapshots [--format jsonl|csv] [--out FILE]
  coingecko-mcp import snapshots <file> [--format jsonl|csv]
  coingecko-mcp stats [--json]
  coingecko-mcp mcp-start

Snapshot options:
  --symbol S --name N --currency usd --market-cap N --volume N --change-24h N
  --last-updated-at ISO --fetched-at ISO --source NAME

Global options:
  --root DIR       Project root containing .coingecko (default: current directory)
  --json          Machine-readable output
  --limit N       Result limit; omit for all rows
  --order         Snapshot order: recent (default) or oldest
  --since ISO     Snapshot lower time bound (inclusive)
  --until ISO     Snapshot upper time bound (inclusive)
  --words N       Synthesis word cap (default 900, minimum 100)
  --refresh       Bypass a cached synthesis
  --cache-ttl N   Price cache TTL in seconds (default 30)
  --help          Show this usage
  --version       Print the package version

Error codes:
  EINVALID  input validation failed
  EAPI      CoinGecko API transport or response failure
  ETIMEOUT  request timed out
  ENOTFOUND tracked asset or resource missing
  ENOTINIT  local store not initialized
  ECORRUPT  local data file failed to parse
  ENODATA   request returned no usable rows
  EFIXTURE  offline fixture is incomplete
  EFETCH    no fetch implementation available
  EIO       local file read/write failure
`;
const VALUE_FLAGS = new Set(['root', 'symbol', 'name', 'amount', 'platforms', 'price', 'currency', 'market-cap', 'volume', 'change-24h', 'last-updated-at', 'fetched-at', 'source', 'query', 'limit', 'coin', 'currencies', 'cache-ttl', 'words', 'order', 'since', 'until', 'days', 'per-page', 'page', 'above', 'below', 'format', 'out']);
const BOOL_FLAGS = new Set(['json', 'persist', 'force-refresh', 'stdout', 'refresh', 'help', 'version', 'no-persist']);

function parse(argv) {
  const positional = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    let key = arg.slice(2), value;
    const eq = key.indexOf('=');
    if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    if (BOOL_FLAGS.has(key)) { opts[key] = value === undefined ? true : value === 'true'; continue; }
    if (!VALUE_FLAGS.has(key)) throw new Error(`unknown option --${key}`);
    if (value === undefined) {
      if (i + 1 >= argv.length) throw new Error(`--${key} requires a value`);
      value = argv[++i];
    }
    opts[key] = value;
  }
  return { positional, opts };
}

function withEngine(opts, action) {
  const engine = new CoinGeckoEngine({ rootDir: opts.root || process.cwd() });
  let result;
  try { result = action(engine); }
  catch (err) { engine.close(); throw err; }
  if (result && typeof result.then === 'function') return result.finally(() => engine.close());
  engine.close();
  return result;
}

function print(value, opts) {
  if (opts.json || typeof value !== 'string') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value}\n`);
}

function parsePlatforms(opts) {
  if (!opts.platforms) return undefined;
  try {
    const value = JSON.parse(opts.platforms);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch (err) { throw new Error(`--platforms must be a JSON object: ${err.message}`); }
}

function snapshotOptions(opts) {
  return {
    symbol: opts.symbol, name: opts.name, currency: opts.currency,
    price: opts.price, market_cap: opts['market-cap'], total_volume: opts.volume,
    price_change_percentage_24h: opts['change-24h'],
    last_updated_at: opts['last-updated-at'], fetched_at: opts['fetched-at'], source: opts.source,
    amount: opts.amount,
  };
}

function run(argv) {
  const { positional, opts } = parse(argv);
  const command = (positional[0] || '').toLowerCase();
  const rest = positional.slice(1);
  if (opts.version || command === 'version') { print(require('../package.json').version, { json: false }); return 0; }
  if (opts.help || !command || command === 'help') { process.stdout.write(USAGE); return 0; }

  switch (command) {
    case 'init':
      return withEngine(opts, (engine) => {
        const result = engine.init();
        print({ rootDir: result.rootDir, created: result.created, stats: result.stats }, opts);
        return 0;
      });
    case 'add': {
      const type = rest[0];
      if (type === 'asset') {
        if (!rest[1]) throw new Error('add asset requires a coin id');
        return withEngine(opts, (engine) => {
          const result = engine.addAsset({ coin_id: rest[1], symbol: opts.symbol, name: opts.name, amount: opts.amount, platforms: parsePlatforms(opts) });
          print(result, opts); return 0;
        });
      }
      if (type === 'snapshot') {
        if (!rest[1]) throw new Error('add snapshot requires a coin id');
        if (opts.price === undefined) throw new Error('add snapshot requires --price');
        return withEngine(opts, (engine) => {
          const result = engine.addSnapshot({ coin_id: rest[1], ...snapshotOptions(opts) });
          print(result, opts); return 0;
        });
      }
      throw new Error('add expects "asset" or "snapshot"');
    }
    case 'list': {
      const type = rest[0] || 'assets';
      if (type === 'assets') return withEngine(opts, (engine) => {
        const rows = engine.listAssets({ query: opts.query, limit: opts.limit === undefined ? null : Number(opts.limit) });
        print(rows, opts); return 0;
      });
      if (type === 'snapshots') return withEngine(opts, (engine) => {
        const rows = engine.listSnapshots({
          coinId: opts.coin, currency: opts.currency, since: opts.since, until: opts.until,
          limit: opts.limit === undefined ? null : Number(opts.limit), order: opts.order,
        });
        print(rows, opts); return 0;
      });
      throw new Error('list expects "assets" or "snapshots"');
    }
    case 'get-price': {
      if (!rest[0]) throw new Error('get-price requires comma-separated coin ids');
      const ids = rest[0].split(',').filter(Boolean);
      const currencies = (opts.currencies || 'usd').split(',').filter(Boolean);
      return withEngine(opts, async (engine) => {
        const result = await engine.getPrice({
          ids, currencies, persist: opts.persist === true,
          forceRefresh: opts['force-refresh'] === true,
          cacheTtl: opts['cache-ttl'] === undefined ? 30 : Number(opts['cache-ttl']),
        });
        print(result, opts); return 0;
      });
    }
    case 'refresh':
      return withEngine(opts, async (engine) => {
        const result = await engine.refresh({ coinId: rest[0], currency: opts.currency || 'usd' });
        print(result, opts); return 0;
      });
    case 'synthesize':
      return withEngine(opts, (engine) => {
        const brief = engine.synthesize({
          feature: rest[0] || 'portfolio', currency: opts.currency || 'usd',
          maxWords: opts.words === undefined ? 900 : Number(opts.words),
          refresh: opts.refresh === true, write: opts.stdout !== true,
        });
        if (opts.stdout) process.stdout.write(brief.content);
        else print({ feature: brief.feature, wordCount: brief.wordCount, cached: brief.cached, filePath: brief.filePath }, opts);
        return 0;
      });
    case 'portfolio':
      return withEngine(opts, (engine) => {
        print(engine.portfolio({ currency: opts.currency || 'usd' }), opts); return 0;
      });
    case 'market-chart':
      return withEngine(opts, async (engine) => {
        if (!rest[0]) throw new Error('market-chart requires a coin id');
        const result = await engine.marketChart({
          coinId: rest[0], currency: opts.currency || 'usd',
          days: opts.days === undefined ? 1 : Number(opts.days),
        });
        print(result, opts); return 0;
      });
    case 'markets':
      return withEngine(opts, async (engine) => {
        const result = await engine.addMarkets({
          currency: opts.currency || 'usd',
          perPage: opts['per-page'] === undefined ? 10 : Number(opts['per-page']),
          page: opts.page === undefined ? 1 : Number(opts.page),
          persist: opts['no-persist'] !== true,
        });
        print(result, opts); return 0;
      });
    case 'alert':
      return withEngine(opts, (engine) => {
        const result = engine.alert({
          above: opts.above === undefined ? null : Number(opts.above),
          below: opts.below === undefined ? null : Number(opts.below),
          currency: opts.currency || 'usd',
        });
        print(result, opts); return 0;
      });
    case 'export': {
      const type = rest[0] || 'snapshots';
      if (type !== 'snapshots') throw new Error('export expects "snapshots"');
      return withEngine(opts, (engine) => {
        const result = engine.exportSnapshots({ format: opts.format || 'jsonl' });
        if (opts.out) {
          fs.writeFileSync(opts.out, result.content, 'utf8');
          print({ format: result.format, file: opts.out, bytes: result.content.length }, opts);
        } else {
          process.stdout.write(result.content);
        }
        return 0;
      });
    }
    case 'import': {
      const type = rest[0];
      if (type !== 'snapshots') throw new Error('import expects "snapshots"');
      if (!rest[1]) throw new Error('import snapshots requires a file path');
      return withEngine(opts, (engine) => {
        const payload = fs.readFileSync(rest[1], 'utf8');
        const result = engine.importSnapshots({ payload, format: opts.format || 'jsonl' });
        print(result, opts); return 0;
      });
    }
    case 'stats':
      return withEngine(opts, (engine) => { print(engine.stats(), opts); return 0; });
    case 'mcp-start':
      startMcpServer({ engineOptions: { rootDir: opts.root || process.cwd() } });
      return null;
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

function fail(err) {
  const domain = err && err.domain;
  process.stderr.write(`error: ${err && err.message ? err.message : String(err)}\n${domain ? '' : `\n${USAGE}`}`);
  process.exitCode = domain ? 1 : 2;
}

try {
  const result = run(process.argv.slice(2));
  if (result && typeof result.then === 'function') {
    result.then((code) => { if (code !== null && code !== undefined) process.exitCode = code; }).catch(fail);
  } else if (result !== null && result !== undefined) process.exitCode = result;
} catch (err) {
  fail(err);
}
