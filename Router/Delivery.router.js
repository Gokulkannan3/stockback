const express = require('express');
const router = express.Router();
const { createDeliveryChallan, getPendingChallans, getChallanById} = require('../Controller/Delivery.controller');

router.post('/challan', createDeliveryChallan);
router.get('/challans', getPendingChallans);
router.get('/challan/:id', getChallanById);

module.exports = router;