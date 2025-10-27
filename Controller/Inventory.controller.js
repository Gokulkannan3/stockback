// Controller/Inventory.controller.js
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
    const { productname, price, case_count, per_case, brand, product_type } = req.body;

    if (!productname || !price || !case_count || !per_case || !brand || !product_type) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }

    const tableName = product_type.toLowerCase().replace(/\s+/g, '_');

    const typeCheck = await pool.query(
      'SELECT product_type FROM public.products WHERE product_type = $1',
      [product_type]
    );

    if (typeCheck.rows.length === 0) {
      await pool.query(
        'INSERT INTO public.products (product_type) VALUES ($1)',
        [product_type]
      );

      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.${tableName} (
          id BIGSERIAL PRIMARY KEY,
          productname TEXT NOT NULL,
          price NUMERIC(10,2) NOT NULL,
          case_count INTEGER NOT NULL,
          per_case INTEGER NOT NULL,
          brand TEXT NOT NULL
        )
      `);
    }

    const duplicateCheck = await pool.query(
      `SELECT id FROM public.${tableName} WHERE productname = $1 AND brand = $2`,
      [productname, brand]
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Product already exists for this brand' });
    }

    const insertQuery = `
      INSERT INTO public.${tableName}
      (productname, price, case_count, per_case, brand)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;

    const values = [
      productname,
      parseFloat(price),
      parseInt(case_count, 10),
      parseInt(per_case, 10),
      brand
    ];

    const result = await pool.query(insertQuery, values);
    res.status(201).json({ message: 'Product saved successfully', id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to save product' });
  }
};

exports.updateProduct = async (req, res) => {
  try {
    const { tableName, id } = req.params;
    const { productname, price, case_count, per_case, brand } = req.body;

    if (!productname || !price || !case_count || !per_case || !brand) {
      return res.status(400).json({ message: 'All required fields must be provided' });
    }

    const query = `
      UPDATE public.${tableName}
      SET productname = $1, price = $2, case_count = $3, per_case = $4, brand = $5
      WHERE id = $6 RETURNING id
    `;
    const values = [
      productname,
      parseFloat(price),
      parseInt(case_count, 10),
      parseInt(per_case, 10),
      brand,
      id
    ];

    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.status(200).json({ message: 'Product updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to update product' });
  }
};

exports.getProducts = async (req, res) => {
  try {
    const typeResult = await pool.query('SELECT product_type FROM public.products');
    const productTypes = typeResult.rows.map(row => row.product_type);

    let allProducts = [];

    for (const productType of productTypes) {
      const tableName = productType.toLowerCase().replace(/\s+/g, '_');
      const query = `
        SELECT id, productname, price, case_count, per_case, brand
        FROM public.${tableName}
      `;
      const result = await pool.query(query);
      const products = result.rows.map(row => ({
        id: row.id,
        product_type: productType,
        productname: row.productname,
        price: row.price,
        case_count: row.case_count,
        per_case: row.per_case,
        brand: row.brand
      }));
      allProducts = [...allProducts, ...products];
    }

    res.status(200).json(allProducts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
};

exports.getProductsByType = async (req, res) => {
  try {
    const { productType } = req.params;
    const tableName = productType.toLowerCase().replace(/\s+/g, '_');
    const query = `
      SELECT id, productname, price, case_count, per_case, brand
      FROM public.${tableName}
      ORDER BY productname
    `;
    const result = await pool.query(query);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch products for type' });
  }
};

exports.addProductType = async (req, res) => {
  try {
    const { product_type } = req.body;

    if (!product_type) {
      return res.status(400).json({ message: 'Product type is required' });
    }

    const formattedProductType = product_type.toLowerCase().replace(/\s+/g, '_');

    const typeCheck = await pool.query(
      'SELECT product_type FROM public.products WHERE product_type = $1',
      [formattedProductType]
    );

    if (typeCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Product type already exists' });
    }

    await pool.query(
      'INSERT INTO public.products (product_type) VALUES ($1)',
      [formattedProductType]
    );

    const tableName = formattedProductType;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.${tableName} (
        id BIGSERIAL PRIMARY KEY,
        productname TEXT NOT NULL,
        price NUMERIC(10,2) NOT NULL,
        case_count INTEGER NOT NULL,
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
    const result = await pool.query('SELECT product_type FROM public.products');
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch product types' });
  }
};

exports.addBrand = async (req, res) => {
  try {
    const { brand } = req.body;

    if (!brand) {
      return res.status(400).json({ message: 'Brand is required' });
    }

    const formattedBrand = brand.toLowerCase().replace(/\s+/g, '_');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.brand (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR NOT NULL UNIQUE
      )
    `);

    const brandCheck = await pool.query(
      'SELECT name FROM public.brand WHERE name = $1',
      [formattedBrand]
    );

    if (brandCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Brand already exists' });
    }

    await pool.query(
      'INSERT INTO public.brand (name) VALUES ($1)',
      [formattedBrand]
    );

    res.status(201).json({ message: 'Brand created successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to create brand' });
  }
};

exports.getBrands = async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM public.brand');
    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch brands' });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const { tableName, id } = req.params;
    const query = `DELETE FROM public.${tableName} WHERE id = $1 RETURNING id`;
    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.status(200).json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete product' });
  }
};