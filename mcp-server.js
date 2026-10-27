#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const { CoinGeckoEngine } = require('./lib/engine');
const { createMcpHandler } = require('./lib/mcp-handlers');
const pkg = require('./package.json');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function startMcpServer(options = {}) {
  const engine = options.engine || new CoinGeckoEngine(options.engineOptions);
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const serverInfo = options.serverInfo || { name: pkg.name, version: pkg.version };
  const handler = createMcpHandler({
    engine,
    serverInfo,
    protocolVersion: PROTOCOL_VERSION,
    supportedVersions: new Set(SUPPORTED_VERSIONS),
  });
  let closing = false;
  let negotiatedVersion = null;
  const write = (message) => {
    if (!closing) stdout.write(`${JSON.stringify(message)}\n`);
  };
  const internalError = (err, id) => ({
    jsonrpc: '2.0', id: id === undefined ? null : id,
    error: { code: -32603, message: `Internal error: ${err && err.message ? err.message : String(err)}` },
  });
  const dispatch = (message) => {
    Promise.resolve()
      .then(() => handler.handleMessage(message))
      .then(
        (response) => {
          if (response && response.result && response.result.protocolVersion) negotiatedVersion = response.result.protocolVersion;
          if (response) write(response);
        },
        (err) => {
          const id = message && typeof message === 'object' && !Array.isArray(message) && 'id' in message ? message.id : null;
          write(internalError(err, id));
        },
      );
  };
  const rl = readline.createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (_) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: line is not valid JSON' } });
      return;
    }
    if (Array.isArray(parsed)) {
      if (negotiatedVersion === null || negotiatedVersion === PROTOCOL_VERSION) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: batching is not supported by the negotiated MCP version' } });
        return;
      }
      if (!parsed.length) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } });
        return;
      }
      Promise.all(parsed.map((element) => Promise.resolve()
        .then(() => handler.handleMessage(element))
        .then((response) => response || null)
        .catch((err) => internalError(err, element && typeof element === 'object' && 'id' in element ? element.id : null))))
        .then((responses) => {
          const nonEmpty = responses.filter(Boolean);
          if (nonEmpty.length) write(nonEmpty);
        });
      return;
    }
    dispatch(parsed);
  });
  const close = () => {
    if (closing) return;
    closing = true;
    try { rl.close(); } catch (_) { /* already closed */ }
    if (engine && typeof engine.close === 'function') engine.close();
  };
  rl.on('close', () => { close(); process.exitCode = 0; });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  stderr.write(`[coingecko-mcp] MCP server ready (protocol ${PROTOCOL_VERSION})\n`);
  stderr.write(`[coingecko-mcp] project root: ${engine.rootDir}\n`);
  return { engine, close };
}

if (require.main === module) {
  try { startMcpServer(); }
  catch (err) {
    process.stderr.write(`[coingecko-mcp] fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
}

module.exports = { startMcpServer, PROTOCOL_VERSION, SUPPORTED_VERSIONS };
