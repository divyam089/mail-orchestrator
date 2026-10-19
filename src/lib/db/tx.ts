import { Pool, type PoolClient } from "pg";
import type { Db } from "@/lib/db/pool";

function isPool(db: Db): db is Pool {
  return typeof (db as Pool).connect === "function" && typeof (db as PoolClient).release !== "function";
}

/** Starts a transaction on a Pool. A PoolClient is already in the caller's transaction. */
export async function withOptionalTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if (!isPool(db)) return fn(db);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
