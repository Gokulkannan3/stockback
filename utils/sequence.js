// utils/sequence.js
const { Pool } = require('pg');
const pool = new Pool({
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
});

const getNextSequenceNumber = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      UPDATE sequence_counter 
      SET current_value = current_value + 1 
      WHERE counter_name = 'bill_challan_sequence'
      RETURNING current_value
    `);

    let nextNumber;
    if (result.rowCount === 0) {
      // First time ever
      await client.query(`
        INSERT INTO sequence_counter (counter_name, current_value) 
        VALUES ('bill_challan_sequence', 1)
      `);
      nextNumber = 1;
    } else {
      nextNumber = result.rows[0].current_value;
    }

    await client.query('COMMIT');
    return nextNumber;
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error('Failed to generate sequence number: ' + err.message);
  } finally {
    client.release();
  }
};

module.exports = { getNextSequenceNumber };