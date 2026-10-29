'use strict';
const { DomainError } = require('./errors');
const { normalizeCoinId, normalizeCurrency, countWords, truncateWords } = require('./validation');

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

function priceText(value, currency) {
  if (value === null || value === undefined) return 'N/A';
  const digits = value >= 1 ? 2 : 8;
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value)} ${currency.toUpperCase()}`;
}

function changeText(value) {
  return value === null || value === undefined ? 'N/A' : `${value >= 0 ? '+' : ''}${numberFormat.format(value)}%`;
}

function compact(value) {
  return value === null || value === undefined ? 'N/A' : compactFormat.format(value);
}

function changeSortValue(row) {
  const change = row.price_change_percentage_24h;
  return change == null ? Number.NEGATIVE_INFINITY : Math.abs(change);
}

function truncateAtBoundary(text, maxWords) {
  const total = countWords(text);
  if (total <= maxWords) return text;
  const lines = String(text).split('\n');
  const kept = [];
  let words = 0;
  for (const line of lines) {
    const lineWords = countWords(line);
    if (words + lineWords > maxWords) break;
    kept.push(line);
    words += lineWords;
  }
  if (!kept.length) return truncateWords(text, maxWords);
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n');
}

class SynthesisEngine {
  constructor(cache, { maxWords = 900 } = {}) {
    this.cache = cache;
    this.maxWords = Math.max(100, Number(maxWords) || 900);
  }

  synthesize({ feature = 'portfolio', currency = 'usd', refresh = false } = {}) {
    feature = feature === 'portfolio' ? feature : normalizeCoinId(feature);
    currency = normalizeCurrency(currency);
    const key = `${feature}:${currency}:${this.maxWords}`;
    if (!refresh) {
      const cached = this.cache.getCachedSynthesis(key);
      if (cached) return {
        feature, currency, content: cached.content, wordCount: cached.word_count,
        maxWords: this.maxWords, cached: true, generatedAt: cached.created_at,
      };
    }

    const assets = feature === 'portfolio'
      ? this.cache.listAssets()
      : [this.cache.getAsset(feature)].filter(Boolean);
    if (feature !== 'portfolio' && !assets.length) {
      throw new DomainError(`Unknown tracked asset "${feature}". Add it before synthesis.`, 'ENOTFOUND');
    }
    const trackedIds = new Set(assets.map((asset) => asset.coin_id));
    const assetByCoin = new Map(assets.map((asset) => [asset.coin_id, asset]));
    const latest = this.cache.latestSnapshots(currency).filter((row) => trackedIds.has(row.coin_id));
    const latestByCoin = new Map(latest.map((row) => [row.coin_id, row]));
    const sorted = latest.slice().sort((a, b) => changeSortValue(b) - changeSortValue(a));
    const entries = sorted.map((row) => {
      const change = changeText(row.price_change_percentage_24h);
      const asset = assetByCoin.get(row.coin_id);
      const name = asset ? asset.name : row.name;
      const symbol = asset ? asset.symbol : row.symbol;
      return `- **${name} (${symbol}, ${row.coin_id})**: ${priceText(row.price, row.currency)}; 24h ${change}; market cap ${compact(row.market_cap)}; volume ${compact(row.total_volume)}; updated ${row.last_updated_at} (${row.source}).`;
    });
    if (feature !== 'portfolio') {
      const history = this.cache.listSnapshots({ coinId: feature, currency, limit: 12, order: 'recent' });
      entries.push(...history.slice(1).map((row) => `- History: ${priceText(row.price, row.currency)} at ${row.last_updated_at}; 24h ${changeText(row.price_change_percentage_24h)}.`));
    }

    const header = [
      `# CoinGecko ${feature === 'portfolio' ? 'Portfolio' : feature} Synthesis`,
      '',
      `_Generated ${new Date().toISOString()} from ${assets.length} tracked assets and ${latest.length} latest snapshots. Currency: ${currency.toUpperCase()}._`,
      '',
      '## Market Overview',
      '',
      `- Tracked assets: ${assets.length}; assets with ${currency.toUpperCase()} prices: ${latest.length}; missing latest prices: ${assets.length - latest.length}.`,
      `- Coverage: ${assets.length ? numberFormat.format((latest.length / assets.length) * 100) : '0'}%. Prices are ordered by absolute 24-hour change.`,
      '',
      '## Latest Prices and Movers',
      '',
    ];
    const included = entries.length ? entries : ['_No market snapshots are available yet. Run refresh to fetch current prices._'];

    const assemble = (omitted) => {
      const footer = [
        '',
        '## Data Quality',
        '',
        `- Missing assets: ${assets.filter((asset) => !latestByCoin.has(asset.coin_id)).map((asset) => asset.coin_id).join(', ') || 'none'}.`,
        `- Entries omitted for the word budget: ${omitted}. Values come from stored snapshots; no prices are invented.`,
        `- Cache key: ${key}.`,
      ];
      return [...header, ...included, ...footer].join('\n') + '\n';
    };

    let omitted = 0;
    let content = assemble(omitted);
    while (countWords(content) > this.maxWords && included.length > 1) {
      included.pop();
      omitted++;
      content = assemble(omitted);
    }
    if (countWords(content) > this.maxWords) {
      content = truncateAtBoundary(assemble(omitted), this.maxWords) + '\n';
    }
    const wordCount = countWords(content);
    this.cache.setCachedSynthesis(key, content, wordCount);
    return {
      feature, currency, content, wordCount, maxWords: this.maxWords,
      assetCount: assets.length, snapshotCount: latest.length,
      cached: false, omitted, generatedAt: new Date().toISOString(),
    };
  }

  synthesizeToFile(fileStore, options = {}) {
    const brief = this.synthesize(options);
    const filePath = fileStore.writeSynthesis(brief.feature, brief.content);
    return { ...brief, filePath };
  }
}

module.exports = { SynthesisEngine };
