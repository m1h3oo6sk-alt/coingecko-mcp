'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixture.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 0;
const id = () => ++nextId;

function startServer(root, viaCli = false) {
  const child = spawn(process.execPath, viaCli ? ['bin/cli.js', 'mcp-start', '--root', root] : ['mcp-server.js'], {
    cwd: ROOT,
    env: { ...process.env, COINGECKO_ROOT: root, COINGECKO_FIXTURE: FIXTURE },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try { responses.push(JSON.parse(line)); }
        catch (_) { responses.push({ parseError: line }); }
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const sendRaw = (text) => child.stdin.write(`${text}\n`);
  const waitFor = (predicate, timeout = 10000) => new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = responses.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeout) return reject(new Error('MCP response timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
  return { child, responses, send, sendRaw, waitFor, stop: () => child.stdin.end() };
}

async function main() {
  const checks = [];
  const expect = (name, condition, detail) => {
    checks.push({ name, ok: !!condition });
    if (!condition) process.stderr.write(`FAIL ${name}${detail ? `: ${detail}` : ''}\n`);
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coingecko-mcp-test-'));
  const s = startServer(root);
  const call = async (name, args = {}) => {
    const requestId = id();
    s.send({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } });
    return s.waitFor((message) => message.id === requestId);
  };
  const text = (response) => response.result && response.result.content && response.result.content[0].text || '';
  const parsed = (response) => { try { return JSON.parse(text(response)); } catch (_) { return null; } };

  const initializeId = id();
  s.send({ jsonrpc: '2.0', id: initializeId, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' },
  } });
  const initialized = await s.waitFor((message) => message.id === initializeId);
  expect('initialize protocol and serverInfo', initialized.result && initialized.result.protocolVersion === '2025-06-18'
    && initialized.result.serverInfo.name === 'coingecko-mcp');
  const notifyStart = s.responses.length;
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  s.send({ jsonrpc: '2.0', method: 'ping' });
  s.send({ jsonrpc: '2.0', method: 'tools/list' });
  await sleep(200);
  expect('notifications receive no responses', s.responses.length === notifyStart);

  const pingId = id();
  s.send({ jsonrpc: '2.0', id: pingId, method: 'ping' });
  const ping = await s.waitFor((message) => message.id === pingId);
  expect('ping returns an empty result', ping.result && Object.keys(ping.result).length === 0);
  const listId = id();
  s.send({ jsonrpc: '2.0', id: listId, method: 'tools/list' });
  const toolList = await s.waitFor((message) => message.id === listId);
  const tools = toolList.result.tools;
  expect('exactly eight tools are exposed', tools.length === 8, tools.map((tool) => tool.name).join(','));
  expect('tool schemas include required input objects', tools.every((tool) => tool.description && tool.inputSchema && tool.inputSchema.type === 'object'));

  let response = await call('coingecko_ping');
  expect('CoinGecko ping tool works', parsed(response) && parsed(response).status === 'ok', text(response));
  response = await call('coingecko_add_asset', { coin_id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' });
  expect('add_asset stores bitcoin', parsed(response) && parsed(response).coin_id === 'bitcoin', text(response));
  response = await call('coingecko_add_snapshot', { coin_id: 'bitcoin', price: 100, currency: 'usd', source: 'mcp-test' });
  expect('add_snapshot persists a price', parsed(response) && parsed(response).price === 100, text(response));
  response = await call('coingecko_get_price', { ids: ['bitcoin'], persist: true });
  expect('get_price returns and persists live fixture data', parsed(response) && parsed(response).data.bitcoin.usd === 67000.25
    && parsed(response).snapshots.length === 1, text(response));
  response = await call('coingecko_get_price', { ids: ['bitcoin'] });
  expect('second price call uses TTL cache', parsed(response) && parsed(response).cached === true, text(response));
  response = await call('coingecko_refresh', {});
  expect('refresh stores tracked assets', parsed(response) && parsed(response).refreshed === 1, text(response));
  response = await call('coingecko_list_assets', {});
  expect('list_assets returns the shared asset', parsed(response) && parsed(response).length === 1 && parsed(response)[0].symbol === 'btc');
  response = await call('coingecko_list_snapshots', { coin_id: 'bitcoin' });
  expect('list_snapshots returns manual and live history', parsed(response) && parsed(response).length >= 2);
  response = await call('coingecko_synthesize', { feature: 'portfolio' });
  expect('synthesize returns bounded market content', text(response).includes('CoinGecko Portfolio Synthesis') && text(response).includes('bitcoin'));

  response = await call('coingecko_add_snapshot', { coin_id: 'bitcoin', price: -1 });
  expect('negative price is rejected with -32602', response.error && response.error.code === -32602);
  response = await call('coingecko_get_price', { ids: [] });
  expect('empty ids are rejected with -32602', response.error && response.error.code === -32602);
  response = await call('coingecko_add_asset', { coin_id: 'ethereum', unexpected: true });
  expect('additional properties are rejected with -32602', response.error && response.error.code === -32602);
  response = await call('coingecko_list_assets', { limit: 1001 });
  expect('schema maximum is enforced', response.error && response.error.code === -32602);
  response = await call('coingecko_refresh', { coin_id: 'unknown-coin' });
  expect('unknown refresh returns a domain error result', response.result && response.result.isError === true && text(response).includes('Unknown tracked asset'));
  response = await call('coingecko_synthesize', { feature: 'unknown-coin' });
  expect('unknown synthesis returns a domain error result', response.result && response.result.isError === true);
  response = await call('not_a_tool', {});
  expect('unknown tool returns -32602', response.error && response.error.code === -32602);

  const batchStart = s.responses.length;
  s.send([{ jsonrpc: '2.0', id: id(), method: 'ping' }]);
  await sleep(200);
  const batch = s.responses.slice(batchStart)[0];
  expect('latest protocol rejects batch requests', batch && batch.error && batch.error.code === -32600 && /batching/.test(batch.error.message));
  s.sendRaw('{bad json');
  const parseError = await s.waitFor((message) => message.error && message.error.code === -32700);
  expect('malformed JSON returns -32700', !!parseError);
  expect('stdout contains only valid JSON messages', !s.responses.some((message) => message.parseError));
  s.stop();
  await sleep(200);

  const s2 = startServer(root, true);
  const init2 = id();
  s2.send({ jsonrpc: '2.0', id: init2, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-2', version: '1.0.0' },
  } });
  await s2.waitFor((message) => message.id === init2);
  s2.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list2 = id();
  s2.send({ jsonrpc: '2.0', id: list2, method: 'tools/call', params: { name: 'coingecko_list_snapshots', arguments: { coin_id: 'bitcoin' } } });
  const persisted = await s2.waitFor((message) => message.id === list2);
  expect('snapshots persist across MCP restarts', text(persisted).includes('bitcoin') && text(persisted).includes('67000.25'));
  s2.stop();

  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coingecko-mcp-legacy-'));
  const legacy = startServer(legacyRoot);
  const legacyInit = id();
  legacy.send({ jsonrpc: '2.0', id: legacyInit, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legacy', version: '1.0.0' },
  } });
  const legacyNegotiated = await legacy.waitFor((message) => message.id === legacyInit);
  expect('older protocol version is negotiated', legacyNegotiated.result && legacyNegotiated.result.protocolVersion === '2025-03-26');
  legacy.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const legacyBatchId = id();
  legacy.send([{ jsonrpc: '2.0', id: legacyBatchId, method: 'ping' }]);
  const legacyBatch = await legacy.waitFor((message) => Array.isArray(message) && message[0] && message[0].id === legacyBatchId);
  expect('older protocol receives a batch array response', Array.isArray(legacyBatch) && legacyBatch[0].result);
  legacy.stop();
  fs.rmSync(legacyRoot, { recursive: true, force: true });

  const preinitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coingecko-mcp-preinit-'));
  const s3 = startServer(preinitRoot);
  const early = id();
  s3.send({ jsonrpc: '2.0', id: early, method: 'ping' });
  const earlyResponse = await s3.waitFor((message) => message.id === early);
  expect('request before initialize returns -32002', earlyResponse.error && earlyResponse.error.code === -32002);
  const empty = id();
  s3.send({ jsonrpc: '2.0', id: empty, method: 'initialize', params: {} });
  const emptyResponse = await s3.waitFor((message) => message.id === empty);
  expect('empty initialize returns -32602', emptyResponse.error && emptyResponse.error.code === -32602);
  s3.stop();
  fs.rmSync(preinitRoot, { recursive: true, force: true });

  const passed = checks.filter((check) => check.ok).length;
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
  console.log(`RESULT ${passed}/${checks.length} checks passed`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
