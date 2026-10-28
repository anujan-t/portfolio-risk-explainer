import { useState, type CSSProperties, type ReactNode } from 'react';
import { isNum, percent } from '../lib/format';
import { cx } from './ui';

export interface DivergingDatum {
  key: string;
  label: ReactNode;
  value: number | null;
  display: ReactNode;
  title?: string;
}

/** Horizontal bars around a centre axis. Market tone colours gains/losses (values always carry ▲/▼ text); neutral tone does not. */
export function DivergingBars({ data, tone = 'market', label }: { data: DivergingDatum[]; tone?: 'market' | 'neutral'; label: string }) {
  const max = Math.max(0, ...data.map(item => (isNum(item.value) ? Math.abs(item.value) : 0))) || 1;
  return (
    <ul className={cx('dbars', `dbars--${tone}`)} role="list" aria-label={label}>
      {data.map(item => {
        const value = item.value;
        const share = isNum(value) && value !== 0 ? Math.max(0.8, (Math.abs(value) / max) * 50) : 0;
        const negative = isNum(value) && value < 0;
        const style: CSSProperties = negative ? { right: '50%', width: `${share}%` } : { left: '50%', width: `${share}%` };
        return (
          <li key={item.key} className="dbars__row" title={item.title}>
            <span className="dbars__label">{item.label}</span>
            <span className="dbars__track" aria-hidden="true">
              <span className="dbars__axis" />
              {share > 0 && <span className={cx('dbars__bar', negative ? 'dbars__bar--neg' : 'dbars__bar--pos')} style={style} />}
            </span>
            <span className="dbars__value">{item.display}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Ink tint for the n-th of `count` segments: a continuous ramp from light (largest) to dark (smallest), never repeating. */
function shadeFor(index: number, count: number): string {
  if (count <= 1) return '78%';
  return `${Math.round(84 - (index / (count - 1)) * 62)}%`;
}

export interface CompositionItem {
  key: string;
  label: ReactNode;
  text: string;
  weight: number;
}

/** One stacked bar of weights with a legend. Neutral ink tints; the hovered or focused entry is outlined in brass. */
export function CompositionBar({ items, label }: { items: CompositionItem[]; label: string }) {
  const [active, setActive] = useState<string | null>(null);
  const shown = items.filter(item => isNum(item.weight) && item.weight > 0);
  if (!shown.length) return <p className="faint">No weights to show.</p>;
  const shade = (index: number) => shadeFor(index, shown.length);
  return (
    <div className="comp">
      <div className="comp__bar" role="img" aria-label={`${label}: ${shown.map(item => `${item.text} ${percent(item.weight, 1)}`).join(', ')}`}>
        {shown.map((item, index) => (
          <span
            key={item.key}
            className={cx('comp__seg', active === item.key && 'is-active')}
            style={{ flexGrow: item.weight, '--shade': shade(index) } as CSSProperties}
            title={`${item.text}: ${percent(item.weight, 1)}`}
            onMouseEnter={() => setActive(item.key)}
            onMouseLeave={() => setActive(null)}
          />
        ))}
      </div>
      <ul className="comp__legend" role="list">
        {shown.map((item, index) => (
          <li
            key={item.key}
            className={cx('comp__entry', active === item.key && 'is-active')}
            onMouseEnter={() => setActive(item.key)}
            onMouseLeave={() => setActive(null)}
          >
            <span className="comp__swatch" style={{ '--shade': shade(index) } as CSSProperties} aria-hidden="true" />
            <span className="comp__label">{item.label}</span>
            <span className="comp__weight">{percent(item.weight, 1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Thin brass weight meter used inside ledger cells. */
export function WeightMeter({ weight, max = 1 }: { weight: number; max?: number }) {
  const width = isNum(weight) && max > 0 ? Math.max(0, Math.min(100, (weight / max) * 100)) : 0;
  return (
    <span className="meter" aria-hidden="true">
      <span className="meter__fill" style={{ width: `${width}%` }} />
    </span>
  );
}
