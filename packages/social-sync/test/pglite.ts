import { PGlite, types, type Results } from "@electric-sql/pglite";
import type { PgPoolLike, PgQueryable } from "../src/storage/postgres.js";

export interface PglitePool extends PgPoolLike {
  readonly db: PGlite;
  end(): Promise<void>;
}

export interface PglitePoolOptions {
  /**
   * How BIGINT columns come back. "string" (default) is what `pg` does, so the storage's numeric fix-up is exercised;
   * "number" is PGlite's own parsing.
   */
  int8?: "string" | "number";
}

/** FIFO async lock. */
function mutex(): () => Promise<() => void> {
  let tail: Promise<void> = Promise.resolve();
  return () => {
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => (unlock = resolve));
    const acquired = tail.then(() => unlock);
    tail = tail.then(() => held);
    return acquired;
  };
}

// PGlite is one connection: every pool over the same instance shares its lock.
const locks = new WeakMap<PGlite, () => Promise<() => void>>();

/**
 * A `pg.Pool` with a single connection, backed by PGlite (in-process WASM Postgres). `connect()` checks the
 * connection out exclusively until `release()`, and `pool.query()` waits for it like any other caller, so statements
 * from different callers never land in another caller's transaction.
 */
export function pglitePool(db: PGlite, options: PglitePoolOptions = {}): PglitePool {
  let lock = locks.get(db);
  if (!lock) locks.set(db, (lock = mutex()));
  const acquire = lock;
  const queryOptions = options.int8 === "number" ? {} : { parsers: { [types.INT8]: (value: string) => value } };

  const run = async (text: string, values?: unknown[]) => {
    // pg sends undefined as NULL.
    const res: Results<any> = await db.query(text, values?.map((v) => (v === undefined ? null : v)), queryOptions);
    return { rows: res.rows, rowCount: res.rowCount ?? (res.command === "SELECT" ? res.rows.length : (res.affectedRows ?? null)) };
  };

  return {
    db,
    async query(text, values) {
      const unlock = await acquire();
      try {
        return await run(text, values);
      } finally {
        unlock();
      }
    },
    async connect() {
      const unlock = await acquire();
      let released = false;
      const client: PgQueryable & { release(err?: Error | boolean): void } = {
        query(text, values) {
          if (released) return Promise.reject(new Error("query on a released client"));
          return run(text, values);
        },
        release(err) {
          if (released) throw new Error("client released twice");
          released = true;
          // pg discards a connection released with an error; the closest thing here is aborting whatever it left open.
          if (err) void db.query("ROLLBACK").catch(() => {}).finally(unlock);
          else unlock();
        },
      };
      return client;
    },
    async end() {
      if (!db.closed) await db.close();
    },
  };
}

/** A new in-memory PGlite database. */
export function newPglite(): Promise<PGlite> {
  return PGlite.create();
}
