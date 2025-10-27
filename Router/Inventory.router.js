// Router/Inventory.router.js
const express = require('express');
const router = express.Router();
const { addProduct, getProducts, addProductType, getProductTypes, updateProduct, deleteProduct, addBrand, getBrands, getProductsByType } = require('../Controller/Inventory.controller');

router.post('/products', addProduct);
router.get('/products', getProducts);
router.post('/product-types', addProductType);
router.get('/product-types', getProductTypes);
router.get('/products/:productType', getProductsByType); // New endpoint
router.put('/products/:tableName/:id', updateProduct);
router.delete('/products/:tableName/:id', deleteProduct);
router.post('/brands', addBrand);
router.get('/brands', getBrands);

module.exports = router;