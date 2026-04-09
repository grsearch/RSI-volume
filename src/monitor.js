'use strict';
// src/monitor.js — 核心监控引擎 V2
//
// 新增：
//   1. 量能过滤（VOL_MULT / VOL_BUY_RATIO / VOL_EXIT_CONSECUTIVE）
//   2. DRY_RUN 空跑模式（不实际交易，用 Birdeye 价格模拟盈亏）
//   3. 数据持久化（tick / trade / signal 写入磁盘）
//   4. 15秒K线 + RSI(7)

const EventEmitter = require('events');
const { evaluateSignal, buildCandles } = require('./rsi');
const trader    = require('./trader');
const birdeye   = require('./birdeye');
const logger    = require('./logger');
const wsHub     = require('./wsHub');
const dataStore = require('./dataStore');
const heliusWs  = require('./heliusWs');

const MONITOR_MINUTES = parseInt(process.env.TOKEN_MAX_AGE_MINUTES || '60', 10);  // 监控时长60分钟
const FDV_EXIT        = parseFloat(process.env.FDV_EXIT_USD        || '10000'); // FDV低于此值立即退出监控
const LP_EXIT         = parseFloat(process.env.LP_EXIT_USD         || '5000');  // LP低于此值立即退出监控
const POLL_SEC        = parseInt(process.env.PRICE_POLL_SEC        || '1',  10);  // 1秒轮询，保证止损响应速度
const KLINE_SEC       = parseInt(process.env.KLINE_INTERVAL_SEC    || '15', 10);  // 15秒K线
const DRY_RUN         = (process.env.DRY_RUN ?? 'true') !== 'false';  // 기본값 true=공매도 안전
const TRADE_SOL       = parseFloat(process.env.TRADE_SIZE_SOL      || '0.2');

// 全局交易记录
const _allTradeRecords = [];

// 启动时加载持久化的交易记录
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
    this._tokens   = new Map();
    this._pollTimer = null;
    this._started  = false;
  }

  start() {
    if (this._started) return;
    this._started = true;

    // 初始化数据存储
    dataStore.init();
    _loadPersistedTrades();
    dataStore.startFlush();

    // 启动 Helius WebSocket（链上交易数据）
    heliusWs.start();

    this._scheduleNextPoll();
    logger.info('[Monitor] 启动 | 轮询=%ds K线=%ds DRY_RUN=%s HeliusWS=%s',
      POLL_SEC, KLINE_SEC, DRY_RUN, heliusWs.isConnected() ? '已连接' : '连接中');

    if (!DRY_RUN) {
      const hasWallet = !!process.env.WALLET_PRIVATE_KEY;
      const hasJupKey = !!process.env.JUPITER_API_KEY;
      const hasHelius = !!(process.env.HELIUS_WSS_URL || process.env.HELIUS_API_KEY || process.env.HELIUS_RPC_URL);
      logger.info('[Monitor] 实盘检查 | 钱包=%s  JupiterKey=%s  Helius量能=%s',
        hasWallet ? '✅已配置' : '❌未配置(必填)',
        hasJupKey ? '✅已配置' : '⚠️未配置(可能失败)',
        hasHelius ? '✅已配置' : '⚠️未配置(量能退化为VOL_OFF)');
      if (!hasWallet) {
        logger.error('[Monitor] ❌ 实盘模式必须配置 WALLET_PRIVATE_KEY，否则无法成交！');
      }
    }
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
      fdv           : meta.fdv ?? null,
      lp            : meta.lp  ?? null,
      addedAt       : now,
      expiresAt     : now + MONITOR_MINUTES * 60 * 1000,
      ticks         : [],
      latestFdv          : null,
      latestLp           : null,
      tokenPriceSol      : null,  // 이 token의 최신 체인 SOL 가격 (token별 관리, 오염 없음)
      inPosition    : false,
      position      : null,
      tradeCount    : 0,
      shouldExit    : false,
      exitSent      : false,
      tradeLogs     : [],
      tradeRecords  : [],
      _prevRsiRealtime: NaN,
      _prevRsiTs      : 0,
      _lastBuyCandle  : -1,
      _lastSellCandle : -1,
    };

    this._tokens.set(address, state);

    // 订阅链上交易数据（Helius WebSocket）
    heliusWs.subscribe(address, symbol, (trade) => {
      this._onChainTrade(address, trade);
    });

    logger.info('[Monitor] ➕ 开始监控 %s (%s)，到期 %s | DRY_RUN=%s',
      symbol, address,
      new Date(state.expiresAt).toLocaleTimeString(),
      DRY_RUN);
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

    // 刷盘该 token 的 tick 数据
    dataStore.flushTicks();

    // 取消链上交易订阅
    heliusWs.unsubscribe(address);

    this._tokens.delete(address);
    birdeye.clearCache(address);
    this._broadcastTokenList();
  }

  getTokens() {
    return Array.from(this._tokens.values()).map(s => this._stateSnapshot(s));
  }

  getToken(address) {
    const s = this._tokens.get(address);
    return s ? this._stateSnapshot(s) : null;
  }

  // ── Helius 链上交易回调 ──────────────────────────────────────

  _onChainTrade(address, trade) {
    const state = this._tokens.get(address);
    if (!state || state.exitSent) return;

    const now = Date.now();

    // FIX: 链上价格是 SOL 计价，state.ticks 是 USD 计价（Birdeye），
    //      不可混用——否则 K 线价格随机在 USD/SOL 之间跳动，RSI 完全错误。
    //      链上数据只写入独立的 chainTrades 队列，专用于量能统计。
    if (!state.chainTrades) state.chainTrades = [];
    state.chainTrades.push({
      ts       : trade.ts || now,
      solAmount: trade.solAmount,
      isBuy    : trade.isBuy,
    });

    // 이 token 전용 SOL 가격 업데이트 (다른 token에 의한 오염 없음)
    if (trade.priceSol > 0) {
      state.tokenPriceSol = trade.priceSol;
    }

    // 只保留最近 5 分钟（防止内存增长）
    const cutoff5m = now - 5 * 60 * 1000;
    while (state.chainTrades.length > 0 && state.chainTrades[0].ts < cutoff5m) {
      state.chainTrades.shift();
    }

    // 持久化（保留完整数据供回测）
    dataStore.appendTick(address, {
      price    : trade.priceSol,
      ts       : trade.ts || now,
      symbol   : state.symbol,
      signature: trade.signature,
      owner    : trade.owner,
      solAmount: trade.solAmount,
      isBuy    : trade.isBuy,
      source   : 'helius',
    });

    // ── 链上成交触发止损（毫秒级，纯SOL计价，无延迟）────────────
    if (state.inPosition && !state.exitSent && trade.priceSol > 0) {
      // 方案A：用本 token 的 SOL 价格（最快，无 Birdeye 延迟）
      if (state.position?.entryPriceSol) {
        const pnl = (trade.priceSol - state.position.entryPriceSol)
                  / state.position.entryPriceSol * 100;
        if (pnl <= STOP_LOSS_PCT) {
          logger.warn('[Monitor] ⚡ %s SOL止损 %.10f→%.10f pnl=%.1f%%',
            state.symbol, state.position.entryPriceSol, trade.priceSol, pnl);
          setImmediate(() => this._doSellExit(state,
            `STOP_LOSS(${pnl.toFixed(1)}%≤${STOP_LOSS_PCT}%)`));
          return;
        }
      // 方案B：SOL入场价未记录，改用最新 Birdeye USD（备用）
      } else if (state.position?.entryPriceUsd) {
        const latestUsd = state.ticks.length > 0
          ? state.ticks[state.ticks.length - 1].price : null;
        if (latestUsd && latestUsd > 0) {
          const pnl = (latestUsd - state.position.entryPriceUsd)
                    / state.position.entryPriceUsd * 100;
          if (pnl <= STOP_LOSS_PCT) {
            logger.warn('[Monitor] ⚡ %s USD止损(备用) %.8f→%.8f pnl=%.1f%%',
              state.symbol, state.position.entryPriceUsd, latestUsd, pnl);
            setImmediate(() => this._doSellExit(state,
              `STOP_LOSS(${pnl.toFixed(1)}%≤${STOP_LOSS_PCT}%)`));
            return;
          }
        }
      }
    }

    logger.debug('[HeliusTrade] %s %s %.4f SOL @ %.10f (%s)',
      state.symbol,
      trade.isBuy ? 'BUY' : 'SELL',
      trade.solAmount,
      trade.priceSol,
      trade.signature?.slice(0, 12) || '?');
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
    if (now >= state.expiresAt) {
      await this.removeToken(address, 'EXPIRED');
      return;
    }

    // 2. FDV/LP 检查（仍用 Birdeye USD，30秒缓存）
    const { fdv, lp } = await birdeye.getFdv(address).catch(() => ({ fdv: null, lp: null }));
    if (Number.isFinite(fdv) && FDV_EXIT > 0 && fdv < FDV_EXIT) {
      logger.warn('[Monitor] %s FDV=$%s < $%s，退出', state.symbol, Math.round(fdv), FDV_EXIT);
      await this.removeToken(address, `FDV_TOO_LOW($${Math.round(fdv)})`);
      return;
    }
    if (Number.isFinite(lp) && LP_EXIT > 0 && lp < LP_EXIT) {
      logger.warn('[Monitor] %s LP=$%s < $%s，退出', state.symbol, Math.round(lp), LP_EXIT);
      await this.removeToken(address, `LP_TOO_LOW($${Math.round(lp)})`);
      return;
    }
    if (Number.isFinite(fdv)) state.latestFdv = fdv;
    if (Number.isFinite(lp))  state.latestLp  = lp;

    // 3. 用链上 SOL 价格构建 ticks
    const price = state.tokenPriceSol;
    if (!price || price <= 0) {
      logger.debug('[Monitor] %s 等待链上价格...', state.symbol);
      return;
    }

    // 3b. 轮询止损检查（补充链上回调可能遗漏的情况）
    if (state.inPosition && !state.exitSent && state.position?.entryPriceSol) {
      const pnl = (price - state.position.entryPriceSol)
                / state.position.entryPriceSol * 100;
      if (pnl <= STOP_LOSS_PCT) {
        logger.warn('[Monitor] 🛑 %s 轮询止损 %.10f→%.10f pnl=%.1f%%',
          state.symbol, state.position.entryPriceSol, price, pnl);
        await this._doSellExit(state, `STOP_LOSS(${pnl.toFixed(1)}%≤${STOP_LOSS_PCT}%)`);
        return;
      }
    }

    const tick = { price, ts: now };
    state.ticks.push(tick);

    // 只保留最近 30 分钟的 ticks
    const cutoff = now - 30 * 60 * 1000;
    while (state.ticks.length > 0 && state.ticks[0].ts < cutoff) state.ticks.shift();

    // 4. 聚合K线（SOL 价格 ticks → OHLCV）
    const { closed: closedCandles, current: currentCandle } = buildCandles(state.ticks, KLINE_SEC);

    // 4b. 当前 K 线存入 state
    state._currentCandle = currentCandle || null;

    // 5. RSI + 量能信号评估
    const realtimePrice = currentCandle ? currentCandle.close : price;
    const { rsi, prevRsi, signal, reason, volume } = evaluateSignal(closedCandles, realtimePrice, state);

    // 6. 记录信号
    if (reason && reason !== '' && reason !== 'rsi_rebase') {
      dataStore.appendSignal({
        ts: now,
        address,
        symbol: state.symbol,
        price,
        rsi: Number.isFinite(rsi) ? parseFloat(rsi.toFixed(2)) : null,
        prevRsi: Number.isFinite(prevRsi) ? parseFloat(prevRsi.toFixed(2)) : null,
        signal,
        reason,
        volume,
        inPosition: state.inPosition,
      });
    }

    // 8. 广播实时数据
    wsHub.broadcast({
      type    : 'tick',
      address,
      symbol  : state.symbol,
      price,
      fdv     : state.latestFdv,
      lp      : state.latestLp,
      addedAt : state.addedAt,
      rsi     : Number.isFinite(rsi) ? parseFloat(rsi.toFixed(2)) : null,
      prevRsi : Number.isFinite(prevRsi) ? parseFloat(prevRsi.toFixed(2)) : null,
      signal,
      reason,
      closedCount: closedCandles.length,
      inPosition : state.inPosition,
      volume,
      dryRun  : DRY_RUN,
      ts      : now,
    });

    logger.debug('[RSI] %s price=%.6f rsi=%.2f prev=%.2f signal=%s reason=%s vol=%s',
      state.symbol, price, rsi, prevRsi, signal || 'none', reason,
      volume ? `${(volume.volMult || 0).toFixed(1)}x` : '-');

    // 9. 执行信号
    if (signal === 'BUY' && !state.inPosition && !state.shouldExit) {
      // 检查冷却期
      if (state._cooldownUntil && Date.now() < state._cooldownUntil) {
        const remain = Math.ceil((state._cooldownUntil - Date.now()) / 1000);
        logger.debug('[Monitor] %s 冷却中，还剩 %ds', state.symbol, remain);
      } else {
        // 买入前强制刷新 FDV/LP（仅 USD，不拉价格）
        birdeye.clearCache(address);
        const { fdv: freshFdv, lp: freshLp } = await birdeye.getFdv(address).catch(() => ({ fdv: null, lp: null }));
        if (freshFdv !== null) state.latestFdv = freshFdv;
        if (freshLp  !== null) state.latestLp  = freshLp;

        const fdvFail = Number.isFinite(freshFdv) && FDV_EXIT > 0 && freshFdv < FDV_EXIT;
        const lpFail  = Number.isFinite(freshLp)  && LP_EXIT  > 0 && freshLp  < LP_EXIT;
        if (fdvFail || lpFail) {
          logger.warn('[Monitor] 🚫 %s 买入前检查不通过: FDV=$%s LP=$%s，跳过买入',
            state.symbol,
            freshFdv != null ? Math.round(freshFdv) : '?',
            freshLp  != null ? Math.round(freshLp)  : '?');
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
    // 가격 유효성 검사
    if (!price || price <= 0 || !Number.isFinite(price)) {
      logger.warn('[Monitor] ⚠️ %s 买入价格无效(%s)，跳过', state.symbol, price);
      return;
    }
    logger.info('[Monitor] 🟢 BUY %s @ %s | %s | DRY_RUN=%s', state.symbol, price.toExponential(6), reason, DRY_RUN);
    state.inPosition = true;

    if (DRY_RUN) {
      // 空跑模式：模拟买入
      const simulatedTokens = Math.floor(TRADE_SOL / price * 1e9); // 模拟 token 数量
      state.position = {
        entryPriceSol : price,           // SOL 计价入场价
        entryPriceUsd : null,            // 不再使用 USD 计价
        amountToken   : simulatedTokens,
        solIn         : TRADE_SOL,
        buyTxid       : `DRY_${Date.now()}`,
        buyTime       : Date.now(),
        entryRsi      : rsi,
        entryBuyVol   : volume?.buyVol  ?? 0,
        entrySellVol  : volume?.sellVol ?? 0,
      };
      state.tradeCount++;
      this._addTradeLog(state, { type: 'BUY', symbol: state.symbol, price, reason,
        txid: state.position.buyTxid, solIn: TRADE_SOL, dryRun: true,
        rsi, buyVol: volume?.buyVol ?? 0, sellVol: volume?.sellVol ?? 0 });
      this._createTradeRecord(state);
      logger.info('[Monitor] ✅ DRY_RUN BUY 模拟成功 %s @ %s  solIn=%s', state.symbol, price.toExponential(6), TRADE_SOL);
    } else {
      try {
        const result = await trader.buy(state.address, state.symbol);
        state.position = {
          entryPriceSol : price,           // SOL 计价入场价
          entryPriceUsd : null,
          amountToken   : result.amountOut,
          solIn         : result.solIn,
          buyTxid       : result.txid,
          buyTime       : Date.now(),
        };
        state.tradeCount++;
        state.position.entryRsi     = rsi;
        state.position.entryBuyVol  = volume?.buyVol  ?? 0;
        state.position.entrySellVol = volume?.sellVol ?? 0;
        this._addTradeLog(state, { type: 'BUY', symbol: state.symbol, price, reason,
          txid: result.txid, solIn: result.solIn,
          rsi, buyVol: volume?.buyVol ?? 0, sellVol: volume?.sellVol ?? 0 });
        this._createTradeRecord(state);
        logger.info('[Monitor] ✅ BUY 成功 %s  solIn=%.4f SOL  txid=%s', state.symbol, result.solIn, result.txid);
      } catch (err) {
        logger.error('[Monitor] ❌ BUY 失败 %s: %s', state.symbol, err.message);
        logger.error('[Monitor]    请检查: WALLET_PRIVATE_KEY / JUPITER_API_KEY / 钱包余额');
        state.inPosition = false;
        state._lastBuyCandle = -1;
        // 失败也记录到交易日志，方便 Dashboard 可见
        this._addTradeLog(state, { type: 'BUY', symbol: state.symbol, price, reason,
          txid: 'FAILED', solIn: TRADE_SOL, dryRun: false,
          error: err.message.slice(0, 80) });
      }
    }
  }

  async _doSellExit(state, reason) {
    if (state.exitSent) return;  // 防止同一笔卖单并发重入
    state.exitSent = true;

    logger.info('[Monitor] 🔴 SELL %s | %s | DRY_RUN=%s (第%d笔)', state.symbol, reason, DRY_RUN, state.tradeCount);

    if (DRY_RUN) {
      // 空跑模式：用最新链上 SOL 价格计算模拟盈亏
      if (!state.position) {
        logger.warn('[Monitor] %s DRY_RUN SELL 时 position 已为 null，跳过', state.symbol);
        state.exitSent = false;
        return;
      }
      const currentPrice = state.tokenPriceSol
        ?? (state.ticks.length > 0 ? state.ticks[state.ticks.length - 1].price : 0);

      const solIn   = state.position.solIn ?? TRADE_SOL;
      const entryP  = state.position.entryPriceSol ?? 0;
      // 유효성 검사: 비율이 너무 이상하면 0으로
      const ratio   = (entryP > 0 && currentPrice > 0) ? currentPrice / entryP : 0;
      // 비율이 0.001 ~ 1000 범위를 벗어나면 데이터 오류로 간주
      const validRatio = ratio > 0.001 && ratio < 1000;
      const solOut  = validRatio ? solIn * ratio : 0;
      const pnlPct  = entryP > 0 ? (currentPrice - entryP) / entryP * 100 : 0;
      const pnlSol  = solOut - solIn;
      if (!validRatio) {
        logger.warn('[Monitor] ⚠️ %s DRY_RUN 盈亏计算比例异常(%.6f)，solOut置0', state.symbol, ratio);
      }

      state.inPosition = false;
      this._addTradeLog(state, { type: 'SELL', symbol: state.symbol, price: currentPrice, reason,
        txid: `DRY_${Date.now()}`, solIn, solOut, pnlSol, dryRun: true,
        entryRsi: state.position?.entryRsi ?? null,
        entryBuyVol: state.position?.entryBuyVol ?? 0,
        entrySellVol: state.position?.entrySellVol ?? 0 });
      this._finalizeTradeRecord(state, reason, solOut, pnlPct, currentPrice);

      logger.info('[Monitor] ✅ DRY_RUN SELL %s  solIn=%s  solOut=%s  pnl=%s SOL (%s%)',
        state.symbol, solIn.toFixed(4), solOut.toFixed(4), pnlSol.toFixed(4), pnlPct.toFixed(1));
    } else {
      let realtimeSellPrice = state.tokenPriceSol
        ?? (state.ticks.length > 0 ? state.ticks[state.ticks.length - 1].price : 0);
      try {
        const result = await trader.sell(state.address, state.symbol, state.position);
        const solOut  = result.solOut ?? 0;
        const solIn   = state.position?.solIn ?? TRADE_SOL;
        const pnlPct  = solIn > 0 ? (solOut - solIn) / solIn * 100 : 0;
        const pnlSol  = solOut - solIn;

        state.inPosition = false;
        this._addTradeLog(state, { type: 'SELL', symbol: state.symbol, price: realtimeSellPrice,
          reason, txid: result.txid, solIn, solOut, pnlSol });
        this._finalizeTradeRecord(state, reason, solOut, pnlPct, realtimeSellPrice);

        logger.info('[Monitor] ✅ SELL 成功 %s  solIn=%.4f  solOut=%.4f  pnl=%+.4f SOL (%+.1f%%)  txid=%s',
          state.symbol, solIn, solOut, pnlSol, pnlPct, result.txid);
      } catch (err) {
        logger.error('[Monitor] ❌ SELL 失败 %s: %s', state.symbol, err.message);
        this._finalizeTradeRecord(state, `SELL_FAILED(${reason})`, 0, -100);
      }
    }

    logger.info('[Monitor] ✅ %s 第%d笔完成，继续监控等待下一个信号', state.symbol, state.tradeCount);

    // 多次交易：卖出后重置状态，继续监控，不退出
    state.exitSent   = false;
    state.shouldExit = false;
    state.position   = null;
    state._lastSellCandle = -1;

    // 冷却期：卖出后至少等 60 秒再允许下一笔买入
    const COOLDOWN_MS = parseInt(process.env.TRADE_COOLDOWN_SEC || '60', 10) * 1000;
    state._lastBuyCandle  = -1;
    state._cooldownUntil  = Date.now() + COOLDOWN_MS;
    logger.info('[Monitor] ⏳ %s 冷却 %ds，%s 后可再次买入',
      state.symbol, COOLDOWN_MS / 1000,
      new Date(state._cooldownUntil).toLocaleTimeString());
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
      id         : `${state.address}_${state.tradeCount}_${Date.now()}`,
      address    : state.address,
      symbol     : state.symbol,
      buyAt      : state.position.buyTime,
      buyTxid    : state.position.buyTxid,
      entryPrice   : state.position.entryPriceSol ?? null,  // SOL 计价
      entryRsi     : state.position.entryRsi   ?? null,
      entryBuyVol  : state.position.entryBuyVol  ?? 0,
      entrySellVol : state.position.entrySellVol ?? 0,
      entryFdv   : state.fdv,
      entryLp    : state.lp,
      solIn      : state.position.solIn,
      dryRun     : DRY_RUN,
      exitAt     : null,
      exitReason : null,
      solOut     : null,
      pnlPct     : null,
      pnlSol     : null,
    };
    state.tradeRecords.push(rec);
    _allTradeRecords.unshift(rec);

    // 持久化
    dataStore.appendTrade(rec);

    // 只保留 24h 内
    const cutoff = Date.now() - 24 * 3600 * 1000;
    while (_allTradeRecords.length && _allTradeRecords[_allTradeRecords.length - 1].buyAt < cutoff) {
      _allTradeRecords.pop();
    }
    wsHub.broadcast({ type: 'trade_record', ...rec });
  }

  _finalizeTradeRecord(state, reason, solOut, pnlPct, exitPrice) {
    const rec = state.tradeRecords[state.tradeRecords.length - 1];
    if (!rec) return;
    rec.exitAt     = Date.now();
    rec.exitReason = reason;
    rec.exitPrice  = exitPrice ?? null;
    rec.solOut     = parseFloat(solOut.toFixed(6));
    rec.pnlPct     = parseFloat(pnlPct.toFixed(2));
    rec.pnlSol     = parseFloat((solOut - (state.position?.solIn ?? 0)).toFixed(6));

    // 更新持久化
    dataStore.updateTrade(rec.id, {
      exitAt: rec.exitAt,
      exitReason: rec.exitReason,
      solOut: rec.solOut,
      pnlPct: rec.pnlPct,
      pnlSol: rec.pnlSol,
    });

    wsHub.broadcast({ type: 'trade_record', ...rec });
  }

  _stateSnapshot(state) {
    return {
      address    : state.address,
      symbol     : state.symbol,
      addedAt    : state.addedAt,
      expiresAt  : state.expiresAt,
      inPosition : state.inPosition,
      tradeCount : state.tradeCount,
      shouldExit : state.shouldExit,
      tradeLogs  : state.tradeLogs,
      tradeRecords: state.tradeRecords,
      dryRun     : DRY_RUN,
    };
  }

  _broadcastTokenList() {
    wsHub.broadcast({ type: 'token_list', tokens: this.getTokens() });
  }
}

function getAllTradeRecords() {
  // 合并内存和磁盘数据
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const memRecords = _allTradeRecords.filter(r => r.buyAt > cutoff);

  // 如果内存为空，从磁盘加载
  if (memRecords.length === 0) {
    const diskRecords = dataStore.loadTrades().filter(r => r.buyAt > cutoff);
    return diskRecords;
  }
  return memRecords;
}

const monitor = new TokenMonitor();
module.exports = monitor;
module.exports.getAllTradeRecords = getAllTradeRecords;
module.exports.DRY_RUN = DRY_RUN;
