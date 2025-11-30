// Controller/Delivery.controller.js
const { Pool } = require('pg');
const pool = new Pool({ /* your config */ });
const { getNextSequenceNumber } = require('../utils/sequence');

exports.createDeliveryChallan = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      name, address, gstin, lr_number,
      from = 'SIVAKASI', to, through, items
    } = req.body;

    const user = req.body.created_by || 'Admin';
    const sequenceNumber = await getNextSequenceNumber();
    const challan_number = `DC-${sequenceNumber}`;

    const itemsWithRate = [];

    for (const item of items) {
      const { id, cases, per_case, product_type } = item;   // <-- make sure product_type is sent per item

      if (!product_type) {
        throw new Error(`product_type is required for item with stock id ${id}`);
      }

      // ---- 1. Fetch the current price (rate_per_box) from the dynamic table ----
      const priceQuery = `
        SELECT per_case
        FROM public.stock 
        WHERE id = $1
      `;

      const priceRes = await client.query(priceQuery, [id]);

      if (priceRes.rows.length === 0) {
        throw new Error(`Item id ${id} not found in table public.${tableName}`);
      }

      const rate_per_box = per_case

      // ---- 2. Reduce stock (still using your central stock table) ----
      await client.query(
        `UPDATE stock 
         SET current_cases = current_cases - $1,
             taken_cases = COALESCE(taken_cases, 0) + $1 
         WHERE id = $2`,
        [cases, id]
      );

      // ---- 3. Log stock history ----
      await client.query(
        `INSERT INTO stock_history 
         (stock_id, action, cases, per_case_total, date, customer_name)
         VALUES ($1, $2, $3, $4, NOW(), $5)`,
        [id, 'taken', cases, cases * per_case, name]
      );

      // ---- 4. Keep the rate inside the item for the delivery record ----
      itemsWithRate.push({
        ...item,
        rate_per_box
      });
    }

    // ---- 5. Insert the full delivery challan ----
    await client.query(
      `INSERT INTO delivery (
        challan_number, customer_name, address, gstin, lr_number,
        "from", "to", through, items, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        challan_number, name, address, gstin, lr_number,
        from, to, through, JSON.stringify(itemsWithRate), user
      ]
    );

    await client.query('COMMIT');
    res.json({ challan_number, message: 'Challan created successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in createDeliveryChallan:', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
  } finally {
    client.release();
  }
};

exports.getPendingChallans = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, challan_number, customer_name, "to", created_at, created_by 
      FROM delivery 
      WHERE converted_to_bill = FALSE 
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch pending challans' });
  }
};

exports.getChallanById = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`SELECT * FROM delivery WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Challan not found' });
    }

    const challan = result.rows[0];
    let items = [];

    if (challan.items) {
      try {
        items = typeof challan.items === 'string'
          ? JSON.parse(challan.items)
          : challan.items;
      } catch (e) {
        console.error('JSON parse error in items:', e);
        items = [];
      }
    }

    // Ensure rate_per_box is a number
    items = items.map(item => ({
      ...item,
      rate_per_box: parseFloat(item.rate_per_box) || 0,
      cases: Number(item.cases) || 0,
      per_case: Number(item.per_case) || 1
    }));

    res.json({
      ...challan,
      items
    });
  } catch (err) {
    console.error('getChallanById Error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};