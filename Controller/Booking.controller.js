// controllers/Booking.controller.js
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { getNextSequenceNumber } = require('../utils/sequence');

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

const formatDate = (dateStr) => {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
};

exports.createBooking = async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      customer_name,
      address,
      gstin,
      lr_number,
      agent_name = 'DIRECT',
      from: fromLoc = 'SIVAKASI',
      to: toLoc,
      through,
      additional_discount = 0,
      packing_percent = 3.0,
      taxable_value,
      stock_from,
      items = [],
      apply_processing_fee = false,
      apply_cgst = false,
      apply_sgst = false,
      apply_igst = false,
      from_challan = false,
      challan_id = null,
      is_direct_bill = false        // ← This decides if stock should be deducted
    } = req.body;

    if (!customer_name || !items.length || !toLoc || !through) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // CORRECT STOCK DEDUCTION LOGIC
    const shouldDeductStock = is_direct_bill === true && !from_challan;

    await client.query('BEGIN');

    const sequenceNumber = await getNextSequenceNumber();
    const bill_number = `BILL-${sequenceNumber}`;
    const bill_date = new Date().toISOString().split('T')[0];

    let subtotal = 0;
    let totalCases = 0;
    const processedItems = [];

    for (const [idx, item] of items.entries()) {
      const {
        id: stock_id,
        productname,
        brand,
        cases,
        per_case,
        discount_percent = 0,
        godown,
        rate_per_box
      } = item;

      if (!stock_id || !productname || !brand || !cases || !per_case || rate_per_box === undefined) {
        throw new Error(`Invalid item at index ${idx}: Missing required data`);
      }

      // DEDUCT STOCK ONLY FOR DIRECT BILLS
      if (shouldDeductStock) {
        const stockRes = await client.query(
          'SELECT current_cases, taken_cases FROM public.stock WHERE id = $1 FOR UPDATE',
          [stock_id]
        );

        if (stockRes.rows.length === 0) {
          throw new Error(`Stock not found for ID: ${stock_id}`);
        }

        const { current_cases, taken_cases = 0 } = stockRes.rows[0];

        if (cases > current_cases) {
          throw new Error(`Insufficient stock: ${productname} (Available: ${current_cases}, Requested: ${cases})`);
        }

        await client.query(
          'UPDATE public.stock SET current_cases = $1, taken_cases = $2, last_taken_date = CURRENT_TIMESTAMP WHERE id = $3',
          [current_cases - cases, taken_cases + cases, stock_id]
        );

        await client.query(
          `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, date, customer_name)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)`,
          [stock_id, 'taken', cases, cases * per_case, customer_name]
        );
      }

      const qty = cases * per_case;
      const amountBefore = qty * rate_per_box;
      const discountAmt = amountBefore * (discount_percent / 100);
      const finalAmt = amountBefore - discountAmt;

      subtotal += finalAmt;
      totalCases += cases;

      processedItems.push({
        s_no: idx + 1,
        productname,
        brand,
        cases: Number(cases),
        per_case: Number(per_case),
        quantity: qty,
        rate_per_box: parseFloat(rate_per_box),
        discount_percent: parseFloat(discount_percent),
        amount: parseFloat(finalAmt.toFixed(2)),
        godown: godown || stock_from || fromLoc
      });
    }

    // Calculations
    const packingCharges = apply_processing_fee ? subtotal * (packing_percent / 100) : 0;
    const subtotalWithPacking = subtotal + packingCharges;
    const extraTaxable = taxable_value ? parseFloat(taxable_value) : 0;
    const taxableAmount = subtotalWithPacking + extraTaxable;
    const discountAmt = taxableAmount * (additional_discount / 100);
    const netTaxable = taxableAmount - discountAmt;

    let cgst = 0, sgst = 0, igst = 0;
    if (apply_igst) {
      igst = netTaxable * 0.18;
    } else if (apply_cgst && apply_sgst) {
      cgst = netTaxable * 0.09;
      sgst = netTaxable * 0.09;
    }

    const totalTax = cgst + sgst + igst;
    const grandTotal = Math.round(netTaxable + totalTax);
    const roundOff = grandTotal - (netTaxable + totalTax);

    // Generate PDF
    const pdfFileName = `${bill_number}.pdf`;
    const pdfPath = path.join(__dirname, '..', 'uploads', 'pdfs', pdfFileName);
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });

    await generatePDF({
      bill_number,
      bill_date,
      customer_name,
      address: address || '',
      gstin: gstin || '',
      lr_number: lr_number || '',
      agent_name,
      from: fromLoc,
      to: toLoc,
      through,
      items: processedItems,
      subtotal: parseFloat(subtotal.toFixed(2)),
      packingCharges: parseFloat(packingCharges.toFixed(2)),
      subtotalWithPacking: parseFloat(subtotalWithPacking.toFixed(2)),
      taxableUsed: parseFloat(taxableAmount.toFixed(2)),
      addlDiscountAmt: parseFloat(discountAmt.toFixed(2)),
      roundOff: parseFloat(roundOff.toFixed(2)),
      grandTotal,
      totalCases,
      stock_from: stock_from || fromLoc,
      packing_percent,
      cgstAmt: parseFloat(cgst.toFixed(2)),
      sgstAmt: parseFloat(sgst.toFixed(2)),
      igstAmt: parseFloat(igst.toFixed(2))
    }, pdfPath);

    const relativePdfPath = `/uploads/pdfs/${pdfFileName}`;

    // Save booking
    await client.query(
      `INSERT INTO public.bookings (
        bill_number, bill_date, customer_name, address, gstin, lr_number, agent_name,
        "from", "to", "through", stock_from, pdf_path, items, total, extra_charges, from_challan
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        bill_number,
        bill_date,
        customer_name,
        address || '',
        gstin || '',
        lr_number || '',
        agent_name,
        fromLoc,
        toLoc,
        through,
        stock_from || fromLoc,
        relativePdfPath,
        JSON.stringify(processedItems),
        grandTotal,
        JSON.stringify({
          packing_percent: parseFloat(packing_percent),
          additional_discount: parseFloat(additional_discount),
          taxable_value: extraTaxable,
          apply_processing_fee,
          apply_cgst,
          apply_sgst,
          apply_igst,
          is_direct_bill,
          from_challan
        }),
        from_challan
      ]
    );

    // Mark challan as converted
    if (from_challan && challan_id) {
      await client.query(
        'UPDATE delivery SET converted_to_bill = TRUE WHERE id = $1',
        [challan_id]
      );
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'Bill created successfully',
      bill_number,
      pdfPath: relativePdfPath,
      grandTotal
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Booking Error:', err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to create bill'
    });
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
    doc.fontSize(16).font('Helvetica-Bold').text('ESTIMATE', { align: 'center' }).moveDown(1.5);

    const leftX = 50;
    const rightX = 350;
    const tableStartX = leftX;
    const tableWidth = 490;
    const colWidths = [35, 130, 45, 45, 55, 65, 65, 50];
    const rowHeight = 20;
    const cellPadding = 4;

    // === CUSTOMER & BILL INFO ===
    const startY = 100;
    // Customer Information (left side - unchanged)
    doc.font('Helvetica-Bold').fontSize(15);
    doc.text('Customer Information', leftX, startY);

    doc.font('Helvetica').fontSize(12);
    doc.text(`Party Name : ${data.customer_name || ''}`, leftX, startY + 17);
    doc.text(`Address    : ${data.address || ''}`, leftX, startY + 32);
    doc.text(`GSTIN      : ${data.gstin || ''}`, leftX, startY + 52);

    // Bill Details (right side - RIGHT ALIGNED)
    doc.font('Helvetica-Bold').fontSize(15);
    doc.text('Bill Details', rightX, startY, { align: 'right' });

    doc.font('Helvetica').fontSize(12);
    doc.text(`Bill NO     : ${data.bill_number}`, rightX, startY + 17, { 
        align: 'right'
    });
    doc.text(`Bill DATE   : ${formatDate(data.bill_date)}`, rightX, startY + 32, { 
        align: 'right'
    });
    doc.text(`Agent Name : ${data.agent_name || 'DIRECT'}`, rightX, startY + 47, { 
        align: 'right'
    });
    doc.text(`L.R. NUMBER : ${data.lr_number || ''}`, rightX, startY + 62, { 
        align: 'right'
    });

    // Bold "No. of Cases" also right-aligned
    doc.font('Helvetica-Bold').fontSize(15);
    doc.text(`No. of Cases : ${data.totalCases}`, rightX, startY + 77, { 
        align: 'right' 
    });

    // === TABLE ===
    let y = startY + 105;
    const headers = ['S.No', 'Product', 'Case', 'Per', 'Qty', 'Rate', 'Amount', 'From'];
    const verticalLines = [tableStartX];
    colWidths.forEach(w => verticalLines.push(verticalLines[verticalLines.length - 1] + w));
    let x = tableStartX;

    // Header
    const headerTop = y;
    const headerBottom = y + rowHeight;
    doc.lineWidth(0.8).strokeColor('black');
    doc.moveTo(tableStartX, headerTop).lineTo(tableStartX + tableWidth, headerTop).stroke();
    doc.moveTo(tableStartX, headerBottom).lineTo(tableStartX + tableWidth, headerBottom).stroke();
    verticalLines.forEach(vx => {
      doc.moveTo(vx, headerTop).lineTo(vx, headerBottom).stroke();
    });
    doc.font('Helvetica-Bold').fontSize(10);
    headers.forEach((h, i) => {
      doc.text(h, x + cellPadding, y + cellPadding, {
        width: colWidths[i] - 2 * cellPadding,
        align: 'center'
      });
      x += colWidths[i];
    });
    y += rowHeight + 1;

    // Rows
    doc.font('Helvetica').fontSize(9);
    data.items.forEach((item) => {
      x = tableStartX;
      const row = [
        item.s_no.toString(),
        item.productname,
        item.cases.toString(),
        item.per_case.toString(),
        item.quantity.toString(),
        `${item.rate_per_box.toFixed(2)}`,
        item.amount.toFixed(2),
        item.godown
      ];
      const rowTop = y;
      const rowBottom = y + rowHeight;
      doc.lineWidth(0.4).strokeColor('black');
      doc.moveTo(tableStartX, rowTop).lineTo(tableStartX + tableWidth, rowTop).stroke();
      doc.moveTo(tableStartX, rowBottom).lineTo(tableStartX + tableWidth, rowBottom).stroke();
      verticalLines.forEach(vx => {
        doc.moveTo(vx, rowTop).lineTo(vx, rowBottom).stroke();
      });
      row.forEach((text, i) => {
        doc.text(text, x + cellPadding, y + cellPadding, {
          width: colWidths[i] - 2 * cellPadding,
          align: 'center'
        });
        x += colWidths[i];
      });
      y += rowHeight + 1;
    });

    // Bottom border
    doc.lineWidth(0.8)
       .moveTo(tableStartX, y - 1)
       .lineTo(tableStartX + tableWidth, y - 1)
       .strokeColor('black')
       .stroke();

    // === TOTALS ===
    y += 15;
    const transportStartY = y;
    doc.font('Helvetica-Bold').fontSize(15);
    doc.text('Transport Details', leftX, transportStartY);
    doc.font('Helvetica').fontSize(10);
    doc.text(`From         : ${data.from}`, leftX, transportStartY + 15);
    doc.text(`To           : ${data.to}`, leftX, transportStartY + 30);
    doc.text(`Through      : ${data.through}`, leftX, transportStartY + 45);

    // Fixed: Only show tax lines if the amount is > 0 (i.e., tax was applied)
    const totals = [
      ['GOODS VALUE', data.subtotal.toFixed(2)],
      ...(data.addlDiscountAmt > 0 ? [['SPECIAL DISCOUNT', `-${data.addlDiscountAmt.toFixed(2)}`]] : []),
      ['SUB TOTAL', data.subtotal.toFixed(2)],
      ...(data.packingCharges > 0 ? [[`PACKING @ ${data.packing_percent}%`, data.packingCharges.toFixed(2)]] : []),
      ['SUB TOTAL', data.subtotalWithPacking.toFixed(2)],
      ['TAXABLE VALUE', data.taxableUsed.toFixed(2)],
      ...(data.cgstAmt > 0 ? [['CGST @ 9%', data.cgstAmt.toFixed(2)]] : []),
      ...(data.sgstAmt > 0 ? [['SGST @ 9%', data.sgstAmt.toFixed(2)]] : []),
      ...(data.igstAmt > 0 ? [['IGST @ 18%', data.igstAmt.toFixed(2)]] : []),
      ['ROUND OFF', data.roundOff.toFixed(2)],
      [''], // empty line before net amount
    ];

    let ty = transportStartY;
    const labelX = rightX;
    const valueX = rightX + 110;
    const valueWidth = 70;

    doc.font('Helvetica').fontSize(10);
    totals.forEach(([label, value]) => {
      if (!label) return; // skip empty lines for spacing
      const lineY = ty + 15;
      doc.text(label, labelX, lineY, { align: 'left' });
      if (value !== undefined) {
        doc.text(value, valueX, lineY, { width: valueWidth, align: 'right' });
      }
      ty += 15;
    });

    // NET AMOUNT
    const netY = ty + 10;
    doc.font('Helvetica-Bold').fontSize(12)
       .text('NET AMOUNT', labelX, netY)
       .text(`${data.grandTotal.toFixed(2)}`, valueX, netY, { width: valueWidth, align: 'right' });

    // FOOTER
    const footerY = Math.max(y, ty) + 50;
    doc.fontSize(10).font('Helvetica')
       .text('Note:', leftX, footerY)
       .text('1. Company not responsible for transit loss/damage', leftX + 10, footerY + 12)
       .text('2. Subject to Sivakasi jurisdiction. E.& O.E', leftX + 10, footerY + 24);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
};

exports.getBookings = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, bill_number, bill_date, customer_name, address, gstin,
        "from", "to", through, lr_number,
        items, pdf_path, created_at
      FROM public.bookings 
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch bookings' });
  }
};

exports.getCustomers = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (customer_name)
        customer_name, address, gstin, lr_number, agent_name, "from", "to", "through"
      FROM public.bookings
      WHERE customer_name IS NOT NULL AND customer_name != ''
      ORDER BY customer_name, created_at DESC
    `);

    const customers = result.rows.map(row => ({
      label: row.customer_name,
      value: {
        name: row.customer_name,
        address: row.address || '',
        gstin: row.gstin || '',
        lr_number: row.lr_number || '',
        agent_name: row.agent_name || '',
        from: row.from || '',
        to: row.to || '',
        through: row.through || ''
      }
    }));

    res.json(customers);
  } catch (err) {
    console.error('Get Customers Error:', err);
    res.status(500).json({ message: 'Failed to fetch customers' });
  }
};

exports.searchProductsGlobal = async (req, res) => {
  const { name } = req.query;
  const searchTerm = `%${name.trim().toLowerCase()}%`;

  try {
    // Get all godowns
    const godownsRes = await pool.query(`SELECT id, name FROM public.godown`);
    const godowns = godownsRes.rows;

    const allResults = [];

    for (const godown of godowns) {
      const godownId = godown.id;

      // Get product types in this godown
      const typesRes = await pool.query(`
        SELECT DISTINCT product_type
        FROM public.stock 
        WHERE godown_id = $1 AND current_cases > 0
          AND (LOWER(productname) LIKE $2 OR LOWER(brand) LIKE $2)
      `, [godownId, searchTerm]);

      if (typesRes.rows.length === 0) continue;

      const productTypes = typesRes.rows.map(r => r.product_type);
      let joins = '';
      const params = [godownId, searchTerm];
      let idx = 3;

      productTypes.forEach(type => {
        const table = type.toLowerCase().replace(/\s+/g, '_');
        joins += `
          LEFT JOIN public."${table}" p${idx}
            ON LOWER(s.productname) = LOWER(p${idx}.productname)
            AND LOWER(s.brand) = LOWER(p${idx}.brand)
        `;
        idx++;
      });

      const finalQuery = `
        SELECT 
          s.id,
          s.product_type,
          s.productname,
          s.brand,
          s.per_case,
          s.current_cases,
          COALESCE(
            ${productTypes.map((_, i) => `CAST(p${i + 3}.price AS NUMERIC)`).join(', ')}, 
            0
          )::NUMERIC AS rate_per_box,
          $1::INTEGER AS godown_id,
          '${godown.name}' AS godown_name
        FROM public.stock s
        ${joins}
        WHERE s.godown_id = $1 
          AND s.current_cases > 0
          AND (LOWER(s.productname) LIKE $2 OR LOWER(s.brand) LIKE $2)
        ORDER BY s.product_type, s.productname
      `;

      const result = await pool.query(finalQuery, params);
      allResults.push(...result.rows);
    }

    res.json(allResults);
  } catch (err) {
    console.error('searchProductsGlobal:', err.message);
    res.status(500).json({ message: 'Search failed' });
  }
};

exports.editBooking = async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;
  const {
    customer_name,
    address = '',
    gstin = '',
    lr_number = '',
    agent_name = '',
    from: fromLoc,
    to: toLoc,
    through = '',
    additional_discount = 0,
    packing_percent = 3.0,
    taxable_value,
    stock_from = '',
    items = []
  } = req.body;

  try {
    await client.query('BEGIN');

    // 1. Get original booking
    const origRes = await client.query(
      'SELECT items, pdf_path FROM public.bookings WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (origRes.rows.length === 0) throw new Error('Booking not found');
    const original = origRes.rows[0];

    const oldItems = Array.isArray(original.items) ? original.items : [];

    // 2. Restock old items
    for (const item of oldItems) {
      const { id: stock_id, cases } = item;
      if (!stock_id || !cases) continue;

      await client.query(
        'UPDATE public.stock SET current_cases = current_cases + $1, taken_cases = taken_cases - $1 WHERE id = $2',
        [cases, stock_id]
      );
      await client.query(
        `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, date, customer_name) 
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)`,
        [stock_id, 'added', cases, cases * (item.per_case || 1), customer_name]
      );
    }

    // 3. Process new items (deduct stock)
    let subtotal = 0;
    let totalCases = 0;
    const processedItems = [];

    for (const [idx, item] of items.entries()) {
      const {
        id: stock_id,
        productname,
        brand,
        cases,
        per_case,
        discount_percent = 0,
        godown,
        rate_per_box
      } = item;

      if (!stock_id || !cases || !per_case || rate_per_box === undefined) {
        throw new Error(`Invalid item at index ${idx}`);
      }

      const stockCheck = await client.query(
        'SELECT current_cases FROM public.stock WHERE id = $1 FOR UPDATE',
        [stock_id]
      );
      if (stockCheck.rows.length === 0) throw new Error(`Stock not found: ${stock_id}`);
      if (cases > stockCheck.rows[0].current_cases) {
        throw new Error(`Not enough stock: ${productname}`);
      }

      const qty = cases * per_case;
      const amountBefore = qty * rate_per_box;
      const discountAmt = amountBefore * (discount_percent / 100);
      const finalAmt = amountBefore - discountAmt;

      subtotal += finalAmt;
      totalCases += cases;

      // Deduct stock
      await client.query(
        'UPDATE public.stock SET current_cases = current_cases - $1, taken_cases = taken_cases + $1, last_taken_date = CURRENT_TIMESTAMP WHERE id = $2',
        [cases, stock_id]
      );
      await client.query(
        `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, date, customer_name) 
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)`,
        [stock_id, 'taken', cases, qty, customer_name]
      );

      processedItems.push({
        s_no: idx + 1,
        productname: productname || '',
        brand: brand || '',
        cases: Number(cases),
        per_case: Number(per_case),
        quantity: Number(qty),
        rate_per_box: parseFloat(rate_per_box),
        discount_percent: parseFloat(discount_percent),
        amount: parseFloat(finalAmt.toFixed(2)),
        godown: godown || stock_from
      });
    }

    // 4. Recalculate totals
    const packingCharges = subtotal * (packing_percent / 100);
    const subtotalWithPacking = subtotal + packingCharges;
    const taxableUsed = taxable_value ? parseFloat(taxable_value) : subtotalWithPacking;
    const addlDiscountAmt = taxableUsed * (additional_discount / 100);
    const netBeforeRound = taxableUsed - addlDiscountAmt;
    const grandTotal = Math.round(netBeforeRound);
    const roundOff = grandTotal - netBeforeRound;

    // 5. Regenerate PDF
    const timestamp = Date.now();
    const pdfFileName = `bill_${id}_${timestamp}.pdf`;
    const pdfPath = path.join(__dirname, '..', 'uploads', 'pdfs', pdfFileName);

    await generatePDF({
      bill_number: original.pdf_path.split('_')[1]?.split('.')[0] || `BILL${id}`,
      bill_date: new Date().toISOString().split('T')[0],
      customer_name,
      address,
      gstin,
      lr_number,
      agent_name,
      from: fromLoc,
      to: toLoc,
      through,
      items: processedItems,
      subtotal: parseFloat(subtotal.toFixed(2)),
      packingCharges: parseFloat(packingCharges.toFixed(2)),
      subtotalWithPacking: parseFloat(subtotalWithPacking.toFixed(2)),
      taxableUsed: parseFloat(taxableUsed.toFixed(2)),
      addlDiscountAmt: parseFloat(addlDiscountAmt.toFixed(2)),
      roundOff: parseFloat(roundOff.toFixed(2)),
      grandTotal,
      totalCases,
      stock_from: stock_from || 'Unknown',
      packing_percent
    }, pdfPath);

    const relativePdfPath = `/uploads/pdfs/${pdfFileName}`;

    // 6. Update booking
    await client.query(
      `UPDATE public.bookings SET
        customer_name = $1, address = $2, gstin = $3, lr_number = $4, agent_name = $5,
        "from" = $6, "to" = $7, "through" = $8, additional_discount = $9,
        packing_percent = $10, taxable_value = $11, stock_from = $12,
        pdf_path = $13, items = $14, updated_at = CURRENT_TIMESTAMP
       WHERE id = $15`,
      [
        customer_name,
        address,
        gstin,
        lr_number,
        agent_name,
        fromLoc,
        toLoc,
        through,
        additional_discount,
        packing_percent,
        taxable_value ? parseFloat(taxable_value) : null,
        stock_from,
        relativePdfPath,
        JSON.stringify(processedItems),
        id
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Booking updated successfully', pdfPath: relativePdfPath });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Edit Booking Error:', err.message);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

// === DELETE BOOKING: Also log restock with customer_name (optional) ===
exports.deleteBooking = async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    await client.query('BEGIN');

    const bookingRes = await client.query(
      'SELECT items, pdf_path, customer_name FROM public.bookings WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (bookingRes.rows.length === 0) throw new Error('Booking not found');

    const { items, customer_name } = bookingRes.rows[0];
    const parsedItems = JSON.parse(items);

    // Restock each item
    for (const item of parsedItems) {
      const { id: stock_id, cases, per_case } = item;
      if (!stock_id || !cases) continue;

      await client.query(
        'UPDATE public.stock SET current_cases = current_cases + $1, taken_cases = taken_cases - $1 WHERE id = $2',
        [cases, stock_id]
      );
      await client.query(
        `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total, date, customer_name) 
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)`,
        [stock_id, 'added', cases, cases * per_case, customer_name || 'DELETED']
      );
    }

    // Delete PDF
    const pdfPath = path.join(__dirname, '..', bookingRes.rows[0].pdf_path.replace('/uploads/pdfs/', 'uploads/pdfs/'));
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

    await client.query('DELETE FROM public.bookings WHERE id = $1', [id]);

    await client.query('COMMIT');
    res.json({ message: 'Booking deleted and stock restored' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete Booking Error:', err.message);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

exports.convertChallanToBill = async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params;

  try {
    await client.query('BEGIN');

    const ch = await client.query(
      `SELECT * FROM delivery 
       WHERE id = $1 AND converted_to_bill = FALSE 
       FOR UPDATE`,
      [id]
    );

    if (ch.rows.length === 0) {
      throw new Error('Challan not found or already converted to bill');
    }

    const challan = ch.rows[0];
    const items = Array.isArray(challan.items) ? challan.items : [];

    if (items.length === 0) {
      throw new Error('No items in challan');
    }

    // Generate BILL number
    const sequenceNumber = challan.challan_number.replace('DC-', ''); // e.g., "5"
    const bill_number = `BILL-${sequenceNumber}`;
    const bill_date = new Date().toISOString().split('T')[0];

    // Prepare items with serial no + amount
    const itemsWithSerial = items.map((item, idx) => ({
      s_no: idx + 1,
      productname: item.productname || '',
      brand: item.brand || '',
      cases: Number(item.cases),
      per_case: Number(item.per_case),
      quantity: Number(item.cases) * Number(item.per_case),
      rate_per_box: parseFloat(item.rate_per_box || 0),
      discount_percent: 0,
      amount: parseFloat((item.cases * item.per_case * (item.rate_per_box || 0)).toFixed(2)),
      godown: item.godown || challan.from || 'SIVAKASI'
    }));

    const subtotal = itemsWithSerial.reduce((sum, i) => sum + i.amount, 0);
    const totalCases = itemsWithSerial.reduce((sum, i) => sum + i.cases, 0);

    // Generate PDF (using the SAME generatePDF function already in this file!)
    const pdfFileName = `${bill_number}.pdf`;
    const pdfPath = path.join(__dirname, '..', 'uploads', 'pdfs', pdfFileName);
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });

    await generatePDF({
      bill_number,
      bill_date,
      customer_name: challan.customer_name,
      address: challan.address || '',
      gstin: challan.gstin || '',
      lr_number: challan.lr_number || '',
      agent_name: 'DIRECT',
      from: challan.from || 'SIVAKASI',
      to: challan.to,
      through: challan.through || '',
      items: itemsWithSerial,
      subtotal,
      packingCharges: 0,
      subtotalWithPacking: subtotal,
      taxableUsed: subtotal,
      addlDiscountAmt: 0,
      cgstAmt: 0,
      sgstAmt: 0,
      igstAmt: 0,
      roundOff: 0,
      grandTotal: Math.round(subtotal),
      totalCases,
      stock_from: challan.from || 'SIVAKASI',
      packing_percent: 0
    }, pdfPath);

    const relativePdfPath = `/uploads/pdfs/${pdfFileName}`;

    // Insert into bookings
    await client.query(
      `INSERT INTO public.bookings (
        bill_number, bill_date, customer_name, address, gstin, lr_number,
        "from", "to", "through", items, pdf_path, from_challan, challan_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        bill_number,
        bill_date,
        challan.customer_name,
        challan.address || '',
        challan.gstin || '',
        challan.lr_number || '',
        challan.from || 'SIVAKASI',
        challan.to,
        challan.through || '',
        JSON.stringify(itemsWithSerial),
        relativePdfPath,
        true,
        challan.challan_number
      ]
    );

    // Mark challan as converted
    await client.query(
      'UPDATE delivery SET converted_to_bill = TRUE WHERE id = $1',
      [id]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Challan successfully converted to Bill!',
      bill_number,
      pdfUrl: relativePdfPath
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Convert Challan → Bill Error:', err);
    res.status(500).json({ 
      success: false,
      message: err.message || 'Failed to convert challan' 
    });
  } finally {
    client.release();
  }
};