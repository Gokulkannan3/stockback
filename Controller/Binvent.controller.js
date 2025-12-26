const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

exports.addProduct = async (req, res) => {
  try {
    const { productname, brand, hsn_code, price, per_case } = req.body;
    if (!productname || !price || !per_case)
      return res.status(400).json({ message: 'Required fields missing' });

    const dup = await pool.query(
      `SELECT id FROM public.tproductssstable 
       WHERE LOWER(productname) = LOWER($1) AND LOWER(brand) = LOWER($2)`,
      [productname.trim(), (brand || '').trim()]
    );
    if (dup.rows.length) return res.status(400).json({ message: 'Product already exists' });

    const result = await pool.query(
      `INSERT INTO public.tproductssstable 
       (productname, brand, hsn_code, price, per_case)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        productname.trim(),
        brand || null,
        hsn_code || null,
        parseFloat(price),
        parseInt(per_case)
      ]
    );

    res.status(201).json({ message: 'Product added', id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to add product' });
  }
};

exports.getAllProducts = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, 
        productname, 
        brand, 
        hsn_code, 
        price AS rate_per_box, 
        per_case
      FROM public.tproductssstable 
      ORDER BY productname
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
};

exports.searchProducts = async (req, res) => {
  const { name } = req.query;
  const searchTerm = `%${name?.trim().toLowerCase() || ''}%`;

  try {
    const result = await pool.query(`
      SELECT 
        id, 
        productname, 
        brand, 
        hsn_code, 
        price AS rate_per_box, 
        per_case
      FROM public.tproductssstable 
      WHERE LOWER(productname) LIKE $1 
         OR LOWER(brand) LIKE $1 
      ORDER BY productname
    `, [searchTerm]);
    
    res.json(result.rows);
  } catch (err) {
    console.error('Search Products Error:', err);
    res.status(500).json({ message: 'Search failed' });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { productname, brand, hsn_code, price, per_case } = req.body;

    if (!productname || !price || !per_case)
      return res.status(400).json({ message: 'Required fields missing' });

    await pool.query(
      `UPDATE public.tproductssstable 
       SET productname = $1, 
           brand = $2, 
           hsn_code = $3, 
           price = $4, 
           per_case = $5
       WHERE id = $6`,
      [
        productname.trim(),
        brand || null,
        hsn_code || null,
        parseFloat(price),
        parseInt(per_case),
        id
      ]
    );
    res.json({ message: 'Product updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Update failed' });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM public.tproductssstable WHERE id = $1`, [id]);
    res.json({ message: 'Product deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Delete failed' });
  }
};

exports.getStates = async (req, res) => {
  try {
    const result = await pool.query('SELECT code, state_name FROM codestate ORDER BY code');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch states' });
  }
};