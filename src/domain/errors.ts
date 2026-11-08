export class DomainError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
export const forbidden = (msg = 'Not allowed for this account') => new DomainError('forbidden', msg, 403);
export const notFound = (msg = 'Not found') => new DomainError('not_found', msg, 404);

/** D1 surfaces SQLite constraint failures as errors whose message names the constraint. */
export const isConstraintError = (e: unknown) =>
  e instanceof Error && /UNIQUE constraint|CHECK constraint|constraint failed|SQLITE_CONSTRAINT/i.test(`${e.message} ${String((e as { cause?: unknown }).cause ?? '')}`);
