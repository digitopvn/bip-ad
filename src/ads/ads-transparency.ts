// View model of the public /transparency page: per-board ads funds and every recent flight with
// its caps, money states, the freshness of its metrics (as_of_at) and their source.
import { BOARDS, type Board, type Config } from '../domain/config';
import { DAY_MS, iso } from '../lib/time';
import { readKillSwitch } from './ads-safety-controls';

export interface TransparencyFlight {
  id: string;
  board: Board;
  currency: string;
  cutoffAt: string;
  startAt: string;
  endAt: string;
  spendCapMinor: number;
  dailyCapMinor: number;
  plannedMinor: number;
  committedMinor: number;
  spentMinor: number;
  unallocatedMinor: number;
  state: string;
  adapterStatus: string;
  metricsAsOfAt: string | null;
  metricsSource: string | null;
  metricsState: string | null;
}

export interface TransparencyFund {
  board: Board;
  currency: string;
  fundedMinor: number;
  spentMinor: number;
}

export interface TransparencyView {
  asOfAt: string;
  /** Where the money figures come from. */
  source: string;
  adsMode: Config['adsMode'];
  killSwitchEngaged: boolean;
  funds: TransparencyFund[];
  flights: TransparencyFlight[];
}

/** Flights whose window ended within this period stay listed. */
export const TRANSPARENCY_WINDOW_MS = 35 * DAY_MS;

export async function buildTransparencyView(db: D1Database, cfg: Config, nowMs = Date.now()): Promise<TransparencyView> {
  const since = iso(nowMs - TRANSPARENCY_WINDOW_MS);
  const [funds, flights] = await db.batch<Record<string, unknown>>([
    // Funded = the 80% ads funds of finalized cohorts, from the ledger-backed cohort records.
    db.prepare(`SELECT c.board, c.currency, SUM(c.ads_fund_minor) AS funded, COALESCE(SUM(f.spent_minor), 0) AS spent
        FROM revenue_cohorts c LEFT JOIN ad_flights f ON f.cohort_id = c.id GROUP BY c.board, c.currency HAVING funded > 0`),
    db.prepare(`SELECT f.id, f.board, f.currency, c.cutoff_at, f.start_at, f.end_at, f.spend_cap_minor, f.daily_cap_minor, f.planned_minor, f.committed_minor, f.spent_minor,
          f.unallocated_minor, f.state, f.adapter_status, m.as_of_at, m.source, m.state AS metric_state
        FROM ad_flights f JOIN revenue_cohorts c ON c.id = f.cohort_id
        LEFT JOIN ad_metrics m ON m.id = (SELECT id FROM ad_metrics WHERE flight_id = f.id ORDER BY hour DESC LIMIT 1)
        WHERE f.end_at > ? ORDER BY f.start_at DESC, f.board LIMIT 150`).bind(since),
  ]);
  const order = (b: unknown) => BOARDS.indexOf(b as Board);
  return {
    asOfAt: iso(nowMs),
    source: 'bip.ad ledger and ad flight records (D1)',
    adsMode: cfg.adsMode,
    killSwitchEngaged: (await readKillSwitch(db, cfg)).engaged,
    funds: funds.results.map(r => ({ board: r.board as Board, currency: String(r.currency), fundedMinor: Number(r.funded), spentMinor: Number(r.spent) }))
      .sort((a, b) => order(a.board) - order(b.board) || a.currency.localeCompare(b.currency)),
    flights: flights.results.map(r => ({
      id: String(r.id), board: r.board as Board, currency: String(r.currency), cutoffAt: String(r.cutoff_at), startAt: String(r.start_at), endAt: String(r.end_at),
      spendCapMinor: Number(r.spend_cap_minor), dailyCapMinor: Number(r.daily_cap_minor), plannedMinor: Number(r.planned_minor), committedMinor: Number(r.committed_minor),
      spentMinor: Number(r.spent_minor), unallocatedMinor: Number(r.unallocated_minor), state: String(r.state), adapterStatus: String(r.adapter_status),
      metricsAsOfAt: (r.as_of_at as string | null) ?? null, metricsSource: (r.source as string | null) ?? null, metricsState: (r.metric_state as string | null) ?? null,
    })),
  };
}
