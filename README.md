# coingecko-mcp

CoinGecko market data and price feeds with a file-first store, a derived
SQLite cache, a deterministic market synthesizer, a CLI, and an MCP stdio
server. The CLI and MCP server share the same assets and snapshots.

## Properties

- Node.js 22.5 or newer; uses built-in `node:sqlite` and `fetch`
- Zero runtime dependencies and zero install scripts
- JSON and JSONL source files with a transactional SQLite index
- Current prices, market cap, volume, 24-hour change, and timestamp
- TTL price caching, refresh-on-demand, and bounded deterministic synthesis
- Eight MCP tools with JSON Schema validation and JSON-RPC 2.0 notifications
- No API key in URLs, logs, stored snapshots, or synthesized documents

## Install and verify

    npm install coingecko-mcp
    npm test

`npm test` runs the complete offline suite: file/store and SQLite tests,
engine and synthesis tests, and an end-to-end MCP stdio session. No network is
required by the test suite.

## CLI quick start

    coingecko-mcp init --root /path/to/project
    coingecko-mcp add asset bitcoin --symbol btc --name Bitcoin --root /path/to/project
    coingecko-mcp refresh --root /path/to/project
    coingecko-mcp list assets --json --root /path/to/project
    coingecko-mcp list snapshots --coin bitcoin --json --root /path/to/project
    coingecko-mcp synthesize portfolio --stdout --root /path/to/project

All commands accept `--root DIR`; it defaults to the current directory. The
store is initialized automatically on first use, while an explicit `init`
reports which paths were created.

### Add data manually

    coingecko-mcp add asset ethereum --symbol eth --name Ethereum
    coingecko-mcp add snapshot ethereum --price 3500.75 --currency usd \
      --market-cap 420000000000 --volume 15000000000 --change-24h -1.2 \
      --last-updated-at 2026-10-27T00:00:00Z --source manual

Snapshot writes also track the asset. Existing symbol/name metadata is
preserved unless explicitly replaced. Duplicate `(coin_id, currency,
last_updated_at)` values remain append-only in JSONL but are upserted in
SQLite.

### Get and refresh prices

    coingecko-mcp get-price bitcoin,ethereum --currencies usd,eur
    coingecko-mcp get-price bitcoin --persist
    coingecko-mcp get-price bitcoin --force-refresh
    coingecko-mcp refresh                 # all tracked assets
    coingecko-mcp refresh bitcoin         # one tracked asset

`get-price` uses a 30-second TTL by default. `--cache-ttl N` changes it and
`--force-refresh` bypasses it. Cached data can also be persisted with
`--persist`; it does not require a second network request. `refresh` always
fetches fresh data and writes snapshots.

### List and synthesize

    coingecko-mcp list assets --query bit
    coingecko-mcp list snapshots --coin bitcoin --currency usd --limit 100
    coingecko-mcp synthesize portfolio
    coingecko-mcp synthesize bitcoin --words 600 --stdout
    coingecko-mcp stats --json

Omitting `--limit` returns all matching snapshots. Synthesis is deterministic,
contains latest prices, absolute 24-hour movers, coverage and data-quality
notes, and never invents prices. Its output is hard-capped at the requested
word count. The default is 900 words; cached briefs are invalidated by data
writes. Without `--stdout`, the brief is written under
`.coingecko/synthesis/`.

## File layout

    .coingecko/
    ├── assets.json          # tracked asset source of truth
    ├── snapshots.jsonl      # append-only market history source of truth
    ├── synthesis/           # generated markdown briefs
    └── cache/
        └── market.db        # derived, rebuildable SQLite index and caches

The JSON/JSONL files are authoritative. SQLite is rebuilt from them on startup
and after writes. Corrupt JSON or JSONL is reported with its path and is never
silently overwritten. JSONL corruption includes the exact line number.

## MCP server

    coingecko-mcp mcp-start --root /path/to/project

The server speaks newline-delimited JSON-RPC 2.0 over stdio, supports MCP
2025-06-18 plus older negotiated versions, and reserves stdout for protocol
messages. Notifications receive no response. The 2025-06-18 version rejects
batch requests; older negotiated versions receive JSON-RPC batch arrays.

### Tools

| Tool | Purpose |
|---|---|
| `coingecko_ping` | Check CoinGecko API reachability |
| `coingecko_add_asset` | Add or update a tracked asset |
| `coingecko_add_snapshot` | Validate and persist a market snapshot |
| `coingecko_get_price` | Get current prices with TTL caching and optional persistence |
| `coingecko_refresh` | Fetch and persist prices for one or all tracked assets |
| `coingecko_list_assets` | List tracked assets with optional text and limit filters |
| `coingecko_list_snapshots` | Query history by coin, currency, time, order, and limit |
| `coingecko_synthesize` | Generate a bounded market brief from stored data |

All tools have closed JSON Schemas. Unknown properties, invalid enums,
out-of-range numbers, empty required arrays, and malformed initialize requests
are rejected with `-32602`. Domain failures such as an unknown asset or an API
error are returned as tool results with `isError: true`.

## Configuration

| Variable | Meaning |
|---|---|
| `COINGECKO_ROOT` | Project root containing `.coingecko` |
| `COINGECKO_BASE_URL` | API base URL; default `https://api.coingecko.com/api/v3` |
| `COINGECKO_API_KEY` | Optional CoinGecko API key, sent only in the appropriate header |
| `COINGECKO_PRO` | When true, use `x-cg-pro-api-key`; otherwise `x-cg-demo-api-key` |
| `COINGECKO_TIMEOUT_MS` | Request timeout in milliseconds; default 10000 |
| `COINGECKO_FIXTURE` | JSON fixture for deterministic offline API responses |

The fixture format is:

    {
      "ping": { "status": "ok" },
      "simplePrice": {
        "bitcoin": {
          "usd": 67000.25,
          "usd_market_cap": 1320000000000,
          "usd_24h_vol": 28000000000,
          "usd_24h_change": 2.45,
          "last_updated_at": 1793088000
        }
      }
    }

The included `test/fixture.json` covers three assets and USD/EUR prices. Live
API calls use a timeout, bounded retries for 429/5xx/network failures, and no
retry for permanent HTTP errors.

## Programmatic API

    const { CoinGeckoEngine } = require('coingecko-mcp/lib/engine');
    const engine = new CoinGeckoEngine({ rootDir: process.cwd() });
    engine.init();
    engine.addAsset({ coin_id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
    await engine.refresh({ coinId: 'bitcoin' });
    const latest = engine.latestSnapshot('bitcoin', 'usd');
    const brief = engine.synthesize({ feature: 'portfolio', write: false });
    engine.close();

Market data belongs to CoinGecko and is subject to its API terms and rate
limits. This package provides data retrieval and storage, not financial
advice or trading execution.
