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

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api', require('./Router/Inventory.router'));
app.use('/api', require('./Router/Godown.router'));
app.use('/api', require('./Router/Admin.router'));
app.use('/api', require('./Router/Analysis.router'));
app.use('/api', require('./Router/Search.router'));
app.use('/api', require('./Router/GodownAnalytics.router'));
app.use('/api', require('./Router/Booking.router'));
app.use('/api', require('./Router/Wdispatch.router'));
app.use('/api', require('./Router/Payments.router'));
app.use('/api', require('./Router/Delivery.router'));
app.use('/api', require('./Router/Company.router'));
app.use('/api/binvent', require('./Router/Binvent.router'));
app.use('/api/', require('./Router/Billing.router'));

app.use((err, req, res, next) => {
  console.error('🔥 Error:', err.stack || err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error',
  });
});

const PORT = process.env.PORT || 5000;
app.listen(5000, "0.0.0.0", () => {
  console.log("Server running on port 5000");
});