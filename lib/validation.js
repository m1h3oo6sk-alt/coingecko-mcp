'use strict';
const { DomainError } = require('./errors');

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DomainError(`${name} must be a non-empty string.`, 'EINVALID');
  }
  return value.trim();
}

function normalizeCoinId(value) {
  const id = nonEmptyString(value, 'coin_id').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) {
    throw new DomainError(`Invalid coin_id "${id}". Use the CoinGecko API id, such as bitcoin.`, 'EINVALID');
  }
  return id;
}

function normalizeCurrency(value = 'usd') {
  const currency = nonEmptyString(value, 'currency').toLowerCase();
  if (!/^[a-z0-9]{2,10}$/.test(currency)) {
    throw new DomainError(`Invalid currency "${currency}".`, 'EINVALID');
  }
  return currency;
}

function finiteNumber(value, name, { required = true, min } = {}) {
  if ((value === undefined || value === null || value === '') && !required) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || (min !== undefined && number < min)) {
    throw new DomainError(`${name} must be a finite number${min !== undefined ? ` >= ${min}` : ''}.`, 'EINVALID');
  }
  return number;
}

function isoDate(value, name, fallbackNow = false) {
  if ((value === undefined || value === null || value === '') && fallbackNow) return new Date().toISOString();
  const text = nonEmptyString(value, name);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new DomainError(`${name} must be an ISO-8601 date/time.`, 'EINVALID');
  return new Date(time).toISOString();
}

function countWords(text) {
  return (String(text || '').match(/\S+/g) || []).length;
}

function truncateWords(text, maxWords) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return String(text || '');
  return words.slice(0, Math.max(1, maxWords)).join(' ');
}

function asPublicAsset(row) {
  return row ? {
    coin_id: row.coin_id,
    symbol: row.symbol,
    name: row.name,
    platforms: row.platforms ? JSON.parse(row.platforms) : {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  } : null;
}

function asPublicSnapshot(row) {
  return row ? {
    id: Number(row.id),
    coin_id: row.coin_id,
    symbol: row.symbol,
    name: row.name,
    currency: row.currency,
    price: Number(row.price),
    market_cap: row.market_cap == null ? null : Number(row.market_cap),
    total_volume: row.total_volume == null ? null : Number(row.total_volume),
    price_change_percentage_24h: row.price_change_percentage_24h == null ? null : Number(row.price_change_percentage_24h),
    last_updated_at: row.last_updated_at,
    fetched_at: row.fetched_at,
    source: row.source,
  } : null;
}

module.exports = {
  nonEmptyString,
  normalizeCoinId,
  normalizeCurrency,
  finiteNumber,
  isoDate,
  countWords,
  truncateWords,
  asPublicAsset,
  asPublicSnapshot,
};
