const mysql = require("mysql2/promise");

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "msongola_results",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: "utf8mb4",
};

const pool = mysql.createPool(config);

pool.testConnection = async () => {
  const connection = await pool.getConnection();

  try {
    await connection.ping();
    return {
      ok: true,
      host: config.host,
      database: config.database,
    };
  } finally {
    connection.release();
  }
};

module.exports = pool;
