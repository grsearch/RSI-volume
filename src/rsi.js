'use strict';
// src/rsi.js — RSI 计算 + 量能过滤 + BUY/SELL 信号逻辑
//
// 策略（5秒K线 + 1秒轮询）：
//   BUY : RSI(7) ≤ 35 + 过去15秒 buyVolume > sellVolume × 1.1
//   SELL: 过去15秒 sellVolume > buyVolume × 1.1
//
// 量能数据来源：Helius Enhanced WebSocket（链上真实成交）
// 无链上数据时：拒绝买入，不退化为纯RSI

const RSI_PERIOD      = parseInt(process.env.RSI_PERIOD          || '7',  10);
const RSI_BUY         = parseFloat(process.env.RSI_BUY_LEVEL     || '30');
const RSI_SELL        = parseFloat(process.env.RSI_SELL_LEVEL     || '70');
const RSI_PANIC       = parseFloat(process.env.RSI_PANIC_LEVEL    || '80');
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT    || '50');
const STOP_LOSS_PCT   = parseFloat(process.env.STOP_LOSS_PCT      || '-10');
const KLINE_SEC       = parseInt(process.env.KLINE_INTERVAL_SEC   || '5',  10);
const VOL_WIN_SEC     = parseInt(process.env.VOL_WINDOW_SEC       || '15', 10);
const SKIP_FIRST      = parseInt(process.env.SKIP_FIRST_CANDLES   || '3',  10);
const MIN_BUY_VOL     = parseFloat(process.env.MIN_BUY_VOL_SOL    || '2.0'); // 窗口内buyVolume至少2 SOL
// 量能萎缩出场参数
const VOL_EXIT_CONSECUTIVE = parseInt(process.env.VOL_EXIT_CONSECUTIVE || '4',   10); // 连续4根（20秒）才触发
const VOL_EXIT_RATIO       = parseFloat(process.env.VOL_EXIT_RATIO     || '0.5');     // 低于均量50%才算萎缩
const VOL_EXIT_LOOKBACK    = parseInt(process.env.VOL_EXIT_LOOKBACK    || '6',   10); // 用6根K线算均量

// ── Wilder RSI 计算 ──────────────────────────────────────────────

function calcRSIWithState(closes, period) {
  period = period || RSI_PERIOD;
  const rsiArray = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return { rsiArray, avgGain: NaN, avgLoss: NaN };

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsiArray[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsiArray[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return { rsiArray, avgGain, avgLoss };
}

function stepRSI(avgGain, avgLoss, lastClose, newPrice, period) {
  period = period || RSI_PERIOD;
  if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) return NaN;
  const diff = newPrice - lastClose;
  const gain = diff > 0 ? diff : 0;
  const loss = diff < 0 ? Math.abs(diff) : 0;
  const ag = (avgGain * (period - 1) + gain) / period;
  const al = (avgLoss * (period - 1) + loss) / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

// ── 量能统计 ─────────────────────────────────────────────────────

function getVolume(candles) {
  let buy = 0, sell = 0;
  for (const c of candles) {
    buy  += (c.buyVolume  || 0);
    sell += (c.sellVolume || 0);
  }
  return { buy, sell, total: buy + sell };
}

function getWindowCandles(closedCandles, currentCandle, windowSec) {
  const bars = Math.max(1, Math.ceil(windowSec / KLINE_SEC));
  const all  = currentCandle ? [...closedCandles, currentCandle] : [...closedCandles];
  return all.slice(-bars);
}

// ── 主信号函数 ───────────────────────────────────────────────────

function evaluateSignal(closedCandles, realtimePrice, tokenState) {

  // 预热
  if (!closedCandles || closedCandles.length < RSI_PERIOD + 2) {
    return { rsi: NaN, prevRsi: NaN, signal: null, reason: 'warming_up', volume: {} };
  }

  // 跳过前N根K线
  if (closedCandles.length < SKIP_FIRST) {
    return { rsi: NaN, prevRsi: NaN, signal: null,
             reason: `skip_first(${closedCandles.length}/${SKIP_FIRST})`, volume: {} };
  }

  const closes = closedCandles.map(c => c.close);
  const len    = closes.length;
  const { rsiArray, avgGain, avgLoss } = calcRSIWithState(closes, RSI_PERIOD);
  const lastClosedRsi = rsiArray[len - 1];
  const lastClose     = closes[len - 1];
  const rsiNow        = stepRSI(avgGain, avgLoss, lastClose, realtimePrice, RSI_PERIOD);

  if (!Number.isFinite(lastClosedRsi) || !Number.isFinite(rsiNow)) {
    return { rsi: NaN, prevRsi: NaN, signal: null, reason: 'rsi_nan', volume: {} };
  }

  const nowMs        = Date.now();
  const lastCandleTs = closedCandles[len - 1].openTime;
  const prevRsiRaw   = tokenState._prevRsiRealtime;
  const isStale      = !Number.isFinite(prevRsiRaw) || (nowMs - (tokenState._prevRsiTs || 0)) > 10000;
  const prevRsi      = isStale ? lastClosedRsi : prevRsiRaw;

  const updateState = () => {
    tokenState._prevRsiRealtime = rsiNow;
    tokenState._prevRsiTs       = nowMs;
  };

  const currentCandle = tokenState._currentCandle || null;

  // 量能窗口（用于广播）
  const winCandles = getWindowCandles(closedCandles, currentCandle, VOL_WIN_SEC);
  const winVol     = getVolume(winCandles);
  const volumeInfo = {
    buyVol   : winVol.buy,
    sellVol  : winVol.sell,
    buyRatio : winVol.total > 0 ? winVol.buy / winVol.total : 0,
    windowSec: VOL_WIN_SEC,
  };

  // ── SELL（持仓中，优先级从高到低） ─────────────────────────────
  if (tokenState.inPosition) {
    const lastSell = tokenState._lastSellCandle || -1;

    // 1. RSI > 80 恐慌卖
    if (rsiNow > RSI_PANIC && lastCandleTs !== lastSell) {
      tokenState._lastSellCandle = lastCandleTs;
      updateState();
      return { rsi: rsiNow, prevRsi, signal: 'SELL',
               reason: `RSI_PANIC(${rsiNow.toFixed(1)}>${RSI_PANIC})`, volume: volumeInfo };
    }

    // 2. RSI 下穿 70
    if (prevRsi >= RSI_SELL && rsiNow < RSI_SELL && lastCandleTs !== lastSell) {
      tokenState._lastSellCandle = lastCandleTs;
      updateState();
      return { rsi: rsiNow, prevRsi, signal: 'SELL',
               reason: `RSI_CROSS_DOWN_70(${prevRsi.toFixed(1)}→${rsiNow.toFixed(1)})`, volume: volumeInfo };
    }

    // 3. 止盈 / 止损
    if (tokenState.position && tokenState.position.entryPriceUsd) {
      const pnl = (realtimePrice - tokenState.position.entryPriceUsd)
                / tokenState.position.entryPriceUsd * 100;
      if (pnl >= TAKE_PROFIT_PCT) {
        updateState();
        return { rsi: rsiNow, prevRsi, signal: 'SELL',
                 reason: `TAKE_PROFIT(+${pnl.toFixed(1)}%≥${TAKE_PROFIT_PCT}%)`, volume: volumeInfo };
      }
      if (pnl <= STOP_LOSS_PCT) {
        updateState();
        return { rsi: rsiNow, prevRsi, signal: 'SELL',
                 reason: `STOP_LOSS(${pnl.toFixed(1)}%≤${STOP_LOSS_PCT}%)`, volume: volumeInfo };
      }
    }

    // 4. 量能萎缩出场
    if (closedCandles.length >= VOL_EXIT_LOOKBACK + VOL_EXIT_CONSECUTIVE) {
      const avgEnd   = closedCandles.length - VOL_EXIT_CONSECUTIVE;
      const avgStart = Math.max(0, avgEnd - VOL_EXIT_LOOKBACK);
      const avgVol   = closedCandles.slice(avgStart, avgEnd)
                         .reduce((s, c) => s + (c.volume || 0), 0) / VOL_EXIT_LOOKBACK;
      if (avgVol > 0) {
        const recent    = closedCandles.slice(-VOL_EXIT_CONSECUTIVE);
        const allDecayed = recent.every(c => (c.volume || 0) < avgVol * VOL_EXIT_RATIO);
        if (allDecayed) {
          updateState();
          const vols = recent.map(c => (c.volume || 0).toFixed(0)).join(',');
          return { rsi: rsiNow, prevRsi, signal: 'SELL',
                   reason: `VOL_DECAY([${vols}]<avg=${avgVol.toFixed(0)})`, volume: volumeInfo };
        }
      }
    }
  }

  // ── BUY：RSI ≤ 35 + 过去15秒 buyVolume > sellVolume × 1.1 ───
  if (!tokenState.inPosition
      && rsiNow <= RSI_BUY
      && lastCandleTs !== (tokenState._lastBuyCandle || -1)) {

    const bv = getVolume(getWindowCandles(closedCandles, currentCandle, VOL_WIN_SEC));

    // 无链上数据 → 拒绝
    if (bv.total === 0) {
      updateState();
      return { rsi: rsiNow, prevRsi, signal: null,
               reason: `RSI_OK(${rsiNow.toFixed(1)})+VOL_NO_DATA`, volume: volumeInfo };
    }

    // buyVolume 不足最小门槛 → 拒绝
    if (bv.buy < MIN_BUY_VOL) {
      updateState();
      return { rsi: rsiNow, prevRsi, signal: null,
               reason: `RSI_OK+BUY_VOL_LOW(${bv.buy.toFixed(2)}<${MIN_BUY_VOL}SOL)`, volume: volumeInfo };
    }

    // buy > sell × 1.1
    if (bv.buy > bv.sell * 1.1) {
      tokenState._lastBuyCandle = lastCandleTs;
      updateState();
      return {
        rsi: rsiNow, prevRsi, signal: 'BUY',
        reason: `RSI(${rsiNow.toFixed(1)}≤${RSI_BUY})+BUY>${MIN_BUY_VOL}SOL+BUY>SELL×1.1(${bv.buy.toFixed(2)}>${(bv.sell*1.1).toFixed(2)},${VOL_WIN_SEC}s)`,
        volume: volumeInfo,
      };
    }

    updateState();
    return { rsi: rsiNow, prevRsi, signal: null,
             reason: `RSI_OK+BUY≤SELL×1.1(buy=${bv.buy.toFixed(2)},sell×1.1=${(bv.sell*1.1).toFixed(2)})`,
             volume: volumeInfo };
  }

  updateState();
  return { rsi: rsiNow, prevRsi, signal: null,
           reason: isStale ? 'rsi_rebase' : '', volume: volumeInfo };
}

// ── K线聚合 ──────────────────────────────────────────────────────

function buildCandles(ticks, intervalSec) {
  intervalSec = intervalSec || KLINE_SEC;
  if (!ticks || ticks.length === 0) return { closed: [], current: null };

  const intervalMs = intervalSec * 1000;
  const candles    = [];
  let current      = null;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.ts / intervalMs) * intervalMs;
    if (!current || current.openTime !== bucket) {
      if (current) candles.push(current);
      current = {
        openTime  : bucket,
        closeTime : bucket + intervalMs,
        open      : tick.price,
        high      : tick.price,
        low       : tick.price,
        close     : tick.price,
        volume    : 0,
        buyVolume : 0,
        sellVolume: 0,
        tickCount : 1,
      };
    } else {
      if (tick.price > current.high) current.high = tick.price;
      if (tick.price < current.low)  current.low  = tick.price;
      current.close = tick.price;
      current.tickCount++;
    }
  }

  if (!current) return { closed: candles, current: null };

  if (Date.now() >= current.closeTime) {
    candles.push(current);
    return { closed: candles, current: null };
  }

  return { closed: candles, current };
}

module.exports = {
  evaluateSignal,
  buildCandles,
  calcRSIWithState,
  stepRSI,
  CONFIG: {
    RSI_PERIOD, RSI_BUY, RSI_SELL, RSI_PANIC,
    TAKE_PROFIT_PCT, STOP_LOSS_PCT,
    KLINE_SEC, VOL_WIN_SEC, SKIP_FIRST,
    VOL_EXIT_CONSECUTIVE, VOL_EXIT_RATIO, VOL_EXIT_LOOKBACK,
  },
};
