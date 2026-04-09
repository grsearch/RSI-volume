'use strict';
// src/birdeye.js — Birdeye API 封装
//
// 价格：/defi/price          — 每次轮询都调用（1秒）
// FDV+LP：/defi/token_overview — 每 30 秒查一次，结果缓存
//
// getFdv 返回 { fdv, lp }

const fetch  = require('node-fetch');
const logger = require('./logger');

const BIRDEYE_KEY  = process.env.BIRDEYE_API_KEY || '';
const BASE         = 'https://public-api.birdeye.so';
const FDV_CACHE_MS = 30 * 1000;  // FDV/LP 缓存 30 秒

// 缓存：address → { fdv, lp, ts }
const _fdvCache = new Map();

// ── 获取实时价格 ──────────────────────────────────────────────────

async function getPrice(address) {
  const url = `${BASE}/defi/price?address=${address}`;
  const res = await fetch(url, {
    headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
    timeout: 5000,
  });
  if (!res.ok) throw new Error(`Birdeye price error: ${res.status}`);
  const json = await res.json();
  if (!json.success || !json.data) throw new Error('Birdeye price 返回异常');
  return json.data.value;
}

// ── 获取 FDV + LP（带缓存，30秒更新一次） ────────────────────────

async function getFdv(address) {
  const cached = _fdvCache.get(address);
  if (cached && Date.now() - cached.ts < FDV_CACHE_MS) {
    return { fdv: cached.fdv, lp: cached.lp };
  }

  try {
    const url = `${BASE}/defi/token_overview?address=${address}`;
    const res = await fetch(url, {
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

function clearCache(address) {
  _fdvCache.delete(address);
}

module.exports = { getPrice, getFdv, clearCache };
