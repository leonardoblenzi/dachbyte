// @ts-check
"use strict";

const { Pool } = require("pg");

/** @param {string} url */
function sslConfig(url) {
  if (/sslmode=(require|prefer|verify-ca|verify-full)/i.test(url) || /\.neon\.(tech|build)/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

/**
 * Pool do Postgres com search_path no schema do Hub.
 * @param {{ databaseUrl: string, schema: string }} config
 */
function createDb(config) {
  if (!config.databaseUrl) {
    const fail = async () => { throw Object.assign(new Error("Banco do DACH Hub não configurado (HUB_DATABASE_URL/DATABASE_URL)."), { status: 503 }); };
    return { query: fail, queryOne: fail, transaction: fail, close: async () => {} };
  }
  const pool = new Pool({ connectionString: config.databaseUrl, ssl: sslConfig(config.databaseUrl), max: 10 });
  pool.on("connect", (client) => { client.query(`set search_path to ${config.schema}, public`).catch(() => {}); });

  /** @param {string} sql @param {unknown[]} [params] */
  const query = (sql, params = []) => pool.query(sql, params);
  /** @param {string} sql @param {unknown[]} [params] */
  const queryOne = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;
  /** @template T @param {(client: import("pg").PoolClient) => Promise<T>} work @returns {Promise<T>} */
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { query, queryOne, transaction, close: () => pool.end() };
}

module.exports = { createDb, _test: { sslConfig } };
