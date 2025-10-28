// Router/Inventory.router.js
const express = require('express');
const router = express.Router();
const {
  addProduct, getProducts, addProductType, getProductTypes,
  updateProduct, deleteProduct,
  addBrand, getBrands, updateBrand, deleteBrand,
  getProductsByType
} = require('../Controller/Inventory.controller');

router.post('/products', addProduct);
router.get('/products', getProducts);
router.get('/products/:productType', getProductsByType);
router.put('/products/:tableName/:id', updateProduct);
router.delete('/products/:tableName/:id', deleteProduct);

router.post('/product-types', addProductType);
router.get('/product-types', getProductTypes);

router.post('/brands', addBrand);
router.get('/brands', getBrands);
router.put('/brands/:id', updateBrand);      // NEW
router.delete('/brands/:id', deleteBrand);  // NEW

module.exports = router;