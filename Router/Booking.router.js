// routes/booking.js
const express = require('express');
const router = express.Router();
const { createBooking, getBookings, getCustomers, searchProductsGlobal,editBooking,deleteBooking } = require('../Controller/Booking.controller');
const godownController = require('../Controller/Godown.controller');

router.post('/godown', godownController.addGodown);
router.get('/godown', godownController.getGodowns);
router.delete('/godown/:id', godownController.deleteGodown);
router.get('/godown/stock/:godown_id', godownController.getStockByGodown);

router.post('/booking', createBooking);
router.get('/booking', getBookings);
router.get('/customers', getCustomers);
router.get('/search/global', searchProductsGlobal);
router.patch('/booking/:id', editBooking);
router.delete('/booking/:id', deleteBooking);

module.exports = router;