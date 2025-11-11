const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});
exports.addGodown = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Godown name is required' });
    }
    const formattedName = name.toLowerCase().replace(/\s+/g, '_');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.godown (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE
      )
    `);
    const checkQuery = 'SELECT name FROM public.godown WHERE name = $1';
    const checkResult = await pool.query(checkQuery, [formattedName]);
    if (checkResult.rows.length > 0) {
      return res.status(400).json({ message: 'Godown already exists' });
    }
    const insertQuery = 'INSERT INTO public.godown (name) VALUES ($1) RETURNING id';
    const result = await pool.query(insertQuery, [formattedName]);
    res.status(201).json({ message: 'Godown created successfully', id: result.rows[0].id });
  } catch (err) {
    console.error('Error in addGodown:', err.message);
    res.status(500).json({ message: 'Failed to create godown' });
  }
};
exports.getGodowns = async (req, res) => {
  try {
    const godownsResult = await pool.query('SELECT id, name FROM public.godown ORDER BY name');
    const godowns = godownsResult.rows;
    for (let godown of godowns) {
      const stockResult = await pool.query(
        `SELECT
            s.id,
            s.product_type,
            s.productname,
            s.brand,
            s.current_cases,
            s.per_case,
            s.date_added,
            s.last_taken_date,
            s.taken_cases,
            COALESCE(b.agent_name, '-') AS agent_name
         FROM public.stock s
         LEFT JOIN public.brand b ON s.brand = b.name
         WHERE s.godown_id = $1
         ORDER BY s.productname`,
        [godown.id]
      );
      godown.stocks = stockResult.rows;
    }
    res.status(200).json(godowns);
  } catch (err) {
    console.error('Error in getGodowns:', err.message);
    res.status(500).json({ message: 'Failed to fetch godowns' });
  }
};
exports.deleteGodown = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM public.godown WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Godown not found' });
    }
    res.status(200).json({ message: 'Godown deleted successfully' });
  } catch (err) {
    console.error('Error in deleteGodown:', err.message);
    res.status(500).json({ message: 'Failed to delete godown' });
  }
};
exports.addStockToGodown = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { godown_id, product_type, productname, brand, cases_added } = req.body;
    if (!godown_id || !product_type || !productname || !brand || !cases_added) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const casesAddedNum = parseInt(cases_added, 10);
    if (isNaN(casesAddedNum) || casesAddedNum <= 0) {
      return res.status(400).json({ message: 'Cases must be a positive number' });
    }

    // Validate godown
    const godownCheck = await client.query('SELECT id FROM public.godown WHERE id = $1', [godown_id]);
    if (godownCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Godown not found' });
    }

    // Validate product in its type table
    const tableName = product_type.toLowerCase().replace(/\s+/g, '_');
    const productCheck = await client.query(
      `SELECT id, per_case FROM public."${tableName}" WHERE productname = $1 AND brand = $2`,
      [productname, brand]
    );
    if (productCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Product not found in type table' });
    }
    const per_case = productCheck.rows[0].per_case;

    // Ensure stock table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.stock (
        id BIGSERIAL PRIMARY KEY,
        godown_id INTEGER REFERENCES public.godown(id) ON DELETE CASCADE,
        product_type VARCHAR(100) NOT NULL,
        productname VARCHAR(255) NOT NULL,
        brand VARCHAR(100) NOT NULL,
        current_cases INTEGER NOT NULL DEFAULT 0,
        per_case INTEGER NOT NULL,
        date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_taken_date TIMESTAMP NULL,
        taken_cases INTEGER DEFAULT 0,
        CONSTRAINT unique_stock_entry UNIQUE (godown_id, product_type, productname, brand)
      )
    `);

    // Ensure brand table & get brand_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.brand (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        agent_name VARCHAR(100)
      )
    `);

    const formattedBrand = brand.toLowerCase().replace(/\s+/g, '_');
    let brandResult = await client.query('SELECT id FROM public.brand WHERE name = $1', [formattedBrand]);
    if (brandResult.rows.length === 0) {
      const insertBrand = await client.query(
        'INSERT INTO public.brand (name) VALUES ($1) RETURNING id',
        [formattedBrand]
      );
      brandResult = insertBrand;
    }
    const brand_id = brandResult.rows[0].id;

    // Add brand_id column if not exists
    await client.query(`
      ALTER TABLE public.stock 
      ADD COLUMN IF NOT EXISTS brand_id INTEGER REFERENCES public.brand(id)
    `);

    // Check existing stock
    let stockId;
    const existingStock = await client.query(
      'SELECT id, current_cases FROM public.stock WHERE godown_id = $1 AND product_type = $2 AND productname = $3 AND brand = $4',
      [godown_id, product_type, productname, brand]
    );

    if (existingStock.rows.length > 0) {
      stockId = existingStock.rows[0].id;
      const newCases = existingStock.rows[0].current_cases + casesAddedNum;

      await client.query(
        'UPDATE public.stock SET current_cases = $1, date_added = CURRENT_TIMESTAMP, brand_id = $2 WHERE id = $3',
        [newCases, brand_id, stockId]
      );
    } else {
      const insertResult = await client.query(
        `INSERT INTO public.stock 
         (godown_id, product_type, productname, brand, brand_id, current_cases, per_case) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [godown_id, product_type, productname, brand, brand_id, casesAddedNum, per_case]
      );
      stockId = insertResult.rows[0].id;
    }

    // Insert into history
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.stock_history (
        id BIGSERIAL PRIMARY KEY,
        stock_id INTEGER REFERENCES public.stock(id) ON DELETE CASCADE,
        action VARCHAR(10) CHECK (action IN ('added', 'taken')),
        cases INTEGER NOT NULL,
        per_case_total INTEGER NOT NULL,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(
      'INSERT INTO public.stock_history (stock_id, action, cases, per_case_total) VALUES ($1, $2, $3, $4)',
      [stockId, 'added', casesAddedNum, casesAddedNum * per_case]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Stock added successfully', stock_id: stockId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in addStockToGodown:', err.message);
    res.status(500).json({ message: 'Failed to add stock', error: err.message });
  } finally {
    client.release();
  }
};
exports.getStockByGodown = async (req, res) => {
  const { godown_id } = req.params;

  try {
    const typesRes = await pool.query(`
      SELECT DISTINCT product_type
      FROM public.stock 
      WHERE godown_id = $1
    `, [godown_id]);

    if (typesRes.rows.length === 0) return res.json([]);

    const productTypes = typesRes.rows.map(r => r.product_type);
    let joins = '';
    const params = [godown_id];
    let idx = 2;

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
          ${productTypes.map((_, i) => `CAST(p${i + 2}.price AS NUMERIC)`).join(', ')}, 
          0
        )::NUMERIC AS rate_per_box,
        g.name AS godown_name,
        COALESCE(b.agent_name, '-') AS agent_name
      FROM public.stock s
      JOIN public.godown g ON s.godown_id = g.id
      LEFT JOIN public.brand b ON s.brand = b.name
      ${joins}
      WHERE s.godown_id = $1
      ORDER BY s.product_type, s.productname
    `;

    const result = await pool.query(finalQuery, params);
    res.json(result.rows);

  } catch (err) {
    console.error('getStockByGodown:', err.message);
    res.status(500).json({ message: 'Failed to fetch stock' });
  }
};

exports.takeStockFromGodown = async (req, res) => {
  const client = await pool.connect();
  try {
    const { stock_id, cases_taken } = req.body;
    if (!stock_id) {
      return res.status(400).json({ message: 'Stock ID is required' });
    }
    if (!cases_taken || parseInt(cases_taken) <= 0) {
      return res.status(400).json({ message: 'Valid cases to take is required' });
    }
    // Start transaction
    await client.query('BEGIN');
    // Check stock availability
    const stockCheck = await client.query(
      'SELECT current_cases, per_case, taken_cases FROM public.stock WHERE id = $1 FOR UPDATE',
      [stock_id]
    );
    if (stockCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Stock entry not found' });
    }
    const { current_cases, per_case, taken_cases } = stockCheck.rows[0];
    if (parseInt(cases_taken) > current_cases) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Insufficient stock' });
    }
    const newCases = current_cases - parseInt(cases_taken);
    const newTakenCases = (taken_cases || 0) + parseInt(cases_taken);
    // Update stock
    await client.query(
      'UPDATE public.stock SET current_cases = $1, taken_cases = $2, last_taken_date = CURRENT_TIMESTAMP WHERE id = $3',
      [newCases, newTakenCases, stock_id]
    );
    // Insert into stock history
    await client.query(
      'INSERT INTO public.stock_history (stock_id, action, cases, per_case_total) VALUES ($1, $2, $3, $4)',
      [stock_id, 'taken', parseInt(cases_taken), parseInt(cases_taken) * per_case]
    );
    // Commit transaction
    await client.query('COMMIT');
    res.status(200).json({ message: 'Stock taken successfully', new_cases: newCases });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error in takeStockFromGodown:', err.message);
    res.status(500).json({ message: 'Failed to take stock' });
  } finally {
    client.release();
  }
};
exports.addStockToExisting = async (req, res) => {
  try {
    const { stock_id, cases_added } = req.body;
    if (!stock_id) {
      return res.status(400).json({ message: 'Stock ID is required' });
    }
    if (!cases_added || parseInt(cases_added) <= 0) {
      return res.status(400).json({ message: 'Valid cases to add is required' });
    }
    const stockCheck = await pool.query(
      'SELECT current_cases, per_case FROM public.stock WHERE id = $1',
      [stock_id]
    );
    if (stockCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Stock entry not found' });
    }
    const { current_cases, per_case } = stockCheck.rows[0];
    const newCases = current_cases + parseInt(cases_added);
    await pool.query(
      'UPDATE public.stock SET current_cases = $1, date_added = CURRENT_TIMESTAMP WHERE id = $2',
      [newCases, stock_id]
    );
    await pool.query(
      'INSERT INTO public.stock_history (stock_id, action, cases, per_case_total) VALUES ($1, $2, $3, $4)',
      [stock_id, 'added', parseInt(cases_added), parseInt(cases_added) * per_case]
    );
    res.status(200).json({ message: 'Stock added successfully', new_cases: newCases });
  } catch (err) {
    console.error('Error in addStockToExisting:', err.message);
    res.status(500).json({ message: 'Failed to add stock' });
  }
};
exports.getStockHistory = async (req, res) => {
  try {
    const { stock_id } = req.params;
    const result = await pool.query(
      `SELECT
          h.*,
          s.productname,
          s.brand,
          s.product_type,
          s.per_case * h.cases AS per_case_total,
          COALESCE(b.agent_name, '-') AS agent_name,
          COALESCE(h.customer_name, '-') AS customer_name   -- from stock_history
       FROM public.stock_history h
       JOIN public.stock s ON h.stock_id = s.id
       LEFT JOIN public.brand b ON s.brand = b.name
       WHERE h.stock_id = $1
       ORDER BY h.date DESC`,
      [stock_id]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error in getStockHistory:', err.message);
    res.status(500).json({ message: 'Failed to fetch stock history' });
  }
};
exports.exportGodownStockToExcel = async (req, res) => {
  try {
    const godownsResult = await pool.query('SELECT id, name FROM public.godown ORDER BY name');
    const godowns = godownsResult.rows;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Admin System';
    workbook.lastModifiedBy = 'Admin System';

    for (const godown of godowns) {
      const stockResult = await pool.query(
        `SELECT
            s.*,
            g.name AS godown_name,
            COALESCE(b.agent_name, '-') AS agent_name,
            COALESCE(latest_taken.customer_name, '-') AS last_customer_name,
            COALESCE(latest_taken.agent_name, '-') AS last_agent_name
         FROM public.stock s
         JOIN public.godown g ON s.godown_id = g.id
         LEFT JOIN public.brand b ON s.brand = b.name
         LEFT JOIN LATERAL (
           SELECT h.customer_name, h.agent_name
           FROM public.stock_history h
           WHERE h.stock_id = s.id
             AND h.action = 'taken'
           ORDER BY h.date DESC
           LIMIT 1
         ) latest_taken ON TRUE
         WHERE s.godown_id = $1
         ORDER BY s.productname`,
        [godown.id]
      );

      const worksheet = workbook.addWorksheet(godown.name, { properties: { defaultColWidth: 15 } });
      worksheet.columns = [
        { header: 'Product Type', key: 'product_type', width: 20 },
        { header: 'Product Name', key: 'productname', width: 30 },
        { header: 'Brand', key: 'brand', width: 15 },
        { header: 'Name', key: 'display_name', width: 22 },
        { header: 'Current Cases', key: 'current_cases', width: 15 },
        { header: 'Per Case', key: 'per_case', width: 10 },
        { header: 'Taken Cases', key: 'taken_cases', width: 15 },
        { header: 'Date Added', key: 'date_added', width: 20 },
        { header: 'Last Taken Date', key: 'last_taken_date', width: 20 },
      ];

      stockResult.rows.forEach(row => {
        worksheet.addRow({
          product_type: row.product_type,
          productname: row.productname,
          brand: row.brand,
          display_name: row.last_customer_name !== '-' 
            ? row.last_customer_name 
            : row.last_agent_name,
          current_cases: row.current_cases,
          per_case: row.per_case,
          taken_cases: row.taken_cases || 0,
          date_added: row.date_added,
          last_taken_date: row.last_taken_date || '',
        });
      });

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFCCCCCC' },
      };
    }

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename=godown_stocks.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error in exportGodownStockToExcel:', err.message);
    res.status(500).json({ message: 'Failed to export Excel' });
  }
};

exports.editGodown = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Name required' });

    const formatted = name.toLowerCase().trim().replace(/\s+/g, '_');
    const check = await pool.query('SELECT id FROM public.godown WHERE name = $1 AND id != $2', [formatted, id]);
    if (check.rows.length > 0) return res.status(400).json({ message: 'Name already exists' });

    const result = await pool.query(
      'UPDATE public.godown SET name = $1 WHERE id = $2 RETURNING name',
      [formatted, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Godown not found' });

    res.json({ message: 'Updated', name: result.rows[0].name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update' });
  }
};

// FAST FETCH: Godowns + Stock Count (no full stock details)
exports.getGodownsFast = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        g.id, 
        g.name,
        COALESCE(SUM(s.current_cases), 0) AS total_cases,
        COUNT(s.id) AS stock_items
      FROM public.godown g
      LEFT JOIN public.stock s ON s.godown_id = g.id
      GROUP BY g.id, g.name
      ORDER BY g.name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed' });
  }
};

// POST /api/godowns/bulk-allocate
exports.bulkAllocate = async (req, res) => {
  const client = await pool.connect();
  try {
    const { allocations } = req.body;
    if (!Array.isArray(allocations) || allocations.length === 0) {
      return res.status(400).json({ message: 'No allocations provided' });
    }

    await client.query('BEGIN');

    const results = [];

    for (const alloc of allocations) {
      const {
        godown_id,
        product_type,
        productname,
        brand,
        per_case,
        cases_added
      } = alloc;

      const cases = parseInt(cases_added, 10);
      if (isNaN(cases) || cases <= 0) continue;

      // --- Brand: Insert if not exists ---
      const fmtBrand = brand.toLowerCase().replace(/\s+/g, '_');
      let brandRes = await client.query(
        'SELECT id FROM public.brand WHERE name = $1',
        [fmtBrand]
      );
      if (brandRes.rows.length === 0) {
        brandRes = await client.query(
          'INSERT INTO public.brand (name) VALUES ($1) RETURNING id',
          [fmtBrand]
        );
      }
      const brand_id = brandRes.rows[0].id;

      // --- Stock: Update or Insert ---
      const exist = await client.query(
        `SELECT id, current_cases FROM public.stock 
         WHERE godown_id = $1 AND product_type = $2 AND productname = $3 AND brand = $4`,
        [godown_id, product_type, productname, brand]
      );

      let stockId;
      if (exist.rows.length > 0) {
        stockId = exist.rows[0].id;
        const newCases = exist.rows[0].current_cases + cases;
        await client.query(
          `UPDATE public.stock 
           SET current_cases = $1, date_added = CURRENT_TIMESTAMP, brand_id = $2 
           WHERE id = $3`,
          [newCases, brand_id, stockId]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO public.stock 
           (godown_id, product_type, productname, brand, brand_id, current_cases, per_case)
           VALUES ($1, $2, $3, $4, $5, $6, $7) 
           RETURNING id`,
          [godown_id, product_type, productname, brand, brand_id, cases, per_case]
        );
        stockId = ins.rows[0].id;
      }

      // --- History ---
      await client.query(
        `INSERT INTO public.stock_history (stock_id, action, cases, per_case_total)
         VALUES ($1, 'added', $2, $3)`,
        [stockId, cases, cases * per_case]
      );

      results.push({ godown_id, productname, brand, cases_added: cases });
    }

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Bulk allocation completed',
      added: results.length,
      details: results
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('bulkAllocate error:', err.message);
    res.status(500).json({ message: 'Failed to allocate stock' });
  } finally {
    client.release();
  }
};