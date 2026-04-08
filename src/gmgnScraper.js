'use strict';
// src/gmgnScraper.js — GMGN 趋势榜抓取 + Birdeye 安全/FDV/LP 过滤
//
// 流程：
//   1. 每5分钟用 Puppeteer 抓取 GMGN 趋势榜前N名
//   2. 每个新币先查 Birdeye token_security（安全检查）
//   3. 再查 Birdeye token_overview（FDV / LP 过滤）
//   4. 通过全部过滤才推送到本地 webhook

const fetch  = require('node-fetch');
const logger = require('./logger');

const GMGN_URL      = 'https://gmgn.ai/trend?chain=sol&tab=trending';
const POLL_INTERVAL = parseInt(process.env.GMGN_POLL_SEC  || '300', 10) * 1000; // 默认5分钟
const TOP_N         = parseInt(process.env.GMGN_TOP_N     || '10',  10);
const WEBHOOK_URL   = `http://127.0.0.1:${process.env.PORT || 3001}/webhook/add-token`;
const BIRDEYE_KEY   = process.env.BIRDEYE_API_KEY || '';
const BASE          = 'https://public-api.birdeye.so';

// 过滤阈值
const MIN_FDV = parseFloat(process.env.GMGN_MIN_FDV_USD || '30000');
const MIN_LP  = parseFloat(process.env.GMGN_MIN_LP_USD  || '10000');

// 已推送过的地址集合（内存去重）
const _seen = new Set();

let _browser   = null;
let _timer     = null;
let _running   = false;
let _puppeteer = null;

// ── Puppeteer 懒加载 ─────────────────────────────────────────────

function loadPuppeteer() {
  if (_puppeteer) return _puppeteer;
  try {
    const puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    _puppeteer = puppeteerExtra;
    return _puppeteer;
  } catch (e) {
    logger.error('[GMGN] 缺少依赖，请运行: npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer');
    return null;
  }
}

// ── Birdeye 安全检查 ──────────────────────────────────────────────

async function checkSecurity(address) {
  if (!BIRDEYE_KEY) return { pass: true, reason: 'NO_BIRDEYE_KEY' };
  try {
    const url = `${BASE}/defi/token_security?address=${address}`;
    const res = await fetch(url, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
      timeout: 8000,
    });
    if (!res.ok) return { pass: true, reason: `HTTP_${res.status}` }; // 查询失败时放行，不因API问题误杀

    const json = await res.json();
    const d    = json?.data;
    if (!d)    return { pass: true, reason: 'NO_DATA' };

    // ── 拦截条件 ──────────────────────────────────────────────────
    // 1. 蜜罐检测
    if (d.isHoneypot === true) {
      return { pass: false, reason: 'HONEYPOT' };
    }
    // 2. 前10持有者占比超过80%（高度集中，拉盘风险）
    if (d.top10HolderPercent != null && d.top10HolderPercent > 80) {
      return { pass: false, reason: `TOP10_HOLDER_${d.top10HolderPercent.toFixed(1)}%>80%` };
    }
    // 3. 创建者余额占比超过50%
    if (d.creatorPercentage != null && d.creatorPercentage > 50) {
      return { pass: false, reason: `CREATOR_${d.creatorPercentage.toFixed(1)}%>50%` };
    }
    // 4. 冻结权限（freeze authority）未放弃
    if (d.freezeAuthority != null && d.freezeAuthority !== '') {
      return { pass: false, reason: 'FREEZE_AUTH_EXISTS' };
    }
    // 5. 铸造权限（mint authority）未放弃
    if (d.mintAuthority != null && d.mintAuthority !== '') {
      return { pass: false, reason: 'MINT_AUTH_EXISTS' };
    }

    return { pass: true, reason: 'OK' };
  } catch (err) {
    logger.warn('[GMGN] 安全检查异常 %s: %s', address.slice(0, 8), err.message);
    return { pass: true, reason: 'CHECK_ERROR' }; // 网络异常时放行
  }
}

// ── Birdeye FDV / LP 检查 ─────────────────────────────────────────

async function checkFdvLp(address) {
  if (!BIRDEYE_KEY) return { pass: true, fdv: null, lp: null, reason: 'NO_BIRDEYE_KEY' };
  try {
    const url = `${BASE}/defi/token_overview?address=${address}`;
    const res = await fetch(url, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
      timeout: 8000,
    });
    if (!res.ok) return { pass: true, fdv: null, lp: null, reason: `HTTP_${res.status}` };

    const json = await res.json();
    const d    = json?.data;
    if (!d)    return { pass: true, fdv: null, lp: null, reason: 'NO_DATA' };

    const fdv = d.fdv ?? d.mc ?? null;
    const lp  = d.liquidity ?? null;

    if (fdv != null && fdv < MIN_FDV) {
      return { pass: false, fdv, lp, reason: `FDV_LOW($${Math.round(fdv)}<$${MIN_FDV})` };
    }
    if (lp != null && lp < MIN_LP) {
      return { pass: false, fdv, lp, reason: `LP_LOW($${Math.round(lp)}<$${MIN_LP})` };
    }

    return { pass: true, fdv, lp, reason: 'OK' };
  } catch (err) {
    logger.warn('[GMGN] FDV/LP 检查异常 %s: %s', address.slice(0, 8), err.message);
    return { pass: true, fdv: null, lp: null, reason: 'CHECK_ERROR' };
  }
}

// ── GMGN 页面抓取 ─────────────────────────────────────────────────

async function scrape() {
  const ppt = loadPuppeteer();
  if (!ppt) return [];

  let page = null;
  try {
    if (!_browser || !_browser.isConnected()) {
      _browser = await ppt.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--window-size=1280,800',
        ],
      });
      logger.info('[GMGN] 浏览器启动');
    }

    page = await _browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    logger.debug('[GMGN] 加载页面...');
    await page.goto(GMGN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('a[href*="/sol/token/"]', { timeout: 15000 });

    const tokens = await page.evaluate((topN) => {
      const results = [];
      const seen    = new Set();
      const links   = Array.from(document.querySelectorAll('a[href*="/sol/token/"]'));

      for (const link of links) {
        const match = link.href.match(/\/sol\/token\/([A-Za-z0-9]{32,44})/);
        if (!match) continue;
        const address = match[1];
        if (seen.has(address)) continue;
        seen.add(address);

        // 尝试提取代币名称
        let symbol = '';
        const row  = link.closest('tr')
                  || link.closest('[class*="row"]')
                  || link.closest('[class*="item"]')
                  || link.parentElement;
        if (row) {
          const symEl = row.querySelector('[class*="symbol"]')
                     || row.querySelector('[class*="name"]')
                     || row.querySelector('b')
                     || row.querySelector('strong');
          if (symEl) symbol = symEl.textContent.trim().split('\n')[0].trim();
        }
        if (!symbol) symbol = address.slice(0, 6) + '...';

        results.push({ address, symbol });
        if (results.length >= topN) break;
      }
      return results;
    }, TOP_N);

    logger.info('[GMGN] 抓取到 %d 个代币', tokens.length);
    return tokens;

  } catch (err) {
    logger.error('[GMGN] 抓取失败: %s', err.message);
    if (_browser) {
      try { await _browser.close(); } catch (_) {}
      _browser = null;
    }
    return [];
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
}

// ── 推送到 webhook ────────────────────────────────────────────────

async function pushToWebhook(token, fdv, lp) {
  try {
    const res = await fetch(WEBHOOK_URL, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        address: token.address,
        symbol : token.symbol,
        network: 'solana',
        source : 'gmgn_trending',
        fdv,
        lp,
      }),
      timeout: 5000,
    });
    const json = await res.json();
    if (json.ok) {
      logger.info('[GMGN] ✅ %s (%s) FDV=$%s LP=$%s → 推送成功',
        token.symbol, token.address.slice(0, 8),
        fdv ? Math.round(fdv) : '?', lp ? Math.round(lp) : '?');
    } else if (res.status === 409) {
      logger.debug('[GMGN] %s 已在监控中', token.symbol);
    } else {
      logger.debug('[GMGN] %s 跳过: %s', token.symbol, json.reason || '');
    }
  } catch (err) {
    logger.warn('[GMGN] 推送 %s 失败: %s', token.symbol, err.message);
  }
}

// ── 主循环 ────────────────────────────────────────────────────────

async function poll() {
  if (!_running) return;

  logger.info('[GMGN] 开始抓取趋势榜...');
  try {
    const tokens = await scrape();
    let newCount = 0;

    for (const token of tokens) {
      if (_seen.has(token.address)) continue;

      // 安全检查
      const sec = await checkSecurity(token.address);
      if (!sec.pass) {
        logger.info('[GMGN] ❌ %s 安全检查未通过: %s', token.symbol, sec.reason);
        _seen.add(token.address); // 安全不过的也加入seen，避免重复检查
        continue;
      }

      // FDV / LP 检查
      const fl = await checkFdvLp(token.address);
      if (!fl.pass) {
        logger.info('[GMGN] ❌ %s 过滤: %s', token.symbol, fl.reason);
        _seen.add(token.address);
        continue;
      }

      logger.info('[GMGN] ✅ %s 通过检查 FDV=$%s LP=$%s',
        token.symbol,
        fl.fdv ? Math.round(fl.fdv) : '?',
        fl.lp  ? Math.round(fl.lp)  : '?');

      _seen.add(token.address);
      await pushToWebhook(token, fl.fdv, fl.lp);
      newCount++;

      // 每个币之间稍微间隔，避免 Birdeye 限速
      await new Promise(r => setTimeout(r, 500));
    }

    if (newCount === 0) {
      logger.debug('[GMGN] 本轮无新币通过过滤');
    }

    // 每600条清一次seen，让老币有机会重新进入
    if (_seen.size > 600) {
      _seen.clear();
      logger.debug('[GMGN] _seen 缓存已清理');
    }

  } catch (err) {
    logger.error('[GMGN] poll 异常: %s', err.message);
  }

  if (_running) {
    logger.debug('[GMGN] 下次抓取在 %ds 后', POLL_INTERVAL / 1000);
    _timer = setTimeout(poll, POLL_INTERVAL);
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────

function start() {
  if (_running) return;
  _running = true;

  const enabled = (process.env.GMGN_ENABLED || 'true') === 'true';
  if (!enabled) {
    logger.info('[GMGN] 已禁用（GMGN_ENABLED=false）');
    return;
  }

  if (!loadPuppeteer()) {
    logger.warn('[GMGN] 未安装 Puppeteer，安装命令: npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer');
    return;
  }

  if (!BIRDEYE_KEY) {
    logger.warn('[GMGN] 未配置 BIRDEYE_API_KEY，安全/FDV/LP 检查将跳过');
  }

  logger.info('[GMGN] 启动 | 间隔=%ds 前%d名 | FDV>$%s LP>$%s',
    POLL_INTERVAL / 1000, TOP_N,
    MIN_FDV.toLocaleString(), MIN_LP.toLocaleString());

  // 启动后3秒首次抓取，等 webhook server 就绪
  _timer = setTimeout(poll, 3000);
}

async function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
    logger.info('[GMGN] 浏览器已关闭');
  }
}

module.exports = { start, stop };
