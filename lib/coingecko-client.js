'use strict';
const fs = require('node:fs');
const { DomainError } = require('./errors');
const pkg = require('../package.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

class CoinGeckoClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3';
    this.apiKey = options.apiKey || process.env.COINGECKO_API_KEY || '';
    this.pro = options.pro ?? /^(1|true|yes)$/i.test(process.env.COINGECKO_PRO || '');
    this.timeoutMs = Number(options.timeoutMs || process.env.COINGECKO_TIMEOUT_MS || 10000);
    this.retries = options.retries === undefined ? 2 : Math.max(0, Number(options.retries) || 0);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    const fixturePath = options.fixturePath || process.env.COINGECKO_FIXTURE || '';
    this.fixture = null;
    if (fixturePath) {
      try { this.fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')); }
      catch (err) { throw new DomainError(`Cannot load CoinGecko fixture ${fixturePath}: ${err.message}`, 'EFIXTURE'); }
    }
    if (!this.fixture && typeof this.fetchImpl !== 'function') {
      throw new DomainError('global fetch is unavailable; provide fetchImpl or COINGECKO_FIXTURE.', 'EFETCH');
    }
  }

  _fixtureValue(key) {
    if (!this.fixture || this.fixture[key] === undefined) {
      throw new DomainError(`Fixture response "${key}" is not defined.`, 'EFIXTURE');
    }
    return JSON.parse(JSON.stringify(this.fixture[key]));
  }

  async _request(pathname, params = {}, fixtureKey) {
    if (this.fixture) return this._fixtureValue(fixtureKey);
    const url = new URL(this.baseUrl.replace(/\/$/, '') + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    const headers = { accept: 'application/json', 'user-agent': `coingecko-mcp/${pkg.version}` };
    if (this.apiKey) headers[this.pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = this.apiKey;
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { headers, signal: controller.signal });
        const text = await response.text();
        if (!response.ok) {
          const error = new DomainError(`CoinGecko API HTTP ${response.status}: ${text.slice(0, 500)}`, 'EAPI', { status: response.status });
          if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
            lastError = error;
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
            await sleep(retryAfter !== null ? Math.min(5000, retryAfter) : Math.min(2000, 250 * 2 ** attempt));
            continue;
          }
          throw error;
        }
        try {
          return JSON.parse(text);
        } catch (err) {
          const invalid = new DomainError(`CoinGecko returned invalid JSON: ${err.message}`, 'EAPI');
          if (attempt < this.retries) {
            lastError = invalid;
            await sleep(Math.min(2000, 250 * 2 ** attempt));
            continue;
          }
          throw invalid;
        }
      } catch (err) {
        lastError = err && err.name === 'AbortError'
          ? new DomainError(`CoinGecko request timed out after ${this.timeoutMs}ms.`, 'ETIMEOUT')
          : err;
        const retriable = !(err instanceof DomainError && (err.code === 'EAPI' || err.code === 'EFIXTURE'));
        if (attempt < this.retries && retriable) {
          await sleep(Math.min(2000, 250 * 2 ** attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new DomainError('CoinGecko request failed.', 'EAPI');
  }

  async ping() {
    return this._request('/ping', {}, 'ping');
  }

  async simplePrice({ ids, currencies = ['usd'] } = {}) {
    if (!Array.isArray(ids) || !ids.length) throw new DomainError('ids must contain at least one coin id.', 'EINVALID');
    const result = await this._request('/simple/price', {
      ids,
      vs_currencies: currencies,
      include_market_cap: true,
      include_24hr_vol: true,
      include_24hr_change: true,
      include_last_updated_at: true,
    }, 'simplePrice');
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new DomainError('CoinGecko simple/price returned an unexpected response shape.', 'EAPI');
    }
    return result;
  }

  async marketChart({ id, currency = 'usd', days = 1 } = {}) {
    if (!id) throw new DomainError('id is required for market chart data.', 'EINVALID');
    const result = await this._request(`/coins/${encodeURIComponent(id)}/market_chart`, {
      vs_currency: currency,
      days,
    }, 'marketChart');
    if (!result || typeof result !== 'object' || !Array.isArray(result.prices)) {
      throw new DomainError('CoinGecko market_chart returned an unexpected response shape.', 'EAPI');
    }
    return result;
  }

  async markets({ ids, currency = 'usd', perPage = 10, page = 1 } = {}) {
    const result = await this._request('/coins/markets', {
      vs_currency: currency,
      ids: Array.isArray(ids) && ids.length ? ids : undefined,
      order: 'market_cap_desc',
      per_page: perPage,
      page,
      sparkline: false,
      price_change_percentage: '24h',
    }, 'markets');
    if (!Array.isArray(result)) {
      throw new DomainError('CoinGecko coins/markets returned an unexpected response shape.', 'EAPI');
    }
    return result;
  }
}

module.exports = { CoinGeckoClient, parseRetryAfter };
