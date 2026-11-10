// Deterministic ad planner (the "Grok Bot" planning role, without an LLM): splits one flight's
// budget across the configured channels. It only ever sees one flight, which is funded by exactly
// one cohort of one board, so it cannot spend across boards. Invariants (tested):
//   sum(daily) <= daily_cap, sum(amount) <= spend_cap, amount = daily * days, every daily >= its channel minimum.
import { type AdsChannel, wholeUnit } from './zernio-ads-adapter';

export const ADS_PLAN_POLICY = 'ads-plan-v1';

export interface FlightBudget {
  currency: string;
  spendCapMinor: number;
  dailyCapMinor: number;
  days: number;
}

export interface PlannedAllocation {
  channel: string;
  dailyMinor: number;
  amountMinor: number;
}

export interface FlightPlan {
  allocations: PlannedAllocation[];
  /** Fund not allocated to any channel; it stays with the flight (never moved to another board or to revenue). */
  unallocatedMinor: number;
  reasons: string[];
}

/**
 * Optional planner hook (off by default): may reorder or drop channels, never change amounts.
 * Whatever it returns is re-checked by the same deterministic rules.
 */
export type ChannelPreference = (channels: AdsChannel[], flight: FlightBudget) => AdsChannel[];

export function planFlight(flight: FlightBudget, configured: AdsChannel[], prefer?: ChannelPreference): FlightPlan {
  const unit = wholeUnit(flight.currency);
  const days = Math.max(1, Math.floor(flight.days));
  const cap = Math.max(0, Math.floor(flight.spendCapMinor));
  // Daily budget: within the daily cap and within cap / days, in whole currency units only.
  const dailyTotal = Math.floor(Math.min(Math.max(0, flight.dailyCapMinor), Math.floor(cap / days)) / unit) * unit;
  if (!configured.length) return { allocations: [], unallocatedMinor: cap, reasons: ['NO_CHANNELS_CONFIGURED'] };
  const known = new Set(configured.map(c => c.channel));
  const channels = (prefer ? prefer([...configured], flight) : configured).filter(c => known.has(c.channel));
  const minOf = (c: AdsChannel) => Math.max(unit, Math.ceil((c.minDailyMinor ?? unit) / unit) * unit);

  // Use as many channels (in order) as the daily budget can fund at each one's minimum.
  for (let n = channels.length; n >= 1; n--) {
    const picked = channels.slice(0, n);
    const units = dailyTotal / unit;
    const base = Math.floor(units / n);
    const extra = units - base * n;
    const daily = picked.map((_, i) => (base + (i < extra ? 1 : 0)) * unit);
    if (picked.every((c, i) => daily[i] >= minOf(c))) {
      const allocations = picked.map((c, i) => ({ channel: c.channel, dailyMinor: daily[i], amountMinor: daily[i] * days }));
      const allocated = allocations.reduce((a, x) => a + x.amountMinor, 0);
      return { allocations, unallocatedMinor: cap - allocated, reasons: n < channels.length ? ['SOME_CHANNELS_BELOW_MINIMUM'] : [] };
    }
  }
  return { allocations: [], unallocatedMinor: cap, reasons: ['BELOW_CHANNEL_MINIMUM'] };
}
