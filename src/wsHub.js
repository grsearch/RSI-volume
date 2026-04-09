'use strict';
// src/wsHub.js — WebSocket 广播中心

const WebSocket = require('ws');
let _wss     = null;
let _monitor = null;  // 延迟注入 monitor 引用，避免循环依赖

function init(server) {
  _wss = new WebSocket.Server({ server });
  _wss.on('connection', ws => {
    ws.on('error', () => {});

    // 新客户端连接时，立即推送当前监控状态
    if (_monitor) {
      try {
        // 推送代币列表
        const tokens = _monitor.getTokens();
        ws.send(JSON.stringify({ type: 'token_list', tokens }));

        // 推送当前持仓的成交记录
        const records = require('./monitor').getAllTradeRecords?.() || [];
        records.forEach(r => {
          try { ws.send(JSON.stringify({ type: 'trade_record', ...r })); } catch (_) {}
        });
      } catch (_) {}
    }
  });
}

function setMonitor(monitor) {
  _monitor = monitor;
}

function broadcast(data) {
  if (!_wss) return;
  const msg = JSON.stringify(data);
  _wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (_) {}
    }
  });
}

module.exports = { init, broadcast, setMonitor };
