// Router/Godown.router.js
const express = require('express');
const router = express.Router();
const {
  addGodown,
  getGodowns,
  deleteGodown,
  addStockToGodown,
  getStockByGodown,
  takeStockFromGodown,
  getStockHistory,
  exportGodownStockToExcel,
  addStockToExisting,
} = require('../Controller/Godown.controller');

router.post('/godowns', addGodown);
router.get('/godowns', getGodowns);
router.delete('/godowns/:id', deleteGodown);

router.post('/godowns/:godown_id/stock', addStockToGodown);
router.get('/godowns/:godown_id/stock', getStockByGodown);
router.patch('/godowns/stock/take', takeStockFromGodown);
router.patch('/godowns/stock/add', addStockToExisting);

router.get('/stock/:stock_id/history', getStockHistory);
router.get('/godowns/export-excel', exportGodownStockToExcel);

module.exports = router;