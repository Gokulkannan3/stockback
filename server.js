// index.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

app.use('/api', require('./Router/Inventory.router'));
app.use('/api', require('./Router/Godown.router'));
app.use('/api', require('./Router/Admin.router'));
app.use('/api', require('./Router/Analysis.router'));
app.use('/api', require('./Router/Search.router'));
// app.use('/api/locations', require('./Router/Location.router'));
// app.use('/api/directcust', require('./Router/Directcust.router'));
// app.use('/api/direct', require('./Router/Direct.router'));
// app.use('/api/tracking', require('./Router/Tracking.router'));
// app.use('/api', require('./Router/Banner.router'));
// app.use('/api', require('./Router/Promocode.router'));

app.use((err, req, res, next) => {
  console.error('🔥 Error:', err.stack || err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error',
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});