import { monthTick, parseDate } from '../../lib/format';

export type Scale = (value: number) => number;

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return value => r0 + ((value - d0) / span) * (r1 - r0);
}

function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const error = raw / power;
  const factor = error >= 7.5 ? 10 : error >= 3.5 ? 5 : error >= 1.5 ? 2 : 1;
  return factor * power;
}

/** A padded domain that starts and ends on "nice" tick values, plus those ticks. */
export function niceAxis(min: number, max: number, count = 4): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { domain: [0, 1], ticks: [0, 1] };
  let low = min;
  let high = max;
  if (low === high) {
    const pad = Math.abs(low) * 0.05 || 1;
    low -= pad;
    high += pad;
  }
  const step = niceStep(high - low, count);
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= end + step * 1e-6; value += step) ticks.push(Number((Math.round(value / step) * step).toPrecision(12)));
  return { domain: [start, end], ticks };
}

export function linePath(xs: number[], ys: number[]): string {
  let path = '';
  let open = false;
  for (let index = 0; index < xs.length; index += 1) {
    const x = xs[index];
    const y = ys[index];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      open = false;
      continue;
    }
    path += `${open ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    open = true;
  }
  return path;
}

export function areaPath(xs: number[], ys: number[], baseline: number): string {
  const valid: number[] = [];
  for (let index = 0; index < xs.length; index += 1) if (Number.isFinite(xs[index]) && Number.isFinite(ys[index])) valid.push(index);
  if (valid.length < 2) return '';
  const first = valid[0];
  const last = valid[valid.length - 1];
  let path = `M${xs[first].toFixed(1)},${baseline.toFixed(1)}`;
  for (const index of valid) path += `L${xs[index].toFixed(1)},${ys[index].toFixed(1)}`;
  path += `L${xs[last].toFixed(1)},${baseline.toFixed(1)}Z`;
  return path;
}

/** Index of the item whose x is nearest to `target` (xs ascending). */
export function nearestIndex(xs: number[], target: number, lo = 0, hi = xs.length - 1): number {
  if (hi <= lo) return lo;
  let left = lo;
  let right = hi;
  while (right - left > 1) {
    const middle = (left + right) >> 1;
    if (xs[middle] < target) left = middle;
    else right = middle;
  }
  return Math.abs(xs[left] - target) <= Math.abs(xs[right] - target) ? left : right;
}

export interface TimeTick {
  time: number;
  label: string;
}

const MONTH_STEPS = [1, 2, 3, 6, 12, 24, 60, 120];

/** Month/year ticks that fit the available width (about one label per 72px). */
export function timeTicks(start: number, end: number, width: number): TimeTick[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || width <= 0) return [];
  const months = (end - start) / (30.44 * 86_400_000);
  const capacity = Math.max(1, Math.floor(width / 72));
  const step = MONTH_STEPS.find(candidate => months / candidate <= capacity) ?? MONTH_STEPS[MONTH_STEPS.length - 1];
  const first = new Date(start);
  const cursor = new Date(first.getFullYear(), first.getMonth() + 1, 1, 12);
  const ticks: TimeTick[] = [];
  let guard = 0;
  while (cursor.getTime() <= end && guard < 2000) {
    guard += 1;
    const month = cursor.getMonth();
    const year = cursor.getFullYear();
    const aligned = step >= 12 ? month === 0 && year % (step / 12) === 0 : month % step === 0;
    if (aligned) {
      const label = step >= 12 ? String(year) : monthTick(cursor, month === 0 || ticks.length === 0);
      ticks.push({ time: cursor.getTime(), label });
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  if (!ticks.length && months < 1.2) {
    const middle = new Date((start + end) / 2);
    ticks.push({ time: middle.getTime(), label: monthTick(middle, true) });
  }
  return ticks;
}

export function times(dates: string[]): number[] {
  return dates.map(date => parseDate(date)?.getTime() ?? Number.NaN);
}

/** Read the --lx-* token-driven font sizes for SVG text consistently. */
export const AXIS_FONT = 11;
