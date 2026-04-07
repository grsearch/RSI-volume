'use strict';
// src/rsi.js — RSI 计算 + 量能过滤 + BUY/SELL 信号逻辑
//
// 策略（5秒K线 + 1秒轮询）：
//   BUY : RSI(7) ≤ 35 + 过去15秒 buyVolume > sellVolume × 1.1
//   SELL: 过去15秒 sellVolume > buyVolume × 1.1
//
// 量能数据来源：Helius Enhanced WebSocket（链上真实成交）
// 无链上数据时：拒绝买入，不退化为纯RSI

const RSI_PERIOD  = parseInt(process.env.RSI_PERIOD          || '7',  10);
const RSI_BUY     = parseFloat(process.env.RSI_BUY_LEVEL     || '35');
const KLINE_SEC   = parseInt(process.env.KLINE_INTERVAL_SEC  || '5',  10);
const VOL_WIN_SEC = parseInt(process.env.VOL_WINDOW_SEC      || '15', 10);
const SKIP_FIRST  = parseInt(process.env.SKIP_FIRST_CANDLES  || '3',  10);

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

  // ── SELL：过去15秒 sellVolume > buyVolume × 1.1 ──────────────
  if (tokenState.inPosition) {
    const sv = getVolume(getWindowCandles(closedCandles, currentCandle, 15));
    if (sv.total > 0
        && sv.sell > sv.buy * 1.1
        && lastCandleTs !== (tokenState._lastSellCandle || -1)) {
      tokenState._lastSellCandle = lastCandleTs;
      updateState();
      return {
        rsi: rsiNow, prevRsi, signal: 'SELL',
        reason: `SELL>BUY×1.1_15s(sell=${sv.sell.toFixed(2)}>buy×1.1=${(sv.buy*1.1).toFixed(2)})`,
        volume: volumeInfo,
      };
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

    // buy > sell × 1.1
    if (bv.buy > bv.sell * 1.1) {
      tokenState._lastBuyCandle = lastCandleTs;
      updateState();
      return {
        rsi: rsiNow, prevRsi, signal: 'BUY',
        reason: `RSI(${rsiNow.toFixed(1)}≤${RSI_BUY})+BUY>SELL×1.1(${bv.buy.toFixed(2)}>${(bv.sell*1.1).toFixed(2)},${VOL_WIN_SEC}s)`,
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
  CONFIG: { RSI_PERIOD, RSI_BUY, KLINE_SEC, VOL_WIN_SEC, SKIP_FIRST },
};
