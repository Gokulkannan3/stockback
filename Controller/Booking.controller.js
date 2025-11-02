// controllers/Booking.controller.js
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

const generateBillNumber = async () => {
  const result = await pool.query('SELECT COUNT(*) as count FROM public.bookings');
  return `BILL-${String(parseInt(result.rows[0].count, 10) + 1).padStart(3, '0')}`;
};

const formatDate = (dateStr) => {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
};

exports.createBooking = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      customer_name, address, gstin, lr_number, agent_name,
      from: fromLoc, to: toLoc, through,
      additional_discount = 0, packing_percent = 3.0,
      taxable_value, stock_from, items = []
    } = req.body;

    if (!customer_name || !items.length || !fromLoc || !toLoc || !through) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    await client.query('BEGIN');

    const bill_number = await generateBillNumber();
    const bill_date = new Date().toISOString().split('T')[0];

    let subtotal = 0;
    let totalCases = 0;

    const processedItems = [];

    // Process each item → reduce stock + log history
    for (const [idx, item] of items.entries()) {
      const {
        id: stock_id,
        productname, brand,
        cases, per_case, discount_percent = 0, godown, rate_per_box
      } = item;

      if (!stock_id || !productname || !brand || !cases || !per_case || rate_per_box === undefined) {
        throw new Error(`Invalid item at index ${idx}: Missing stock_id or data`);
      }

      // === STEP 1: Lock & check stock (like takeStockFromGodown) ===
      const stockCheck = await client.query(
        'SELECT current_cases, per_case, taken_cases FROM public.stock WHERE id = $1 FOR UPDATE',
        [stock_id]
      );

      if (stockCheck.rows.length === 0) {
        throw new Error(`Stock entry not found for ID: ${stock_id}`);
      }

      const { current_cases, taken_cases } = stockCheck.rows[0];
      if (cases > current_cases) {
        throw new Error(`Insufficient stock: ${productname} (Available: ${current_cases}, Requested: ${cases})`);
      }

      // === STEP 2: Calculate amount ===
      const qty = cases * per_case;
      const amountBefore = qty * rate_per_box;
      const discountAmt = amountBefore * (discount_percent / 100);
      const finalAmt = amountBefore - discountAmt;

      subtotal += finalAmt;
      totalCases += cases;

      // === STEP 3: Update stock (like takeStockFromGodown) ===
      const newCases = current_cases - cases;
      const newTakenCases = (taken_cases || 0) + cases;

      await client.query(
        'UPDATE public.stock SET current_cases = $1, taken_cases = $2, last_taken_date = CURRENT_TIMESTAMP WHERE id = $3',
        [newCases, newTakenCases, stock_id]
      );

      // === STEP 4: Log in history ===
      await client.query(
        'INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, date) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)',
        [stock_id, 'taken', cases, cases * per_case]
      );

      // === STEP 5: Save for PDF ===
      processedItems.push({
        s_no: idx + 1,
        productname,
        brand,
        cases,
        per_case,
        quantity: qty,
        rate_per_box,
        discount_percent: parseFloat(discount_percent),
        amount: parseFloat(finalAmt.toFixed(2)),
        godown: godown || stock_from
      });
    }

    // === Calculate totals ===
    const packingCharges = subtotal * (packing_percent / 100);
    const subtotalWithPacking = subtotal + packingCharges;
    const taxableUsed = taxable_value ? parseFloat(taxable_value) : subtotalWithPacking;
    const addlDiscountAmt = taxableUsed * (additional_discount / 100);
    const netBeforeRound = taxableUsed - addlDiscountAmt;
    const grandTotal = Math.round(netBeforeRound);
    const roundOff = grandTotal - netBeforeRound;

    // === Generate PDF ===
    const pdfFileName = `bill_${bill_number}.pdf`;
    const pdfPath = path.join(__dirname, '..', 'uploads', 'pdfs', pdfFileName);
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });

    await generatePDF({
      bill_number, bill_date, customer_name, address, gstin, lr_number, agent_name,
      from: fromLoc, to: toLoc, through, items: processedItems,
      subtotal, packingCharges, subtotalWithPacking, taxableUsed, addlDiscountAmt,
      roundOff, grandTotal, totalCases, stock_from, packing_percent
    }, pdfPath);

    const relativePdfPath = `/uploads/pdfs/${pdfFileName}`;

    // === Save booking ===
    await client.query(
      `INSERT INTO public.bookings (
        bill_number, bill_date, customer_name, address, gstin, lr_number, agent_name,
        "from", "to", "through", additional_discount, packing_percent, taxable_value,
        stock_from, pdf_path, items
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        bill_number, bill_date, customer_name, address, gstin, lr_number, agent_name,
        fromLoc, toLoc, through, additional_discount, packing_percent,
        taxable_value ? parseFloat(taxable_value) : null, stock_from, relativePdfPath,
        JSON.stringify(processedItems)
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Booking created', bill_number, pdfPath: relativePdfPath });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Booking Error:', err.message);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

// PDF Generator (unchanged)
const generatePDF = (data, outputPath) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    // === TITLE ===
    doc.fontSize(16).font('Helvetica-Bold').text('Estimate', { align: 'center' }).moveDown(1.5);

    const leftX = 50;
    const rightX = 350;
    const tableStartX = leftX;
    const tableWidth = 490; // 540 - 50 (right margin)
    const colWidths = [30, 90, 40, 40, 50, 60, 40, 70, 70]; // Must sum to ~490

    // === CUSTOMER INFO & BILL DETAILS (Same Y, Bold Titles) ===
    const startY = 100;

    // Left: Customer Info
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Customer Information', leftX, startY);

    doc.font('Helvetica').fontSize(10);
    doc.text(`Party Name : ${data.customer_name || ''}`, leftX, startY + 15);
    doc.text(`Address    : ${data.address || ''}`, leftX, startY + 30);
    doc.text(`Agent Name : ${data.agent_name || 'DIRECT'}`, leftX, startY + 45);

    // Right: Bill Details
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Bill Details', rightX, startY);

    doc.font('Helvetica').fontSize(10);
    doc.text(`Bill NO     : ${data.bill_number}`, rightX, startY + 15);
    doc.text(`Bill DATE   : ${formatDate(data.bill_date)}`, rightX, startY + 30);
    doc.text(`GSTIN       : ${data.gstin || ''}`, rightX, startY + 45);
    doc.text(`L.R. NUMBER : ${data.lr_number || ''}`, rightX, startY + 60);

    // === TABLE ===
    let y = startY + 90;

    const headers = ['S.No', 'Product', 'Case', 'Per', 'Qty', 'Rate', 'Disc', 'Amount', 'From'];
    let x = tableStartX;

    // Table Header
    doc.font('Helvetica-Bold').fontSize(9);
    headers.forEach((h, i) => {
      const align = i === 0 || i >= 2 ? 'center' : 'left';
      doc.text(h, x, y, { width: colWidths[i], align });
      x += colWidths[i];
    });

    // Header Underline
    doc.moveTo(tableStartX, y + 12).lineTo(tableStartX + tableWidth, y + 12).stroke();
    y += 20;

    // Table Rows
    doc.font('Helvetica').fontSize(9);
    data.items.forEach(item => {
      x = tableStartX;
      const row = [
        item.s_no,
        item.productname,
        item.cases,
        item.per_case,
        item.quantity,
        `${item.rate_per_box.toFixed(2)} Box`,
        `${item.discount_percent}%`,
        item.amount.toFixed(2),
        item.godown
      ];
      row.forEach((text, i) => {
        const align = i === 0 || i >= 2 ? 'center' : 'left';
        doc.text(text, x, y, { width: colWidths[i], align });
        x += colWidths[i];
      });
      y += 18;
    });

    // === TRANSPORT & TOTALS (Aligned with Table Width) ===
    y += 10;
    const transportStartY = y;

    // Left: Transport Details
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Transport Details', leftX, transportStartY);

    doc.font('Helvetica').fontSize(10);
    doc.text(`No. of Cases : ${data.totalCases}`, leftX, transportStartY + 15);
    doc.text(`From         : ${data.from}`, leftX, transportStartY + 30);
    doc.text(`To           : ${data.to}`, leftX, transportStartY + 45);
    doc.text(`Through      : ${data.through}`, leftX, transportStartY + 60);

    // Right: Totals (Aligned under table, right-justified)
    const totals = [
      ['GOODS VALUE', data.subtotal.toFixed(2)],
      ['SPECIAL DISCOUNT', `-${data.addlDiscountAmt.toFixed(2)}`],
      ['SUB TOTAL', data.subtotal.toFixed(2)],
      [`PACKING @ ${data.packing_percent}%`, data.packingCharges.toFixed(2)],
      ['SUB TOTAL', data.subtotalWithPacking.toFixed(2)],
      ['TAXABLE VALUE', data.taxableUsed.toFixed(2)],
      ['ROUND OFF', data.roundOff.toFixed(2)],
      ['NET AMOUNT', data.grandTotal.toFixed(2)]
    ];

    let ty = transportStartY;
    const labelX = rightX;
    const valueX = rightX + 100;
    const valueWidth = 80;

    doc.font('Helvetica').fontSize(10);
    totals.forEach(([label, value], i) => {
      const lineY = ty + 15;
      doc.text(label, labelX, lineY);
      doc.text(value, valueX, lineY, { width: valueWidth, align: 'right' });
      ty += 15;
    });

    // Optional: Underline NET AMOUNT
    const netY = ty;
    doc.font('Helvetica-Bold')
      .text('NET AMOUNT', labelX, netY)
      .text(data.grandTotal.toFixed(2), valueX, netY, { width: valueWidth, align: 'right' });

    // === FOOTER NOTES ===
    y = Math.max(y, ty) + 30;
    doc.fontSize(8).font('Helvetica')
      .text('Note:', leftX, y)
      .text('1. Company not responsible for transit loss/damage', leftX + 10, y + 12)
      .text('2. Subject to Sivakasi jurisdiction. E.& O.E', leftX + 10, y + 24);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
};

exports.getBookings = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, bill_number, bill_date, customer_name, "from", "to", items, pdf_path
      FROM public.bookings ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch bookings' });
  }
};