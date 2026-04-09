'use strict';
// src/monitor.js — 核心监控引擎 V2
// 基于原始版本，增加：
//   - LP 退出检查
//   - 买入前强制刷新 FDV/LP
//   - Helius 链上回调触发止损（用 Birdeye USD 价格，响应更快）
//   - 卖出后继续监控（冷却60秒再允许买入）
//   - Dashboard 数据增强（addedAt, lp 广播）

const EventEmitter = require('events');
const { evaluateSignal, buildCandles } = require('./rsi');
const trader    = require('./trader');
const birdeye   = require('./birdeye');
const logger    = require('./logger');
const wsHub     = require('./wsHub');
const dataStore = require('./dataStore');
const heliusWs  = require('./heliusWs');

const MONITOR_MINUTES = parseInt(process.env.TOKEN_MAX_AGE_MINUTES || '60', 10);
const FDV_EXIT        = parseFloat(process.env.FDV_EXIT_USD        || '10000');
const LP_EXIT         = parseFloat(process.env.LP_EXIT_USD         || '5000');
const POLL_SEC        = parseInt(process.env.PRICE_POLL_SEC        || '1',   10);
const KLINE_SEC       = parseInt(process.env.KLINE_INTERVAL_SEC    || '15',  10);
const DRY_RUN         = (process.env.DRY_RUN || 'false') === 'true';
const TRADE_SOL       = parseFloat(process.env.TRADE_SIZE_SOL      || '0.2');
const STOP_LOSS_PCT   = parseFloat(process.env.STOP_LOSS_PCT       || '-10');
const COOLDOWN_SEC    = parseInt(process.env.TRADE_COOLDOWN_SEC    || '60',  10);

// 全局交易记录
const _allTradeRecords = [];

function _loadPersistedTrades() {
  try {
    const trades = dataStore.loadTrades();
    const cutoff = Date.now() - 24 * 3600 * 1000;
    trades.filter(r => r.buyAt > cutoff).forEach(r => _allTradeRecords.push(r));
    if (_allTradeRecords.length > 0) {
      logger.info('[Monitor] 从磁盘加载了 %d 条交易记录', _allTradeRecords.length);
    }
  } catch (_) {}
}

class TokenMonitor extends EventEmitter {
  constructor() {
    super();
    this._tokens    = new Map();
    this._pollTimer = null;
    this._started   = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    dataStore.init();
    _loadPersistedTrades();
    dataStore.startFlush();
    heliusWs.start();
    this._scheduleNextPoll();
    logger.info('[Monitor] 启动 | 轮询=%ds K线=%ds DRY_RUN=%s HeliusWS=%s',
      POLL_SEC, KLINE_SEC, DRY_RUN, heliusWs.isConnected() ? '已连接' : '连接中');
  }

  stop() {
    this._started = false;
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; }
    dataStore.stopFlush();
    heliusWs.stop();
  }

  addToken(address, symbol, meta = {}) {
    if (this._tokens.has(address)) {
      logger.warn('[Monitor] %s 已在监控中，忽略', symbol);
      return false;
    }
    const now = Date.now();
    const state = {
      address,
      symbol,
      meta,
      fdv             : meta.fdv ?? null,
      lp              : meta.lp  ?? null,
      latestFdv       : null,
      latestLp        : null,
      addedAt         : now,
      expiresAt       : now + MONITOR_MINUTES * 60 * 1000,
      ticks           : [],
      chainTrades     : [],
      inPosition      : false,
      position        : null,
      tradeCount      : 0,
      shouldExit      : false,
      exitSent        : false,
      tradeLogs       : [],
      tradeRecords    : [],
      _prevRsiRealtime: NaN,
      _prevRsiTs      : 0,
      _lastBuyCandle  : -1,
      _lastSellCandle : -1,
      _cooldownUntil  : 0,
    };
    this._tokens.set(address, state);
    heliusWs.subscribe(address, symbol, (trade) => this._onChainTrade(address, trade));
    logger.info('[Monitor] ➕ 开始监控 %s (%s)，到期 %s | DRY_RUN=%s',
      symbol, address, new Date(state.expiresAt).toLocaleTimeString(), DRY_RUN);
    this._broadcastTokenList();
    return true;
  }

  async removeToken(address, reason = 'manual') {
    const state = this._tokens.get(address);
    if (!state) return;
    logger.info('[Monitor] ➖ 移除 %s，原因: %s', state.symbol, reason);
    if (state.inPosition && !state.exitSent) {
      logger.info('[Monitor] 📤 持仓中，先执行卖出...');
      await this._doSellExit(state, `FORCED_EXIT(${reason})`);
    }
    dataStore.flushTicks();
    heliusWs.unsubscribe(address);
    this._tokens.delete(address);
    birdeye.clearCache(address);
    this._broadcastTokenList();
  }

  getTokens() { return Array.from(this._tokens.values()).map(s => this._stateSnapshot(s)); }
  getToken(address) { const s = this._tokens.get(address); return s ? this._stateSnapshot(s) : null; }

  // ── Helius 链上交易回调 ──────────────────────────────────────

  _onChainTrade(address, trade) {
    const state = this._tokens.get(address);
    if (!state || state.exitSent) return;
    const now = Date.now();

    // 保存链上交易供量能统计
    if (!state.chainTrades) state.chainTrades = [];
    state.chainTrades.push({ ts: trade.ts || now, solAmount: trade.solAmount, isBuy: trade.isBuy });
    const cutoff5m = now - 5 * 60 * 1000;
    while (state.chainTrades.length > 0 && state.chainTrades[0].ts < cutoff5m) state.chainTrades.shift();

    dataStore.appendTick(address, {
      price: trade.priceSol, ts: trade.ts || now,
      symbol: state.symbol, signature: trade.signature,
      owner: trade.owner, solAmount: trade.solAmount, isBuy: trade.isBuy, source: 'helius',
    });

    // ── 链上成交触发止损检查（用 Birdeye USD 价格，更可靠）───────
    // 每笔链上成交都触发检查，比1秒轮询更快响应
    if (state.inPosition && !state.exitSent && state.position?.entryPriceUsd) {
      const latestUsd = state.ticks.length > 0 ? state.ticks[state.ticks.length - 1].price : null;
      if (latestUsd && latestUsd > 0) {
        const pnl = (latestUsd - state.position.entryPriceUsd) / state.position.entryPriceUsd * 100;
        if (pnl <= STOP_LOSS_PCT) {
          logger.warn('[Monitor] ⚡ %s 链上触发止损 USD %.8f→%.8f pnl=%.1f%%',
            state.symbol, state.position.entryPriceUsd, latestUsd, pnl);
          setImmediate(() => this._doSellExit(state, `STOP_LOSS(${pnl.toFixed(1)}%≤${STOP_LOSS_PCT}%)`));
        }
      }
    }

    logger.debug('[HeliusTrade] %s %s %.4f SOL @ %.10f',
      state.symbol, trade.isBuy ? 'BUY' : 'SELL', trade.solAmount, trade.priceSol);
  }

  // ── 主轮询 ──────────────────────────────────────────────────────

  _scheduleNextPoll() {
    if (!this._started) return;
    this._pollTimer = setTimeout(() => this._poll(), POLL_SEC * 1000);
  }

  async _poll() {
    const now = Date.now();
    const addresses = Array.from(this._tokens.keys());
    await Promise.allSettled(addresses.map(addr => this._pollOne(addr, now)));
    this._scheduleNextPoll();
  }

  async _pollOne(address, now) {
    const state = this._tokens.get(address);
    if (!state || state.exitSent) return;

    // 1. 到期检查
    if (now >= state.expiresAt) { await this.removeToken(address, 'EXPIRED'); return; }

    // 2. 拉取 Birdeye USD 价格
    let price;
    try { price = await birdeye.getPrice(address); }
    catch (err) { logger.warn('[Monitor] %s 价格拉取失败: %s', state.symbol, err.message); return; }

    // 3. FDV + LP 检查（30秒缓存）
    const { fdv, lp } = await birdeye.getFdv(address).catch(() => ({ fdv: null, lp: null }));
    if (Number.isFinite(fdv) && FDV_EXIT > 0 && fdv < FDV_EXIT) {
      logger.warn('[Monitor] %s FDV=$%s < $%s，退出', state.symbol, Math.round(fdv), FDV_EXIT);
      await this.removeToken(address, `FDV_TOO_LOW($${Math.round(fdv)})`); return;
    }
    if (Number.isFinite(lp) && LP_EXIT > 0 && lp < LP_EXIT) {
      logger.warn('[Monitor] %s LP=$%s < $%s，退出', state.symbol, Math.round(lp), LP_EXIT);
      await this.removeToken(address, `LP_TOO_LOW($${Math.round(lp)})`); return;
    }
    if (Number.isFinite(fdv)) state.latestFdv = fdv;
    if (Number.isFinite(lp))  state.latestLp  = lp;

    // 4. 记录 USD tick
    state.ticks.push({ price, ts: now });
    dataStore.appendTick(address, { price, ts: now, symbol: state.symbol, source: 'birdeye' });
    const cutoff = now - 30 * 60 * 1000;
    while (state.ticks.length > 0 && state.ticks[0].ts < cutoff) state.ticks.shift();

    // 5. 聚合K线（USD 价格）
    const { closed: closedCandles, current: currentCandle } = buildCandles(state.ticks, KLINE_SEC);

    // 5b. 把 chainTrades 量能注入 K线
    if (state.chainTrades && state.chainTrades.length > 0) {
      for (const candle of closedCandles) {
        const trades = state.chainTrades.filter(t => t.ts >= candle.openTime && t.ts < candle.closeTime);
        if (trades.length > 0) {
          candle.buyVolume  = trades.filter(t => t.isBuy).reduce((s, t) => s + (t.solAmount || 0), 0);
          candle.sellVolume = trades.filter(t => !t.isBuy).reduce((s, t) => s + (t.solAmount || 0), 0);
          candle.volume     = candle.buyVolume + candle.sellVolume || candle.volume;
        }
      }
      if (currentCandle) {
        const trades = state.chainTrades.filter(t => t.ts >= currentCandle.openTime);
        if (trades.length > 0) {
          currentCandle.buyVolume  = trades.filter(t => t.isBuy).reduce((s, t) => s + (t.solAmount || 0), 0);
          currentCandle.sellVolume = trades.filter(t => !t.isBuy).reduce((s, t) => s + (t.solAmount || 0), 0);
          currentCandle.volume     = currentCandle.buyVolume + currentCandle.sellVolume || currentCandle.volume;
        }
      }
    }

    state._currentCandle = currentCandle || null;

    // 6. RSI + 量能信号评估
    const realtimePrice = currentCandle ? currentCandle.close : price;
    const { rsi, prevRsi, signal, reason, volume } = evaluateSignal(closedCandles, realtimePrice, state);

    // 7. 记录信号
    if (reason && reason !== '' && reason !== 'rsi_rebase') {
      dataStore.appendSignal({
        ts: now, address, symbol: state.symbol, price,
        rsi: Number.isFinite(rsi) ? parseFloat(rsi.toFixed(2)) : null,
        prevRsi: Number.isFinite(prevRsi) ? parseFloat(prevRsi.toFixed(2)) : null,
        signal, reason, volume, inPosition: state.inPosition,
      });
    }

    // 8. 广播实时数据
    wsHub.broadcast({
      type: 'tick', address, symbol: state.symbol, price,
      fdv: state.latestFdv, lp: state.latestLp, addedAt: state.addedAt,
      rsi: Number.isFinite(rsi) ? parseFloat(rsi.toFixed(2)) : null,
      prevRsi: Number.isFinite(prevRsi) ? parseFloat(prevRsi.toFixed(2)) : null,
      signal, reason, closedCount: closedCandles.length,
      inPosition: state.inPosition, volume, dryRun: DRY_RUN, ts: now,
    });

    // 9. 执行信号
    if (signal === 'BUY' && !state.inPosition && !state.shouldExit) {
      if (state._cooldownUntil && Date.now() < state._cooldownUntil) {
        const remain = Math.ceil((state._cooldownUntil - Date.now()) / 1000);
        logger.debug('[Monitor] %s 冷却中，还剩 %ds', state.symbol, remain);
      } else {
        // 买入前强制刷新 FDV/LP
        birdeye.clearCache(address);
        const { fdv: fFdv, lp: fLp } = await birdeye.getFdv(address).catch(() => ({ fdv: null, lp: null }));
        if (fFdv !== null) state.latestFdv = fFdv;
        if (fLp  !== null) state.latestLp  = fLp;
        const fdvFail = Number.isFinite(fFdv) && FDV_EXIT > 0 && fFdv < FDV_EXIT;
        const lpFail  = Number.isFinite(fLp)  && LP_EXIT  > 0 && fLp  < LP_EXIT;
        if (fdvFail || lpFail) {
          logger.warn('[Monitor] 🚫 %s 买入前检查不通过 FDV=$%s LP=$%s，跳过',
            state.symbol, fFdv != null ? Math.round(fFdv) : '?', fLp != null ? Math.round(fLp) : '?');
        } else {
          await this._doBuy(state, price, reason, rsi, volume);
        }
      }
    } else if (signal === 'SELL' && state.inPosition) {
      await this._doSellExit(state, reason);
    }
  }

  // ── 交易执行 ────────────────────────────────────────────────────

  async _doBuy(state, price, reason, rsi, volume) {
    logger.info('[Monitor] 🟢 BUY %s @ %.8f | %s | DRY_RUN=%s', state.symbol, price, reason, DRY_RUN);
    state.inPosition = true;
    if (DRY_RUN) {
      const simulatedTokens = Math.floor(TRADE_SOL / price * 1e9);
      state.position = {
        entryPriceUsd: price, amountToken: simulatedTokens,
        solIn: TRADE_SOL, buyTxid: `DRY_${Date.now()}`, buyTime: Date.now(),
        entryRsi: rsi, entryBuyVol: volume?.buyVol ?? 0, entrySellVol: volume?.sellVol ?? 0,
      };
      state.tradeCount++;
      this._addTradeLog(state, { type: 'BUY', symbol: state.symbol, price, reason,
        txid: state.position.buyTxid, solIn: TRADE_SOL, dryRun: true,
        rsi, buyVol: volume?.buyVol ?? 0, sellVol: volume?.sellVol ?? 0 });
      this._createTradeRecord(state);
      logger.info('[Monitor] ✅ DRY_RUN BUY 模拟成功 %s @ %.8f  solIn=%.4f', state.symbol, price, TRADE_SOL);
    } else {
      try {
        const result = await trader.buy(state.address, state.symbol);
        state.position = {
          entryPriceUsd: price, amountToken: result.amountOut,
          solIn: result.solIn, buyTxid: result.txid, buyTime: Date.now(),
          entryRsi: rsi, entryBuyVol: volume?.buyVol ?? 0, entrySellVol: volume?.sellVol ?? 0,
        };
        state.tradeCount++;
        this._addTradeLog(state, { type: 'BUY', symbol: state.symbol, price, reason,
          txid: result.txid, solIn: result.solIn, rsi,
          buyVol: volume?.buyVol ?? 0, sellVol: volume?.sellVol ?? 0 });
        this._createTradeRecord(state);
        logger.info('[Monitor] ✅ BUY 成功 %s  solIn=%.4f SOL  txid=%s', state.symbol, result.solIn, result.txid);
      } catch (err) {
        logger.error('[Monitor] ❌ BUY 失败 %s: %s', state.symbol, err.message);
        state.inPosition = false;
        state._lastBuyCandle = -1;
      }
    }
  }

  async _doSellExit(state, reason) {
    if (state.exitSent) return;
    state.exitSent = true;
    logger.info('[Monitor] 🔴 SELL %s | %s | DRY_RUN=%s (第%d笔)', state.symbol, reason, DRY_RUN, state.tradeCount);

    if (DRY_RUN) {
      let currentPrice;
      try { currentPrice = await birdeye.getPrice(state.address); }
      catch (_) { currentPrice = state.ticks.length > 0 ? state.ticks[state.ticks.length - 1].price : state.position?.entryPriceUsd || 0; }
      const solIn  = state.position?.solIn ?? TRADE_SOL;
      const entryP = state.position?.entryPriceUsd ?? 0;
      const solOut = entryP > 0 ? solIn * (currentPrice / entryP) : 0;
      const pnlPct = entryP > 0 ? (currentPrice - entryP) / entryP * 100 : 0;
      const pnlSol = solOut - solIn;
      state.inPosition = false;
      this._addTradeLog(state, { type: 'SELL', symbol: state.symbol, price: currentPrice, reason,
        txid: `DRY_${Date.now()}`, solIn, solOut, pnlSol, dryRun: true,
        entryRsi: state.position?.entryRsi ?? null,
        entryBuyVol: state.position?.entryBuyVol ?? 0,
        entrySellVol: state.position?.entrySellVol ?? 0 });
      this._finalizeTradeRecord(state, reason, solOut, pnlPct, currentPrice);
      logger.info('[Monitor] ✅ DRY_RUN SELL %s  solIn=%.4f  solOut=%.4f  pnl=%+.4f SOL (%+.1f%%)',
        state.symbol, solIn, solOut, pnlSol, pnlPct);
    } else {
      let realtimeSellPrice = state.ticks.length > 0 ? state.ticks[state.ticks.length - 1].price : state.position?.entryPriceUsd || 0;
      try {
        const result = await trader.sell(state.address, state.symbol, state.position);
        const solOut = result.solOut ?? 0;
        const solIn  = state.position?.solIn ?? TRADE_SOL;
        const pnlPct = solIn > 0 ? (solOut - solIn) / solIn * 100 : 0;
        const pnlSol = solOut - solIn;
        state.inPosition = false;
        this._addTradeLog(state, { type: 'SELL', symbol: state.symbol, price: realtimeSellPrice,
          reason, txid: result.txid, solIn, solOut, pnlSol });
        this._finalizeTradeRecord(state, reason, solOut, pnlPct, realtimeSellPrice);
        logger.info('[Monitor] ✅ SELL 成功 %s  solIn=%.4f  solOut=%.4f  pnl=%+.4f SOL (%+.1f%%)  txid=%s',
          state.symbol, solIn, solOut, pnlSol, pnlPct, result.txid);
      } catch (err) {
        logger.error('[Monitor] ❌ SELL 失败 %s: %s', state.symbol, err.message);
        this._finalizeTradeRecord(state, `SELL_FAILED(${reason})`, 0, -100, 0);
      }
    }

    logger.info('[Monitor] ✅ %s 第%d笔完成，继续监控等待下一个信号', state.symbol, state.tradeCount);
    // 卖出后重置，继续监控
    state.exitSent   = false;
    state.shouldExit = false;
    state.position   = null;
    state._lastSellCandle = -1;
    state._cooldownUntil  = Date.now() + COOLDOWN_SEC * 1000;
    state._lastBuyCandle  = -1;
    logger.info('[Monitor] ⏳ %s 冷却 %ds，%s 后可再次买入',
      state.symbol, COOLDOWN_SEC, new Date(state._cooldownUntil).toLocaleTimeString());
  }

  // ── 辅助工具 ────────────────────────────────────────────────────

  _addTradeLog(state, log) {
    state.tradeLogs.push({ ...log, ts: Date.now() });
    if (state.tradeLogs.length > 200) state.tradeLogs.shift();
    wsHub.broadcast({ type: 'trade_log', ...log, ts: Date.now() });
    this.emit('trade', log);
  }

  _createTradeRecord(state) {
    if (!state.position) return;
    const rec = {
      id: `${state.address}_${state.tradeCount}_${Date.now()}`,
      address: state.address, symbol: state.symbol,
      buyAt: state.position.buyTime, buyTxid: state.position.buyTxid,
      entryPrice: state.position.entryPriceUsd,
      entryRsi: state.position.entryRsi ?? null,
      entryBuyVol: state.position.entryBuyVol ?? 0,
      entrySellVol: state.position.entrySellVol ?? 0,
      entryFdv: state.latestFdv, entryLp: state.latestLp,
      solIn: state.position.solIn, dryRun: DRY_RUN,
      exitAt: null, exitReason: null, exitPrice: null,
      solOut: null, pnlPct: null, pnlSol: null,
    };
    state.tradeRecords.push(rec);
    _allTradeRecords.unshift(rec);
    dataStore.appendTrade(rec);
    const cutoff = Date.now() - 24 * 3600 * 1000;
    while (_allTradeRecords.length && _allTradeRecords[_allTradeRecords.length - 1].buyAt < cutoff) _allTradeRecords.pop();
    wsHub.broadcast({ type: 'trade_record', ...rec });
  }

  _finalizeTradeRecord(state, reason, solOut, pnlPct, exitPrice) {
    const rec = state.tradeRecords[state.tradeRecords.length - 1];
    if (!rec) return;
    rec.exitAt    = Date.now();
    rec.exitReason = reason;
    rec.exitPrice  = exitPrice ?? null;
    rec.solOut     = parseFloat(solOut.toFixed(6));
    rec.pnlPct     = parseFloat(pnlPct.toFixed(2));
    rec.pnlSol     = parseFloat((solOut - (state.position?.solIn ?? 0)).toFixed(6));
    dataStore.updateTrade(rec.id, { exitAt: rec.exitAt, exitReason: rec.exitReason, solOut: rec.solOut, pnlPct: rec.pnlPct, pnlSol: rec.pnlSol });
    wsHub.broadcast({ type: 'trade_record', ...rec });
  }

  _stateSnapshot(state) {
    return {
      address: state.address, symbol: state.symbol,
      addedAt: state.addedAt, expiresAt: state.expiresAt,
      inPosition: state.inPosition, tradeCount: state.tradeCount,
      shouldExit: state.shouldExit, tradeLogs: state.tradeLogs,
      tradeRecords: state.tradeRecords, dryRun: DRY_RUN,
    };
  }

  _broadcastTokenList() {
    wsHub.broadcast({ type: 'token_list', tokens: this.getTokens() });
  }
}

function getAllTradeRecords() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const memRecords = _allTradeRecords.filter(r => r.buyAt > cutoff);
  if (memRecords.length === 0) return dataStore.loadTrades().filter(r => r.buyAt > cutoff);
  return memRecords;
}

const monitor = new TokenMonitor();
module.exports = monitor;
module.exports.getAllTradeRecords = getAllTradeRecords;
module.exports.DRY_RUN = DRY_RUN;
