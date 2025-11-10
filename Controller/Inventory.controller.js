// Controller/Inventory.controller.js
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

/* ──────────────────────  PRODUCT  ────────────────────── */
exports.addProduct = async (req, res) => {
  try {
    const { productname, price, per_case, brand, product_type } = req.body;
    if (!productname || !price || !per_case || !brand || !product_type)
      return res.status(400).json({ message: 'All required fields must be provided' });

    const tableName = product_type.toLowerCase().replace(/\s+/g, '_');

    const typeCheck = await pool.query(
      'SELECT product_type FROM public.products WHERE product_type = $1',
      [product_type]
    );

    if (typeCheck.rows.length === 0) {
      await pool.query('INSERT INTO public.products (product_type) VALUES ($1)', [product_type]);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.${tableName} (
          id BIGSERIAL PRIMARY KEY,
          productname TEXT NOT NULL,
          price NUMERIC(10,2) NOT NULL,
          per_case INTEGER NOT NULL,
          brand TEXT NOT NULL
        )
      `);
    }

    const dup = await pool.query(
      `SELECT id FROM public.${tableName} WHERE productname = $1 AND brand = $2`,
      [productname, brand]
    );
    if (dup.rows.length) return res.status(400).json({ message: 'Product already exists for this brand' });

    const result = await pool.query(
      `INSERT INTO public.${tableName} (productname, price, per_case, brand)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [productname, parseFloat(price), parseInt(per_case, 10), brand]
    );

    res.status(201).json({ message: 'Product saved successfully', id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to save product' });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { tableName, id } = req.params;
    const { productname, price, per_case, brand } = req.body;
    if (!productname || !price || !per_case || !brand)
      return res.status(400).json({ message: 'All required fields must be provided' });

    const result = await pool.query(
      `UPDATE public.${tableName}
       SET productname=$1, price=$2, per_case=$3, brand=$4
       WHERE id=$5 RETURNING id`,
      [productname, parseFloat(price), parseInt(per_case, 10), brand, id]
    );

    if (!result.rows.length) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update product' });
  }
};

exports.getProducts = async (req, res) => {
  try {
    const types = await pool.query('SELECT product_type FROM public.products');
    const all = [];

    for (const { product_type } of types.rows) {
      const tbl = product_type.toLowerCase().replace(/\s+/g, '_');
      const rows = await pool.query(`SELECT id, productname, price, per_case, brand FROM public.${tbl}`);
      all.push(...rows.rows.map(r => ({ ...r, product_type })));
    }
    res.json(all);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
};

exports.getProductsByType = async (req, res) => {
  try {
    const { productType } = req.params;
    const tbl = productType.toLowerCase().replace(/\s+/g, '_');
    const rows = await pool.query(`SELECT id, productname, price, case_count, per_case, brand FROM public.${tbl} ORDER BY productname`);
    res.json(rows.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch products for type' });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const { tableName, id } = req.params;
    const result = await pool.query(`DELETE FROM public.${tableName} WHERE id=$1 RETURNING id`, [id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Product not found' });
    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete product' });
  }
};

/* ──────────────────────  PRODUCT TYPE  ────────────────────── */
exports.addProductType = async (req, res) => {
  try {
    const { product_type } = req.body;
    if (!product_type) return res.status(400).json({ message: 'Product type is required' });

    const fmt = product_type.toLowerCase().replace(/\s+/g, '_');
    const exists = await pool.query('SELECT 1 FROM public.products WHERE product_type=$1', [fmt]);
    if (exists.rows.length) return res.status(400).json({ message: 'Product type already exists' });

    await pool.query('INSERT INTO public.products (product_type) VALUES ($1)', [fmt]);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.${fmt} (
        id BIGSERIAL PRIMARY KEY,
        productname TEXT NOT NULL,
        price NUMERIC(10,2) NOT NULL,
        per_case INTEGER NOT NULL,
        brand TEXT NOT NULL
      )
    `);
    res.status(201).json({ message: 'Product type created successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create product type' });
  }
};

exports.getProductTypes = async (req, res) => {
  try {
    const result = await pool.query('SELECT product_type FROM public.products ORDER BY product_type');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch product types' });
  }
};

/* ──────────────────────  BRAND (with agent_name)  ────────────────────── */
exports.addBrand = async (req, res) => {
  try {
    const { brand, agent_name } = req.body;
    if (!brand) return res.status(400).json({ message: 'Brand name is required' });

    const fmt = brand.toLowerCase().replace(/\s+/g, '_');

    // Ensure table + column
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.brand (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR NOT NULL UNIQUE,
        agent_name TEXT
      )
    `);

    const dup = await pool.query('SELECT id FROM public.brand WHERE name=$1', [fmt]);
    if (dup.rows.length) return res.status(400).json({ message: 'Brand already exists' });

    const ins = await pool.query(
      'INSERT INTO public.brand (name, agent_name) VALUES ($1,$2) RETURNING id, name, agent_name',
      [fmt, agent_name || null]
    );

    res.status(201).json({ message: 'Brand created successfully', brand: ins.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create brand' });
  }
};

exports.getBrands = async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, agent_name FROM public.brand ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch brands' });
  }
};

exports.updateBrand = async (req, res) => {
  try {
    const { id } = req.params;
    const { brand, agent_name } = req.body;
    if (!brand) return res.status(400).json({ message: 'Brand name is required' });

    const fmt = brand.toLowerCase().replace(/\s+/g, '_');

    // Prevent name conflict with other brands
    const conflict = await pool.query(
      'SELECT id FROM public.brand WHERE name=$1 AND id!=$2',
      [fmt, id]
    );
    if (conflict.rows.length) return res.status(400).json({ message: 'Brand name already taken' });

    const upd = await pool.query(
      'UPDATE public.brand SET name=$1, agent_name=$2 WHERE id=$3 RETURNING id, name, agent_name',
      [fmt, agent_name || null, id]
    );

    if (!upd.rows.length) return res.status(404).json({ message: 'Brand not found' });

    res.json({ message: 'Brand updated successfully', brand: upd.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update brand' });
  }
};

exports.deleteBrand = async (req, res) => {
  try {
    const { id } = req.params;
    const del = await pool.query('DELETE FROM public.brand WHERE id=$1 RETURNING id', [id]);
    if (!del.rows.length) return res.status(404).json({ message: 'Brand not found' });
    res.json({ message: 'Brand deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete brand' });
  }
};