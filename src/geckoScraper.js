'use strict';
// src/geckoScraper.js — GeckoTerminal Trending 抓取
//
// 每5分钟调用 GeckoTerminal 免费 API
// GET https://api.geckoterminal.com/api/v2/networks/solana/trending_pools
// 过滤条件：
//   - age: 2小时 ~ 8小时
//   - fdv_usd >= 50000
//   - reserve_in_usd (LP) >= 10000
//   - 取前20名
// 通过安全检查后推送到 webhook

const fetch  = require('node-fetch');
const logger = require('./logger');

const GECKO_BASE    = 'https://api.geckoterminal.com/api/v2';
const POLL_INTERVAL = parseInt(process.env.GECKO_POLL_SEC || '300', 10) * 1000; // 默认5分钟
const TOP_N         = parseInt(process.env.GECKO_TOP_N   || '20',  10);
const WEBHOOK_URL   = `http://127.0.0.1:${process.env.PORT || 3001}/webhook/add-token`;
const BIRDEYE_KEY   = process.env.BIRDEYE_API_KEY || '';
const BIRDEYE_BASE  = 'https://public-api.birdeye.so';

// 过滤阈值
const MIN_AGE_HOURS = parseFloat(process.env.GECKO_MIN_AGE_HOURS || '2');   // 最小年龄（小时）
const MAX_AGE_HOURS = parseFloat(process.env.GECKO_MAX_AGE_HOURS || '8');   // 最大年龄（小时）
const MIN_FDV       = parseFloat(process.env.GECKO_MIN_FDV       || '50000');
const MIN_LP        = parseFloat(process.env.GECKO_MIN_LP        || '10000');

// 去重缓存
const _seen = new Set();
let _timer  = null;
let _running = false;

// ── GeckoTerminal 抓取 ───────────────────────────────────────────

async function fetchTrending() {
  const url = `${GECKO_BASE}/networks/solana/trending_pools?include=base_token&page=1`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json;version=20230302',
    },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
  const json = await res.json();
  return json;
}

function parseTokens(json) {
  const pools    = json?.data      || [];
  const included = json?.included  || [];

  // 构建 token 地址映射（included 里的 base_token）
  const tokenMap = {};
  for (const item of included) {
    if (item.type === 'token') {
      tokenMap[item.id] = {
        address: item.attributes?.address,
        symbol : item.attributes?.symbol || item.attributes?.name || '???',
      };
    }
  }

  const now     = Date.now();
  const results = [];

  for (const pool of pools.slice(0, TOP_N)) {
    const attr = pool.attributes || {};

    // pool_created_at → age 计算
    const createdAt = attr.pool_created_at;
    if (!createdAt) continue;
    const ageMs    = now - new Date(createdAt).getTime();
    const ageHours = ageMs / (1000 * 3600);

    // age 过滤：2小时 ~ 8小时
    if (ageHours < MIN_AGE_HOURS || ageHours > MAX_AGE_HOURS) continue;

    // FDV 过滤
    const fdv = parseFloat(attr.fdv_usd) || 0;
    if (fdv < MIN_FDV) continue;

    // LP 过滤（reserve_in_usd = 流动性总量）
    const lp = parseFloat(attr.reserve_in_usd) || 0;
    if (lp < MIN_LP) continue;

    // 获取 base_token 地址和 symbol
    const baseTokenRef  = pool.relationships?.base_token?.data;
    const baseTokenInfo = baseTokenRef ? tokenMap[baseTokenRef.id] : null;
    const address       = baseTokenInfo?.address || attr.base_token_price_usd ? null : null;

    // 从 pool id 中提取 token 地址（格式: solana_ADDRESS）
    // base_token 的 id 格式: solana_ADDRESS
    const tokenId = baseTokenRef?.id || '';
    const tokenAddress = tokenId.replace('solana_', '');
    if (!tokenAddress || tokenAddress.length < 32) continue;

    const symbol = baseTokenInfo?.symbol || tokenAddress.slice(0, 6) + '...';

    results.push({
      address : tokenAddress,
      symbol,
      fdv,
      lp,
      ageHours: Math.round(ageHours * 10) / 10,
      poolAddress: attr.address,
    });
  }

  return results;
}

// ── Birdeye 安全检查 ─────────────────────────────────────────────

async function checkSecurity(address) {
  if (!BIRDEYE_KEY) return { pass: true, reason: 'NO_API_KEY' };
  try {
    const res  = await fetch(`${BIRDEYE_BASE}/defi/token_security?address=${address}`, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
      timeout: 8000,
    });
    if (!res.ok) return { pass: true, reason: `API_${res.status}` };
    const json = await res.json();
    const d    = json?.data;
    if (!d)    return { pass: true, reason: 'NO_DATA' };

    const reasons = [];
    if (d.freezeable === true)
      reasons.push('FREEZEABLE');
    if (d.freezeAuthority != null && d.freezeAuthority !== '')
      reasons.push('FREEZE_AUTH');
    if (d.isHoneypot === true || d.honeypot === true)
      reasons.push('HONEYPOT');
    if (d.mintable === true || (d.mintAuthority != null && d.mintAuthority !== ''))
      reasons.push('MINTABLE');
    if (d.top10HolderPercent != null && d.top10HolderPercent > 80)
      reasons.push(`TOP10_${d.top10HolderPercent.toFixed(0)}%`);
    if (d.ownerPercentage != null && d.ownerPercentage > 10)
      reasons.push(`DEV_${d.ownerPercentage.toFixed(1)}%`);
    if (d.buyTax  != null && d.buyTax  > 5) reasons.push(`BUY_TAX_${d.buyTax}%`);
    if (d.sellTax != null && d.sellTax > 5) reasons.push(`SELL_TAX_${d.sellTax}%`);

    if (reasons.length > 0) return { pass: false, reason: reasons.join('+') };
    return { pass: true, reason: 'OK' };
  } catch (err) {
    logger.warn('[Gecko] 安全检查失败 %s: %s', address.slice(0, 8), err.message);
    return { pass: true, reason: 'CHECK_FAILED' };
  }
}

// ── 推送到 webhook ───────────────────────────────────────────────

async function pushToWebhook(token) {
  try {
    const res  = await fetch(WEBHOOK_URL, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        address: token.address,
        symbol : token.symbol,
        network: 'solana',
        fdv    : token.fdv,
        lp     : token.lp,
        source : 'gecko_trending',
      }),
      timeout: 5000,
    });
    const json = await res.json();
    if (json.ok) {
      logger.info('[Gecko] ✅ %s (%s...) 推送成功  age=%.1fh  FDV=$%s  LP=$%s',
        token.symbol, token.address.slice(0, 8),
        token.ageHours,
        Math.round(token.fdv).toLocaleString(),
        Math.round(token.lp).toLocaleString());
    } else if (res.status === 409) {
      logger.debug('[Gecko] %s 已在监控中', token.symbol);
    }
  } catch (err) {
    logger.warn('[Gecko] 推送 %s 失败: %s', token.symbol, err.message);
  }
}

// ── 主循环 ──────────────────────────────────────────────────────

async function poll() {
  if (!_running) return;
  logger.info('[Gecko] 开始抓取 SOL trending...');

  try {
    const json   = await fetchTrending();
    const tokens = parseTokens(json);

    logger.info('[Gecko] 过滤后剩 %d 个符合条件的代币（age %.0f-%.0fh / FDV>$%s / LP>$%s）',
      tokens.length, MIN_AGE_HOURS, MAX_AGE_HOURS,
      MIN_FDV.toLocaleString(), MIN_LP.toLocaleString());

    for (const token of tokens) {
      if (_seen.has(token.address)) continue;

      // Birdeye 安全检查
      const sec = await checkSecurity(token.address);
      if (!sec.pass) {
        logger.info('[Gecko] ❌ %s 安全检查未通过: %s', token.symbol, sec.reason);
        _seen.add(token.address);
        continue;
      }

      _seen.add(token.address);
      await pushToWebhook(token);

      // 限速：每个币间隔300ms，避免 Birdeye API 压力
      await new Promise(r => setTimeout(r, 300));
    }

    // 缓存超500条时清理
    if (_seen.size > 500) {
      _seen.clear();
      logger.debug('[Gecko] _seen 缓存已清理');
    }

  } catch (err) {
    logger.error('[Gecko] poll 失败: %s', err.message);
  }

  if (_running) _timer = setTimeout(poll, POLL_INTERVAL);
}

// ── 生命周期 ────────────────────────────────────────────────────

function start() {
  if (_running) return;
  _running = true;

  const enabled = (process.env.GECKO_ENABLED || 'true') === 'true';
  if (!enabled) {
    logger.info('[Gecko] 已禁用（GECKO_ENABLED=false）');
    return;
  }

  logger.info('[Gecko] 启动 | 间隔=%ds | 前%d名 | age %.0f-%.0fh | FDV≥$%s | LP≥$%s',
    POLL_INTERVAL / 1000, TOP_N,
    MIN_AGE_HOURS, MAX_AGE_HOURS,
    MIN_FDV.toLocaleString(), MIN_LP.toLocaleString());

  // 启动3秒后首次抓取
  _timer = setTimeout(poll, 3000);
}

function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  logger.info('[Gecko] 已停止');
}

module.exports = { start, stop };
