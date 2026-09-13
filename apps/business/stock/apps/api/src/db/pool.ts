import pg from 'pg';
import { env } from '../config/env';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  max: 12,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});
