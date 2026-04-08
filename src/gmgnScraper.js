'use strict';
// src/gmgnScraper.js — GMGN 趋势榜抓取 + Birdeye 安全/FDV/LP 过滤
//
// 每5分钟抓取 https://gmgn.ai/trend?chain=sol&tab=trending
// 通过 Webshare 代理绕过 Cloudflare 封锁
// 解析前10个代币 → Birdeye 安全检查 + FDV/LP 过滤 → 推送 webhook

const fetch  = require('node-fetch');
const logger = require('./logger');

const GMGN_URL      = 'https://gmgn.ai/trend?chain=sol&tab=trending';
const POLL_INTERVAL = parseInt(process.env.GMGN_POLL_SEC  || '300', 10) * 1000;
const TOP_N         = parseInt(process.env.GMGN_TOP_N     || '10',  10);
const WEBHOOK_URL   = `http://127.0.0.1:${process.env.PORT || 3001}/webhook/add-token`;
const BIRDEYE_KEY   = process.env.BIRDEYE_API_KEY || '';
const BIRDEYE_BASE  = 'https://public-api.birdeye.so';

// Webshare 代理配置
const WEBSHARE_API_KEY = process.env.WEBSHARE_API_KEY || '';
const WEBSHARE_USER    = process.env.WEBSHARE_PROXY_USER || '';
const WEBSHARE_PASS    = process.env.WEBSHARE_PROXY_PASS || '';

// 过滤阈值
const MIN_FDV = parseFloat(process.env.GMGN_MIN_FDV || '30000');
const MIN_LP  = parseFloat(process.env.GMGN_MIN_LP  || '10000');

// 去重缓存
const _seen = new Set();

let _browser     = null;
let _proxyList   = [];   // 可用代理列表
let _proxyIndex  = 0;    // 轮换索引
let _timer       = null;
let _running     = false;
let _puppeteer   = null;

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

// ── Webshare 代理管理 ────────────────────────────────────────────

/**
 * 从 Webshare API 获取代理列表
 * 代理格式: { host, port, username, password }
 */
async function fetchProxyList() {
  if (!WEBSHARE_API_KEY) return [];
  try {
    const res = await fetch(
      'https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=20',
      { headers: { Authorization: `Token ${WEBSHARE_API_KEY}` }, timeout: 10000 }
    );
    if (!res.ok) {
      logger.warn('[GMGN] Webshare 代理列表获取失败: %d', res.status);
      return [];
    }
    const json = await res.json();
    const proxies = (json.results || [])
      .filter(p => p.valid)
      .map(p => ({
        host    : p.proxy_address,
        port    : p.port,
        username: p.username || WEBSHARE_USER,
        password: p.password || WEBSHARE_PASS,
      }));
    logger.info('[GMGN] 获取到 %d 个 Webshare 代理', proxies.length);
    return proxies;
  } catch (err) {
    logger.warn('[GMGN] Webshare API 请求失败: %s', err.message);
    return [];
  }
}

/**
 * 轮换获取下一个代理
 * 如果没有 Webshare 但配置了静态 user/pass，用 Webshare 默认端点
 */
function getNextProxy() {
  // 有代理列表，轮换使用
  if (_proxyList.length > 0) {
    const proxy = _proxyList[_proxyIndex % _proxyList.length];
    _proxyIndex++;
    return proxy;
  }
  // 没有代理列表但配置了静态认证信息，用 Webshare 的 rotating proxy 端点
  if (WEBSHARE_USER && WEBSHARE_PASS) {
    return {
      host    : 'p.webshare.io',
      port    : 80,
      username: WEBSHARE_USER,
      password: WEBSHARE_PASS,
    };
  }
  return null;
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
    if (d.freezeAuthority !== null && d.freezeAuthority !== undefined && d.freezeAuthority !== '')
      reasons.push(`FREEZE_AUTH`);
    if (d.isHoneypot === true || d.honeypot === true)
      reasons.push('HONEYPOT');
    if (d.mintable === true || (d.mintAuthority !== null && d.mintAuthority !== undefined && d.mintAuthority !== ''))
      reasons.push('MINTABLE');
    if (d.top10HolderPercent != null && d.top10HolderPercent > 80)
      reasons.push(`TOP10_${d.top10HolderPercent.toFixed(0)}%`);
    if (d.ownerPercentage != null && d.ownerPercentage > 10)
      reasons.push(`DEV_${d.ownerPercentage.toFixed(1)}%`);
    if (d.buyTax != null && d.buyTax > 5)
      reasons.push(`BUY_TAX_${d.buyTax}%`);
    if (d.sellTax != null && d.sellTax > 5)
      reasons.push(`SELL_TAX_${d.sellTax}%`);

    if (reasons.length > 0) return { pass: false, reason: reasons.join('+') };
    return { pass: true, reason: 'OK' };
  } catch (err) {
    logger.warn('[GMGN] 安全检查失败 %s: %s', address.slice(0, 8), err.message);
    return { pass: true, reason: 'CHECK_FAILED' };
  }
}

// ── Birdeye FDV/LP 检查 ──────────────────────────────────────────

async function checkFdvLp(address) {
  if (!BIRDEYE_KEY) return { pass: true, fdv: null, lp: null };
  try {
    const res  = await fetch(`${BIRDEYE_BASE}/defi/token_overview?address=${address}`, {
      headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
      timeout: 8000,
    });
    if (!res.ok) return { pass: true, fdv: null, lp: null };
    const json = await res.json();
    const d    = json?.data;
    if (!d)    return { pass: true, fdv: null, lp: null };

    const fdv = d.fdv ?? d.mc ?? null;
    const lp  = d.liquidity ?? null;
    const reasons = [];
    if (fdv !== null && fdv < MIN_FDV) reasons.push(`FDV_${Math.round(fdv)}<${MIN_FDV}`);
    if (lp  !== null && lp  < MIN_LP)  reasons.push(`LP_${Math.round(lp)}<${MIN_LP}`);

    if (reasons.length > 0) return { pass: false, fdv, lp, reason: reasons.join('+') };
    return { pass: true, fdv, lp, reason: 'OK' };
  } catch (err) {
    logger.warn('[GMGN] FDV/LP 检查失败 %s: %s', address.slice(0, 8), err.message);
    return { pass: true, fdv: null, lp: null };
  }
}

// ── GMGN 页面抓取 ────────────────────────────────────────────────

async function scrape() {
  const ppt = loadPuppeteer();
  if (!ppt) return [];

  const proxy = getNextProxy();
  let page    = null;

  try {
    // 每次抓取重建浏览器，确保使用最新代理且不留状态
    if (_browser) {
      try { await _browser.close(); } catch (_) {}
      _browser = null;
    }

    const launchArgs = [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1280,800',
    ];

    if (proxy) {
      launchArgs.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
      logger.info('[GMGN] 使用代理 %s:%d', proxy.host, proxy.port);
    } else {
      logger.warn('[GMGN] 未配置代理，直连可能被 Cloudflare 封锁');
    }

    _browser = await ppt.launch({ headless: 'new', args: launchArgs });

    page = await _browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // 代理认证
    if (proxy?.username) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    logger.debug('[GMGN] 加载页面...');
    await page.goto(GMGN_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // 检查是否被 Cloudflare 拦截
    const title = await page.title();
    if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('blocked')) {
      logger.warn('[GMGN] 被 Cloudflare 拦截（title: %s），尝试换代理', title);
      return [];
    }

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

    logger.info('[GMGN] ✅ 抓取成功，获得 %d 个代币', tokens.length);
    return tokens;

  } catch (err) {
    logger.error('[GMGN] 抓取失败: %s', err.message);
    return [];
  } finally {
    if (page)     { try { await page.close();    } catch (_) {} }
    if (_browser) { try { await _browser.close(); } catch (_) {} _browser = null; }
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
        source : 'gmgn_trending',
      }),
      timeout: 5000,
    });
    const json = await res.json();
    if (json.ok) {
      logger.info('[GMGN] ✅ %s (%s...) 推送成功  FDV=$%s LP=$%s',
        token.symbol, token.address.slice(0, 8),
        token.fdv ? Math.round(token.fdv).toLocaleString() : '?',
        token.lp  ? Math.round(token.lp).toLocaleString()  : '?');
    } else if (res.status === 409) {
      logger.debug('[GMGN] %s 已在监控中', token.symbol);
    }
  } catch (err) {
    logger.warn('[GMGN] 推送 %s 失败: %s', token.symbol, err.message);
  }
}

// ── 主循环 ──────────────────────────────────────────────────────

async function poll() {
  if (!_running) return;
  logger.info('[GMGN] 开始抓取（代理: %s）...', _proxyList.length > 0 ? `${_proxyList.length}个可用` : (WEBSHARE_USER ? 'rotating' : '无'));

  try {
    const tokens = await scrape();

    for (const token of tokens) {
      if (_seen.has(token.address)) continue;

      const sec = await checkSecurity(token.address);
      if (!sec.pass) {
        logger.info('[GMGN] ❌ %s 安全检查未通过: %s', token.symbol, sec.reason);
        _seen.add(token.address);
        continue;
      }

      const fdvlp = await checkFdvLp(token.address);
      if (!fdvlp.pass) {
        logger.info('[GMGN] ❌ %s FDV/LP 未达标: %s', token.symbol, fdvlp.reason);
        _seen.add(token.address);
        continue;
      }
      token.fdv = fdvlp.fdv;
      token.lp  = fdvlp.lp;

      _seen.add(token.address);
      await pushToWebhook(token);
      await new Promise(r => setTimeout(r, 300));
    }

    if (_seen.size > 500) _seen.clear();

  } catch (err) {
    logger.error('[GMGN] poll 异常: %s', err.message);
  }

  if (_running) _timer = setTimeout(poll, POLL_INTERVAL);
}

// ── 生命周期 ────────────────────────────────────────────────────

async function start() {
  if (_running) return;
  _running = true;

  const enabled = (process.env.GMGN_ENABLED || 'true') === 'true';
  if (!enabled) {
    logger.info('[GMGN] 已禁用（GMGN_ENABLED=false）');
    return;
  }
  if (!loadPuppeteer()) {
    logger.warn('[GMGN] Puppeteer 未安装，运行: npm install puppeteer-extra puppeteer-extra-plugin-stealth puppeteer');
    return;
  }

  // 启动时获取代理列表
  if (WEBSHARE_API_KEY) {
    _proxyList = await fetchProxyList();
    // 每小时刷新一次代理列表
    setInterval(async () => {
      _proxyList = await fetchProxyList();
    }, 60 * 60 * 1000);
  } else if (!WEBSHARE_USER) {
    logger.warn('[GMGN] ⚠️ 未配置 Webshare，可能被 Cloudflare 封锁');
    logger.warn('[GMGN]    配置方式: WEBSHARE_API_KEY=xxx 或 WEBSHARE_PROXY_USER+WEBSHARE_PROXY_PASS');
  }

  logger.info('[GMGN] 启动 | 间隔=%ds | 前%d名 | FDV≥$%s | LP≥$%s',
    POLL_INTERVAL / 1000, TOP_N,
    MIN_FDV.toLocaleString(), MIN_LP.toLocaleString());

  _timer = setTimeout(poll, 5000);
}

async function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (_browser) {
    try { await _browser.close(); } catch (_) {}
    _browser = null;
  }
  logger.info('[GMGN] 已停止');
}

module.exports = { start, stop };
