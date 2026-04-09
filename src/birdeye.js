'use strict';
// src/birdeye.js — Birdeye API 封装
// getPrice: 实时 USD 价格（每次轮询调用）
// getFdv:   FDV + LP（30秒缓存，返回 {fdv, lp}）

const fetch  = require('node-fetch');
const logger = require('./logger');

const BIRDEYE_KEY  = process.env.BIRDEYE_API_KEY || '';
const BASE         = 'https://public-api.birdeye.so';
const FDV_CACHE_MS = 30 * 1000;

// 缓存：address → { fdv, lp, ts }
const _fdvCache = new Map();

async function getPrice(address) {
  const url = `${BASE}/defi/price?address=${address}`;
  const res = await fetch(url, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
    timeout: 5000,
  });
  if (!res.ok) throw new Error(`Birdeye price HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success || !json.data) throw new Error('Birdeye price 返回异常');
  return json.data.value;
}

async function getFdv(address) {
  const cached = _fdvCache.get(address);
  if (cached && Date.now() - cached.ts < FDV_CACHE_MS) {
    return { fdv: cached.fdv, lp: cached.lp };
  }
  try {
    const res = await fetch(`${BASE}/defi/token_overview?address=${address}`, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
      timeout: 5000,
    });
    if (!res.ok) {
      logger.warn('[Birdeye] token_overview %s 返回 %d', address, res.status);
      return { fdv: cached?.fdv ?? null, lp: cached?.lp ?? null };
    }
    const json = await res.json();
    const fdv  = json?.data?.fdv ?? json?.data?.mc ?? null;
    const lp   = json?.data?.liquidity ?? null;
    _fdvCache.set(address, { fdv, lp, ts: Date.now() });
    return { fdv, lp };
  } catch (err) {
    logger.warn('[Birdeye] getFdv %s 失败: %s', address, err.message);
    return { fdv: cached?.fdv ?? null, lp: cached?.lp ?? null };
  }
}

function clearCache(address) { _fdvCache.delete(address); }

module.exports = { getPrice, getFdv, clearCache };
