import { Pool, type PoolClient } from "pg";

const globalForPg = globalThis as unknown as { outreachPool?: Pool };

export type Db = Pool | PoolClient;

export function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!globalForPg.outreachPool) {
    globalForPg.outreachPool = new Pool({ connectionString: url, max: 8 });
  }
  return globalForPg.outreachPool;
}
