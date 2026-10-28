import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import type { Analysis } from '../../types';
import { useElementSize } from '../../lib/hooks';
import { fmtDate, num, points as pp } from '../../lib/format';
import { Delta } from '../ui';
import { AXIS_FONT, areaPath, linePath, linear, nearestIndex, niceAxis, timeTicks, times } from './scale';
import { safeId } from './Sparkline';

type SeriesPoint = Analysis['series'][number];

const digitsFor = (ticks: number[]) => {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
  return step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
};

/**
 * Portfolio vs benchmark, both rebased to 100 at the start of the selected window.
 * Pointer or arrow keys move the crosshair; two native range inputs choose the window.
 */
export function PerformanceChart({
  series,
  portfolioName,
  benchmarkTicker,
  benchmarkName,
}: {
  series: SeriesPoint[];
  portfolioName: string;
  benchmarkTicker: string;
  benchmarkName: string;
}) {
  const count = series.length;
  const last = Math.max(0, count - 1);
  const [windowRange, setWindowRange] = useState<[number, number]>([0, last]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [spoken, setSpoken] = useState('');
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const id = safeId(useId());
  const lo = Math.min(windowRange[0], last);
  const hi = Math.min(Math.max(windowRange[1], lo), last);
  const minGap = Math.min(4, last);

  const width = size.width;
  const compact = width > 0 && width < 560;
  const height = compact ? 220 : 300;
  const margin = { top: 12, right: compact ? 40 : 52, bottom: 26, left: 2 };
  const plotRight = Math.max(margin.left + 10, width - margin.right);
  const plotBottom = height - margin.bottom;

  const t = useMemo(() => times(series.map(point => point.date)), [series]);

  const model = useMemo(() => {
    if (count < 2 || width <= 0) return null;
    const baseP = series[lo].portfolio;
    const baseB = series[lo].benchmark;
    const portfolio = series.map(point => (baseP > 0 ? (point.portfolio / baseP) * 100 : Number.NaN));
    const benchmark = series.map(point => (baseB > 0 ? (point.benchmark / baseB) * 100 : Number.NaN));
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let index = lo; index <= hi; index += 1) {
      for (const value of [portfolio[index], benchmark[index]]) {
        if (Number.isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }
    const axis = niceAxis(min, max, compact ? 3 : 5);
    const x = linear([t[lo], t[hi]], [margin.left, plotRight]);
    const y = linear(axis.domain, [plotBottom, margin.top]);
    const xs = t.map(x);
    const sliceX = xs.slice(lo, hi + 1);
    const pY = portfolio.slice(lo, hi + 1).map(y);
    const bY = benchmark.slice(lo, hi + 1).map(y);
    return {
      portfolio,
      benchmark,
      axis,
      y,
      xs,
      portfolioPath: linePath(sliceX, pY),
      benchmarkPath: linePath(sliceX, bY),
      portfolioArea: areaPath(sliceX, pY, plotBottom),
      ticks: timeTicks(t[lo], t[hi], plotRight - margin.left).map(tick => ({ ...tick, x: x(tick.time) })),
      digits: digitsFor(axis.ticks),
    };
  }, [series, count, width, lo, hi, t, compact, margin.left, plotRight, plotBottom, margin.top]);

  if (count < 2) {
    return <p className="faint">Not enough observations to draw the performance chart.</p>;
  }

  const active = cursor !== null && cursor >= lo && cursor <= hi ? cursor : hi;
  const readP = model?.portfolio[active];
  const readB = model?.benchmark[active];
  const windowP = series[hi].portfolio / series[lo].portfolio - 1;
  const windowB = series[hi].benchmark / series[lo].benchmark - 1;
  const fullWindow = lo === 0 && hi === last;

  const onPointer = (event: PointerEvent<SVGRectElement>) => {
    if (!model) return;
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!bounds) return;
    setCursor(nearestIndex(model.xs, event.clientX - bounds.left, lo, hi));
  };

  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const current = cursor ?? hi;
    const step = event.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = Math.max(lo, current - step);
    else if (event.key === 'ArrowRight') next = Math.min(hi, current + step);
    else if (event.key === 'Home') next = lo;
    else if (event.key === 'End') next = hi;
    else if (event.key === 'Escape') {
      setCursor(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setCursor(next);
    if (model) setSpoken(`${fmtDate(series[next].date)}: portfolio ${num(model.portfolio[next], 1)}, ${benchmarkTicker} ${num(model.benchmark[next], 1)}.`);
  };

  const describe = `From ${fmtDate(series[lo].date)} to ${fmtDate(series[hi].date)}, ${portfolioName} moved from 100 to ${num(
    model?.portfolio[hi],
    1,
  )} and ${benchmarkTicker} moved from 100 to ${num(model?.benchmark[hi], 1)}.`;

  return (
    <div className="perf">
      <div className="chart-readout">
        <span className="chart-readout__date">{fmtDate(series[active].date)}</span>
        <span className="chart-readout__item">
          <span className="legend-swatch legend-swatch--portfolio" aria-hidden="true" />
          <span className="chart-readout__name">Portfolio</span>
          <span className="chart-readout__value">{num(readP, 1)}</span>
          <Delta value={readP !== undefined ? readP / 100 - 1 : null} />
        </span>
        <span className="chart-readout__item">
          <span className="legend-swatch legend-swatch--benchmark" aria-hidden="true" />
          <span className="chart-readout__name" title={benchmarkName}>
            {benchmarkTicker}
          </span>
          <span className="chart-readout__value">{num(readB, 1)}</span>
          <Delta value={readB !== undefined ? readB / 100 - 1 : null} />
        </span>
      </div>
      <span className="sr-only" aria-live="polite">{spoken}</span>
      <div className="chart-frame" ref={wrapRef} style={{ height }}>
        {model && (
          <svg
            className="chart"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            tabIndex={0}
            role="img"
            aria-labelledby={`${id}-t ${id}-d`}
            onKeyDown={onKey}
            onBlur={() => setCursor(null)}
          >
            <title id={`${id}-t`}>Performance indexed to 100: portfolio versus {benchmarkTicker}. Use the left and right arrow keys to read values.</title>
            <desc id={`${id}-d`}>{describe}</desc>
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" className="chart__fill-stop chart__fill-stop--top" />
                <stop offset="100%" className="chart__fill-stop chart__fill-stop--bottom" />
              </linearGradient>
            </defs>
            <g className="chart__grid">
              {model.axis.ticks.map(tick => (
                <line key={tick} x1={margin.left} x2={plotRight} y1={Math.round(model.y(tick)) + 0.5} y2={Math.round(model.y(tick)) + 0.5} className={tick === 100 ? 'is-base' : undefined} />
              ))}
            </g>
            <g className="chart__axis" fontSize={AXIS_FONT}>
              {model.axis.ticks.map(tick => (
                <text key={tick} x={width - 2} y={model.y(tick) + 4} textAnchor="end">
                  {num(tick, model.digits)}
                </text>
              ))}
              {model.ticks.map(tick => (
                <text key={tick.time} x={tick.x} y={height - 8} textAnchor="middle">
                  {tick.label}
                </text>
              ))}
            </g>
            <g className="chart__ticks">
              {model.ticks.map(tick => (
                <line key={tick.time} x1={Math.round(tick.x) + 0.5} x2={Math.round(tick.x) + 0.5} y1={plotBottom} y2={plotBottom + 4} />
              ))}
            </g>
            <path d={model.portfolioArea} fill={`url(#${id}-fill)`} />
            <path d={model.benchmarkPath} className="chart__line chart__line--benchmark" />
            <path d={model.portfolioPath} className="chart__line chart__line--portfolio" />
            {cursor !== null && cursor >= lo && cursor <= hi && (
              <g className="chart__cursor">
                <line x1={model.xs[cursor]} x2={model.xs[cursor]} y1={margin.top} y2={plotBottom} />
                {Number.isFinite(model.benchmark[cursor]) && <circle cx={model.xs[cursor]} cy={model.y(model.benchmark[cursor])} r={3} className="chart__dot chart__dot--benchmark" />}
                {Number.isFinite(model.portfolio[cursor]) && <circle cx={model.xs[cursor]} cy={model.y(model.portfolio[cursor])} r={3.5} className="chart__dot chart__dot--portfolio" />}
              </g>
            )}
            <rect
              x={margin.left}
              y={margin.top}
              width={Math.max(0, plotRight - margin.left)}
              height={Math.max(0, plotBottom - margin.top)}
              className="chart__hit"
              onPointerMove={onPointer}
              onPointerDown={onPointer}
              onPointerLeave={() => setCursor(null)}
            />
          </svg>
        )}
      </div>
      {count > 6 && (
        <div className="window">
          <div className="window-slider">
            <div className="window-slider__track" aria-hidden="true">
              <div className="window-slider__fill" style={{ left: `${(lo / last) * 100}%`, right: `${100 - (hi / last) * 100}%` }} />
            </div>
            <input
              type="range"
              className="window-slider__input"
              min={0}
              max={last}
              step={1}
              value={lo}
              aria-label="Window start"
              aria-valuetext={fmtDate(series[lo].date)}
              onChange={event => {
                setCursor(null);
                setWindowRange([Math.min(Number(event.target.value), hi - minGap), hi]);
              }}
            />
            <input
              type="range"
              className="window-slider__input"
              min={0}
              max={last}
              step={1}
              value={hi}
              aria-label="Window end"
              aria-valuetext={fmtDate(series[hi].date)}
              onChange={event => {
                setCursor(null);
                setWindowRange([lo, Math.max(Number(event.target.value), lo + minGap)]);
              }}
            />
          </div>
          <div className="window__summary">
            <span>
              {fmtDate(series[lo].date)} – {fmtDate(series[hi].date)}
            </span>
            <span>
              Portfolio <Delta value={windowP} />
            </span>
            <span>
              <span className="mono">{benchmarkTicker}</span> <Delta value={windowB} />
            </span>
            <span className="faint">Difference {pp(windowP - windowB)}</span>
            {!fullWindow && (
              <button
                type="button"
                className="button button--quiet button--small"
                onClick={() => {
                  setCursor(null);
                  setWindowRange([0, last]);
                }}
              >
                <RotateCcw size={13} aria-hidden="true" />
                Full range
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
