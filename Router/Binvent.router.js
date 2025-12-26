const express = require('express');
const router = express.Router();
const {
  addProduct,
  getAllProducts,
  updateProduct,
  deleteProduct,
  getStates
} = require('../Controller/Binvent.controller');

router.post('/tproducts', addProduct);
router.get('/tproducts', getAllProducts);
router.put('/tproducts/:id', updateProduct);
router.delete('/tproducts/:id', deleteProduct);
router.get('/states', getStates);

module.exports = router;