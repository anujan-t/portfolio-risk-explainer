import type { Frequency, HistoryRange } from '../types';

export const DASH = '—';
const MINUS = '\u2212';
const LOCALE: string | undefined = undefined;

export const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, options);
    numberFormats.set(key, format);
  }
  return format;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function df(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(LOCALE, options);
    dateFormats.set(key, format);
  }
  return format;
}

/** Replace the ASCII hyphen sign with a true minus so signed figures align in tabular columns. */
const minus = (text: string) => text.replace(/-/g, MINUS);

/** Plain number with a fixed number of decimals. */
export function num(value: number | null | undefined, digits = 2, minDigits = digits): string {
  if (!isNum(value)) return DASH;
  return minus(nf({ minimumFractionDigits: minDigits, maximumFractionDigits: digits }).format(value));
}

/** Share quantities: up to 6 decimals, trailing zeros trimmed, grouped. */
export function quantity(value: number | null | undefined): string {
  return num(value, 6, 0);
}

/** Exchange rates: four decimals, or four significant digits for small rates (JPY → USD 0.006345). */
export function fxRate(value: number | null | undefined): string {
  if (!isNum(value)) return DASH;
  const abs = Math.abs(value);
  if (abs >= 1 || abs === 0) return num(value, 4);
  const digits = Math.min(8, Math.max(4, 3 - Math.floor(Math.log10(abs))));
  return num(value, digits);
}

const currencyDigitCache = new Map<string, number>();
export function currencyDigits(iso: string): number {
  const cached = currencyDigitCache.get(iso);
  if (cached !== undefined) return cached;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency: iso }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    digits = 2;
  }
  currencyDigitCache.set(iso, digits);
  return digits;
}

/** A base-currency amount without the currency code (the code is shown in headers or beside the figure). */
export function amount(value: number | null | undefined, iso: string, digits = currencyDigits(iso)): string {
  return num(value, digits, digits);
}

/** A money value with its ISO code, formatted by Intl for any ISO 4217 currency. */
export function money(value: number | null | undefined, iso: string, digits?: number): string {
  if (!isNum(value)) return DASH;
  const fraction = digits ?? currencyDigits(iso);
  try {
    return minus(
      nf({ style: 'currency', currency: iso, currencyDisplay: 'code', minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(value),
    );
  } catch {
    return `${num(value, fraction)} ${iso}`;
  }
}

/** Whole and fractional parts of an amount, for typesetting large figures ("1,234,567" + ".89"). */
export function amountParts(value: number, iso: string): { whole: string; fraction: string } {
  const digits = currencyDigits(iso);
  const parts = nf({ minimumFractionDigits: digits, maximumFractionDigits: digits }).formatToParts(value);
  let whole = '';
  let fraction = '';
  let afterDecimal = false;
  for (const part of parts) {
    if (part.type === 'decimal') afterDecimal = true;
    if (afterDecimal) fraction += part.value;
    else whole += part.value;
  }
  return { whole: minus(whole), fraction };
}

/** Compact money, e.g. "USD 48.2K", for chart labels and tight spaces. */
export function moneyCompact(value: number | null | undefined, iso: string): string {
  if (!isNum(value)) return DASH;
  try {
    return minus(nf({ style: 'currency', currency: iso, currencyDisplay: 'code', notation: 'compact', maximumFractionDigits: 1 }).format(value));
  } catch {
    return `${compact(value)} ${iso}`;
  }
}

export function compact(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) return DASH;
  return minus(nf({ notation: 'compact', maximumFractionDigits: digits }).format(value));
}

/** Fractions (0.052) as percentages (5.2%). */
export function percent(value: number | null | undefined, digits = 1, signed = false): string {
  if (!isNum(value)) return DASH;
  return minus(
    nf({ style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: signed ? 'exceptZero' : 'auto' }).format(value),
  );
}

/** Percentage-point change between two fractions. */
export function points(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) return DASH;
  return `${minus(nf({ minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: 'exceptZero' }).format(value * 100))} pp`;
}

export function signedNum(value: number | null | undefined, digits = 2): string {
  if (!isNum(value)) return DASH;
  return minus(nf({ minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: 'exceptZero' }).format(value));
}

/** True when a value rounds to zero at the displayed precision. */
export function roundsToZero(value: number, digits: number, percentScale = false): boolean {
  const scaled = percentScale ? value * 100 : value;
  return Math.abs(scaled) < 0.5 * 10 ** -digits;
}

// Minor-unit quote currencies cannot be formatted by Intl (GBp is pence, not an ISO code).
const MINOR_UNITS: Record<string, string> = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ZAC: 'ZAR', ILA: 'ILS' };

export function isMinorUnit(currency: string, scale = 1): boolean {
  return scale !== 1 || currency in MINOR_UNITS;
}

export function quoteDigits(price: number, currency: string, scale = 1): number {
  let digits = isMinorUnit(currency, scale) ? 2 : currencyDigits(currency);
  const size = Math.abs(price);
  if (size > 0 && size < 1) digits = Math.max(digits, 4);
  return digits;
}

/** A price in the units it is quoted in, e.g. "117.85 GBp" or "227.48 USD". */
export function quotePrice(price: number | null | undefined, currency: string, scale = 1): string {
  if (!isNum(price)) return DASH;
  return `${num(price, quoteDigits(price, currency, scale))} ${currency}`;
}

export function quoteNumber(price: number | null | undefined, currency: string, scale = 1): string {
  if (!isNum(price)) return DASH;
  return num(price, quoteDigits(price, currency, scale));
}

/** Describe a quote currency and its scale, e.g. "GBp (pence, × 0.01 = GBP)". */
export function quoteUnitLabel(currency: string, iso: string, scale: number): string {
  if (scale === 1 && currency === iso) return iso;
  return `${currency} (× ${num(scale, 4, 0)} = ${iso})`;
}

// ---- Dates ----------------------------------------------------------------

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function dateValue(value: string): number {
  return parseDate(value)?.getTime() ?? Number.NaN;
}

type DateStyle = 'day' | 'medium' | 'long' | 'month';
const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  day: { month: 'short', day: 'numeric' },
  medium: { month: 'short', day: 'numeric', year: 'numeric' },
  long: { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
  month: { month: 'short', year: 'numeric' },
};

export function fmtDate(value: string | Date | null | undefined, style: DateStyle = 'medium'): string {
  const parsed = value instanceof Date ? value : parseDate(value);
  if (!parsed) return typeof value === 'string' && value ? value : DASH;
  return df(DATE_STYLES[style]).format(parsed);
}

export function fmtTime(value: string | Date | null | undefined): string {
  const parsed = value instanceof Date ? value : parseDate(value);
  if (!parsed) return DASH;
  return df({ hour: 'numeric', minute: '2-digit' }).format(parsed);
}

/** "Oct 27" within the current year, otherwise "Oct 27, 2025". */
export function shortDate(value: string | null | undefined, now: Date = new Date()): string {
  const parsed = parseDate(value);
  if (!parsed) return DASH;
  return fmtDate(parsed, parsed.getFullYear() === now.getFullYear() ? 'day' : 'medium');
}

/** "Mar 2 – Oct 27" in the current year, "Mar 2 – Oct 27, 2024" within one year, otherwise both years. */
export function dateRange(start: string | null | undefined, end: string | null | undefined, now: Date = new Date()): string {
  const from = parseDate(start);
  const to = parseDate(end);
  if (!from || !to) return `${shortDate(start, now)} – ${shortDate(end, now)}`;
  if (from.getFullYear() !== to.getFullYear()) return `${fmtDate(from)} – ${fmtDate(to)}`;
  if (to.getFullYear() === now.getFullYear()) return `${fmtDate(from, 'day')} – ${fmtDate(to, 'day')}`;
  return `${fmtDate(from, 'day')} – ${fmtDate(to)}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Closes a sentence unless it already ends with punctuation, e.g. a locale time such as "1:35 p.m.". */
export function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** Time only for today, otherwise date and time. */
export function fmtWhen(value: string | null | undefined, now: Date = new Date()): string {
  const parsed = parseDate(value);
  if (!parsed) return DASH;
  if (sameDay(parsed, now)) return fmtTime(parsed);
  if (parsed.getFullYear() === now.getFullYear()) return df({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(parsed);
  return df({ month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(parsed);
}

export function fmtTimestamp(value: string | null | undefined): string {
  const parsed = parseDate(value);
  if (!parsed) return DASH;
  return df({ month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(parsed);
}

export function relative(value: string | null | undefined, now: number = Date.now()): string {
  const parsed = parseDate(value);
  if (!parsed) return DASH;
  const diff = now - parsed.getTime();
  // Timestamps a little "ahead" come from a clock tick that has not caught up yet or small clock skew.
  if (diff < 45_000 && diff > -900_000) return 'just now';
  const future = diff < 0;
  const span = Math.abs(diff);
  const minutes = Math.round(span / 60_000);
  if (minutes < 60) return future ? `in ${minutes} min` : `${minutes} min ago`;
  const hours = Math.round(span / 3_600_000);
  if (hours < 24) return future ? `in ${hours} h` : `${hours} h ago`;
  const days = Math.round(span / 86_400_000);
  if (days < 7) return future ? `in ${days} d` : `${days} d ago`;
  return fmtDate(parsed, 'medium');
}

/** Axis label for a month, e.g. "Oct ’26". */
export function monthTick(date: Date, withYear: boolean): string {
  const month = df({ month: 'short' }).format(date);
  return withYear ? `${month} ’${String(date.getFullYear()).slice(2)}` : month;
}

// ---- Labels -----------------------------------------------------------------

const RANGE_LABELS: Record<HistoryRange, string> = { '6mo': '6M', '1y': '1Y', '2y': '2Y', '5y': '5Y', '10y': '10Y', max: 'Max' };
const RANGE_WORDS: Record<HistoryRange, string> = {
  '6mo': '6 months',
  '1y': '1 year',
  '2y': '2 years',
  '5y': '5 years',
  '10y': '10 years',
  max: 'maximum history',
};
export const rangeLabel = (range: HistoryRange) => RANGE_LABELS[range] ?? range;
export const rangeWords = (range: HistoryRange) => RANGE_WORDS[range] ?? range;

const FREQUENCY_LABELS: Record<Frequency, string> = { auto: 'Auto', daily: 'Daily', weekly: 'Weekly' };
export const frequencyLabel = (frequency: Frequency) => FREQUENCY_LABELS[frequency] ?? frequency;
export const horizonLabel = (horizon: 'day' | 'week') => (horizon === 'week' ? '1-week' : '1-day');

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
