// Display formatting for money, dates and boards. Pure functions; no locale guessing at runtime.
import type { BoardCode, MoneyLine } from './types';

const ICT_OFFSET_MS = 7 * 3600 * 1000;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Decimal places used for a currency's minor unit. VND has none; USD and most others have 2. */
export function currencyDecimals(currency: string): number {
  const c = currency.toUpperCase();
  return c === 'VND' || c === 'JPY' || c === 'KRW' ? 0 : 2;
}

function formatMinor(minor: number, decimals: number): string {
  const safe = Number.isFinite(minor) ? Math.trunc(minor) : 0;
  const negative = safe < 0;
  const abs = Math.abs(safe);
  let body: string;
  if (decimals === 0) {
    body = groupThousands(String(abs));
  } else {
    const factor = 10 ** decimals;
    const whole = Math.floor(abs / factor);
    const frac = String(abs % factor).padStart(decimals, '0');
    body = `${groupThousands(String(whole))}.${frac}`;
  }
  return negative ? `-${body}` : body;
}

/** Rank units are USD cents: 1200 → "$12.00". */
export function formatRankUnits(units: number): string {
  const s = formatMinor(units, 2);
  return s.startsWith('-') ? `-$${s.slice(1)}` : `$${s}`;
}

/** "250,000 ₫" for VND, "$12.00" for USD, "12.00 EUR" otherwise. */
export function formatMoney(currency: string, minor: number): string {
  const c = currency.toUpperCase();
  const s = formatMinor(minor, currencyDecimals(c));
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const sign = neg ? '-' : '';
  if (c === 'USD') return `${sign}$${body}`;
  if (c === 'VND') return `${sign}${body} ₫`;
  return `${sign}${body} ${c}`;
}

export function formatMoneyLine(line: MoneyLine): string {
  return formatMoney(line.currency, line.minor);
}

/** Signed money for ledger deltas: "+$1.20" / "-250,000 ₫". */
export function formatSignedMoney(currency: string, minor: number): string {
  const s = formatMoney(currency, minor);
  return minor > 0 ? `+${s}` : s;
}

export function boardLabel(board: BoardCode): string {
  return board === 'daily' ? 'Daily' : board === 'weekly' ? 'Weekly' : 'Monthly';
}

/** Active window of one contribution on each board. */
export function boardWindow(board: BoardCode): string {
  return board === 'daily' ? '24 hours' : board === 'weekly' ? '7 days' : '30 days';
}

export const BOARDS: readonly BoardCode[] = ['daily', 'weekly', 'monthly'];

function parse(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "03:12" in Indochina Time (UTC+7, no daylight saving). */
export function formatIctTime(iso: string): string {
  const d = parse(iso);
  if (!d) return '';
  const t = new Date(d.getTime() + ICT_OFFSET_MS);
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/** "2026-11-08 03:12 ICT". */
export function formatIctDateTime(iso: string): string {
  const d = parse(iso);
  if (!d) return iso;
  const t = new Date(d.getTime() + ICT_OFFSET_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} ICT`;
}

/** Remaining time until an ISO instant as HH:MM:SS (never negative). */
export function formatCountdown(iso: string, now: number = Date.now()): string {
  const d = parse(iso);
  if (!d) return '--:--:--';
  const s = Math.max(0, Math.floor((d.getTime() - now) / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function formatCount(n: number): string {
  return groupThousands(String(Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0))));
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}
