'use strict';

const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  SERVER_NOT_INITIALIZED: -32002,
});

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

const object = (properties = {}, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const string = { type: 'string' };
const limit = { type: 'integer', minimum: 1, maximum: 1000 };
const coinIds = { type: 'array', items: { type: 'string' }, minItems: 1 };
const currencies = { type: 'array', items: { type: 'string' }, minItems: 1 };

function buildTools() {
  return [
    { name: 'coingecko_ping', description: 'Check CoinGecko API reachability without changing the local store.', inputSchema: object() },
    {
      name: 'coingecko_add_asset', description: 'Add or update a tracked cryptocurrency asset in the shared file and SQLite stores.',
      inputSchema: object({ coin_id: string, symbol: string, name: string, platforms: { type: 'object' } }, ['coin_id']),
    },
    {
      name: 'coingecko_add_snapshot', description: 'Persist a validated market snapshot and track its asset.',
      inputSchema: object({
        coin_id: string, symbol: string, name: string, currency: string,
        price: { type: 'number', minimum: 0 },
        market_cap: { type: 'number', minimum: 0 },
        total_volume: { type: 'number', minimum: 0 },
        price_change_percentage_24h: { type: 'number' },
        last_updated_at: string, fetched_at: string, source: string,
      }, ['coin_id', 'price']),
    },
    {
      name: 'coingecko_get_price', description: 'Get current CoinGecko prices with a short TTL cache; optionally persist snapshots.',
      inputSchema: object({
        ids: coinIds, currencies, persist: { type: 'boolean' }, force_refresh: { type: 'boolean' },
        cache_ttl: { type: 'integer', minimum: 0, maximum: 3600 },
      }, ['ids']),
    },
    {
      name: 'coingecko_refresh', description: 'Fetch current prices for one or all tracked assets and persist the snapshots.',
      inputSchema: object({ coin_id: string, currency: string }),
    },
    {
      name: 'coingecko_list_assets', description: 'List tracked assets from the shared store, optionally filtered by text.',
      inputSchema: object({ query: string, limit }),
    },
    {
      name: 'coingecko_list_snapshots', description: 'List price history without a row cap, with optional coin, currency, time, and order filters.',
      inputSchema: object({ coin_id: string, currency: string, since: string, until: string, limit, order: { type: 'string', enum: ['recent', 'oldest'] } }),
    },
    {
      name: 'coingecko_synthesize', description: 'Generate a deterministic market brief capped at the requested word count from stored snapshots.',
      inputSchema: object({
        feature: string, currency: string,
        max_words: { type: 'integer', minimum: 100, maximum: 2000 },
        refresh: { type: 'boolean' }, write: { type: 'boolean' },
      }),
    },
  ];
}

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError };
}

function validateArguments(schema, args, tool) {
  const invalid = (message) => { throw new RpcError(ERROR_CODES.INVALID_PARAMS, `${tool}: ${message}`); };
  const properties = schema.properties || {};
  for (const key of schema.required || []) if (args[key] === undefined) invalid(`missing required "arguments.${key}".`);
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) if (!properties[key]) invalid(`"arguments.${key}" is not allowed.`);
  }
  const checkType = (value, spec, label) => {
    if (spec.type === 'string' && typeof value !== 'string') invalid(`"${label}" must be a string.`);
    if (spec.type === 'integer' && !Number.isInteger(value)) invalid(`"${label}" must be an integer.`);
    if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) invalid(`"${label}" must be finite.`);
    if (spec.type === 'boolean' && typeof value !== 'boolean') invalid(`"${label}" must be boolean.`);
    if (spec.type === 'array' && !Array.isArray(value)) invalid(`"${label}" must be an array.`);
    if (spec.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) invalid(`"${label}" must be an object.`);
  };
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (!spec) continue;
    checkType(value, spec, `arguments.${key}`);
    if (spec.enum && !spec.enum.includes(value)) invalid(`"arguments.${key}" has an unsupported value.`);
    if (typeof value === 'number') {
      if (spec.minimum !== undefined && value < spec.minimum) invalid(`"arguments.${key}" must be >= ${spec.minimum}.`);
      if (spec.maximum !== undefined && value > spec.maximum) invalid(`"arguments.${key}" must be <= ${spec.maximum}.`);
    }
    if (spec.type === 'array') {
      if (spec.minItems !== undefined && value.length < spec.minItems) invalid(`"arguments.${key}" must not be empty.`);
      if (spec.items) value.forEach((item, index) => checkType(item, spec.items, `arguments.${key}[${index}]`));
    }
  }
}

async function callTool(engine, name, args) {
  switch (name) {
    case 'coingecko_ping': return engine.ping();
    case 'coingecko_add_asset': return engine.addAsset(args);
    case 'coingecko_add_snapshot': return engine.addSnapshot(args);
    case 'coingecko_get_price':
      return engine.getPrice({
        ids: args.ids,
        currencies: args.currencies || ['usd'],
        persist: args.persist === true,
        forceRefresh: args.force_refresh === true,
        cacheTtl: args.cache_ttl === undefined ? 30 : args.cache_ttl,
      });
    case 'coingecko_refresh': return engine.refresh({ coinId: args.coin_id, currency: args.currency || 'usd' });
    case 'coingecko_list_assets': return engine.listAssets({ query: args.query, limit: args.limit ?? null });
    case 'coingecko_list_snapshots':
      return engine.listSnapshots({
        coinId: args.coin_id, currency: args.currency, since: args.since, until: args.until,
        limit: args.limit ?? null, order: args.order || 'recent',
      });
    case 'coingecko_synthesize': {
      const brief = engine.synthesize({
        feature: args.feature || 'portfolio', currency: args.currency || 'usd',
        maxWords: args.max_words || 900, refresh: args.refresh === true, write: args.write === true,
      });
      return `${brief.content}\n---\n${JSON.stringify({ feature: brief.feature, currency: brief.currency, words: brief.wordCount, cached: brief.cached, omitted: brief.omitted || 0, filePath: brief.filePath || null })}`;
    }
    default: throw new RpcError(ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${name}`);
  }
}

function createMcpHandler({ engine, serverInfo, protocolVersion = '2025-06-18', supportedVersions }) {
  let initialized = false;
  const tools = buildTools();
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  return {
    tools,
    async handleMessage(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return fail(null, ERROR_CODES.INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object.');
      }
      const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
      const { id, method } = message;
      if (message.jsonrpc !== '2.0') return hasId ? fail(id, ERROR_CODES.INVALID_REQUEST, '"jsonrpc" must be "2.0".') : null;
      if (hasId && id !== null && typeof id !== 'string' && typeof id !== 'number') {
        return fail(null, ERROR_CODES.INVALID_REQUEST, 'Invalid Request: id must be a string, number, or null.');
      }
      if (typeof method !== 'string' || !method) return hasId ? fail(id, ERROR_CODES.INVALID_REQUEST, 'method must be a non-empty string.') : null;
      const isNotification = !hasId;
      if (!initialized && method !== 'initialize') {
        return isNotification ? null : fail(id, ERROR_CODES.SERVER_NOT_INITIALIZED, 'Server not initialized: send initialize first.');
      }

      switch (method) {
        case 'initialize': {
          if (isNotification) return null;
          const params = message.params;
          if (!params || typeof params !== 'object' || Array.isArray(params)) return fail(id, ERROR_CODES.INVALID_PARAMS, 'initialize params must be an object.');
          if (typeof params.protocolVersion !== 'string' || !params.protocolVersion.trim()) return fail(id, ERROR_CODES.INVALID_PARAMS, 'params.protocolVersion is required.');
          if (!params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)) return fail(id, ERROR_CODES.INVALID_PARAMS, 'params.capabilities must be an object.');
          if (!params.clientInfo || typeof params.clientInfo !== 'object' || Array.isArray(params.clientInfo)
              || typeof params.clientInfo.name !== 'string' || !params.clientInfo.name.trim()
              || typeof params.clientInfo.version !== 'string' || !params.clientInfo.version.trim()) {
            return fail(id, ERROR_CODES.INVALID_PARAMS, 'params.clientInfo must include non-empty name and version.');
          }
          const negotiated = supportedVersions && supportedVersions.has(params.protocolVersion) ? params.protocolVersion : protocolVersion;
          initialized = true;
          return ok(id, {
            protocolVersion: negotiated,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            instructions: 'Use coingecko_add_asset and coingecko_refresh to build local market history, coingecko_get_price for cached live prices, and coingecko_synthesize for bounded market briefs.',
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return isNotification ? null : ok(id, {});
        case 'tools/list':
          return isNotification ? null : ok(id, { tools });
        case 'tools/call': {
          if (isNotification) return null;
          const params = message.params;
          if (!params || typeof params !== 'object' || Array.isArray(params)) return fail(id, ERROR_CODES.INVALID_PARAMS, 'tools/call params must be an object.');
          if (typeof params.name !== 'string' || !params.name) return fail(id, ERROR_CODES.INVALID_PARAMS, 'params.name is required.');
          const tool = tools.find((item) => item.name === params.name);
          if (!tool) return fail(id, ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${params.name}`);
          const args = params.arguments === undefined ? {} : params.arguments;
          if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(id, ERROR_CODES.INVALID_PARAMS, 'arguments must be an object.');
          try {
            validateArguments(tool.inputSchema, args, params.name);
            const result = await callTool(engine, params.name, args);
            return ok(id, textResult(result));
          } catch (err) {
            if (err instanceof RpcError) return fail(id, err.code, err.message);
            if (err && err.domain) return ok(id, textResult(`${err.message}${err.details ? `\n${JSON.stringify(err.details)}` : ''}`, true));
            throw err;
          }
        }
        default:
          return isNotification ? null : fail(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    },
  };
}

module.exports = { createMcpHandler, buildTools, validateArguments, ERROR_CODES, RpcError };
