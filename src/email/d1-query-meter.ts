// Counts D1 queries so an email run stays inside the per-invocation query limit (Workers Paid:
// 1000 per invocation, a db.batch() counts as one). A waitUntil run shares that limit with the
// request that scheduled it, so it gets a small cap; the email cron owns its invocation and gets a
// larger one with headroom. Either way the run stops early instead of hitting the limit.

export class QueryBudget {
  used = 0;
  constructor(readonly cap: number) {}
  get remaining() {
    return Math.max(0, this.cap - this.used);
  }
  /** True when at least `n` more queries fit under the cap. */
  allows(n: number) {
    return this.remaining >= n;
  }
}

/** Thrown by a step that would not fit in the budget; the caller stops and leaves the rest for the next run. */
export class QueryBudgetExhausted extends Error {
  constructor() {
    super('email run query budget exhausted');
    this.name = 'QueryBudgetExhausted';
  }
}

/** Unlimited budget for direct calls (tests, scripts). */
export const unmetered = () => new QueryBudget(Number.MAX_SAFE_INTEGER);

class MeteredStatement {
  constructor(readonly inner: D1PreparedStatement, private readonly budget: QueryBudget) {}
  bind(...values: unknown[]) {
    return new MeteredStatement(this.inner.bind(...values), this.budget);
  }
  first<T>(column?: string) {
    this.budget.used++;
    return column === undefined ? this.inner.first<T>() : this.inner.first<T>(column);
  }
  all<T>() {
    this.budget.used++;
    return this.inner.all<T>();
  }
  run<T>() {
    this.budget.used++;
    return this.inner.run<T>();
  }
  raw<T>() {
    this.budget.used++;
    return this.inner.raw<T>();
  }
}

const unwrap = (s: D1PreparedStatement) => (s instanceof MeteredStatement ? s.inner : s);

/**
 * A D1Database whose prepared statements and batches are counted against `budget`. Only the
 * methods the email code uses (prepare, batch) are provided; statements built from it can be
 * mixed into its batch() freely.
 */
export function meteredDb(db: D1Database, budget: QueryBudget): D1Database {
  const metered = {
    prepare: (sql: string) => new MeteredStatement(db.prepare(sql), budget),
    batch: <T>(statements: D1PreparedStatement[]) => {
      budget.used++;
      return db.batch<T>(statements.map(unwrap));
    },
  };
  // The wrapper implements the D1Database surface the email modules call (prepare/bind/first/all/run/raw/batch).
  return metered as unknown as D1Database;
}
