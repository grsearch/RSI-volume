'use strict';
// src/routes/webhook.js

const express = require('express');
const router  = express.Router();
const monitor = require('../monitor');
const logger  = require('../logger');

// MIN_FDV / MIN_LP 过滤已移除

router.post('/add-token', (req, res) => {
  const { address, symbol, network, fdv, lp } = req.body || {};

  if (!address || !symbol) {
    return res.status(400).json({ error: '缺少 address 或 symbol' });
  }
  if (network && network !== 'solana') {
    return res.status(400).json({ error: '仅支持 solana' });
  }

  const added = monitor.addToken(address, symbol, { network: 'solana', fdv, lp });
  if (!added) {
    return res.status(409).json({ error: '代币已在监控中', address });
  }

  logger.info('[Webhook] ✅ 收到新代币 %s (%s) FDV=$%s LP=$%s', symbol, address, fdv ?? '?', lp ?? '?');
  res.json({ ok: true, address, symbol });
});

module.exports = router;
