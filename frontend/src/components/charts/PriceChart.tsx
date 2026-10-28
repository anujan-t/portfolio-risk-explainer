import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { AssetHistory } from '../../types';
import { useElementSize } from '../../lib/hooks';
import { dateValue, fmtDate, num, quotePrice } from '../../lib/format';
import { AXIS_FONT, linePath, linear, nearestIndex, niceAxis, timeTicks, times } from './scale';
import { safeId } from './Sparkline';

function stepDigits(ticks: number[]): number {
  const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  return 4;
}

/** Close price history with dividend ticks and labelled split markers. */
export function PriceChart({ history }: { history: AssetHistory }) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const [cursor, setCursor] = useState<number | null>(null);
  const [spoken, setSpoken] = useState('');
  const id = safeId(useId());
  const width = size.width;
  const height = 240;
  const margin = { top: 22, right: 58, bottom: 34, left: 2 };
  const plotRight = Math.max(margin.left + 10, width - margin.right);
  const plotBottom = height - margin.bottom;
  const points = history.points;
  const unit = history.currency;
  const scale = history.currency_scale;

  const model = useMemo(() => {
    if (points.length < 2 || width <= 0) return null;
    const t = times(points.map(point => point.date));
    const closes = points.map(point => point.close);
    const finite = closes.filter(Number.isFinite);
    const axis = niceAxis(Math.min(...finite), Math.max(...finite), 4);
    const start = t[0];
    const end = t[t.length - 1];
    const x = linear([start, end], [margin.left, plotRight]);
    const y = linear(axis.domain, [plotBottom, margin.top]);
    const xs = t.map(x);
    const inRange = (time: number) => Number.isFinite(time) && time >= start && time <= end;
    return {
      xs,
      y,
      axis,
      closes,
      line: linePath(xs, closes.map(y)),
      ticks: timeTicks(start, end, plotRight - margin.left).map(tick => ({ ...tick, x: x(tick.time) })),
      dividends: history.dividends.map(item => ({ ...item, time: dateValue(item.date) })).filter(item => inRange(item.time)).map(item => ({ ...item, x: x(item.time) })),
      splits: history.splits.map(item => ({ ...item, time: dateValue(item.date) })).filter(item => inRange(item.time)).map(item => ({ ...item, x: x(item.time) })),
      digits: stepDigits(axis.ticks),
    };
  }, [points, width, history.dividends, history.splits, margin.left, plotRight, plotBottom, margin.top]);

  if (points.length < 2) return <p className="faint">Not enough price history to draw a chart for this range.</p>;

  const lastIndex = points.length - 1;
  const active = cursor ?? lastIndex;
  const onPointer = (event: PointerEvent<SVGRectElement>) => {
    if (!model) return;
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (bounds) setCursor(nearestIndex(model.xs, event.clientX - bounds.left));
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const current = cursor ?? lastIndex;
    const step = event.shiftKey ? 20 : 1;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = Math.max(0, current - step);
    else if (event.key === 'ArrowRight') next = Math.min(lastIndex, current + step);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = lastIndex;
    else if (event.key === 'Escape') {
      setCursor(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setCursor(next);
    setSpoken(`${fmtDate(points[next].date)}: close ${quotePrice(points[next].close, unit, scale)}.`);
  };

  const first = points[0];
  const latest = points[lastIndex];

  return (
    <div className="price-chart">
      <div className="chart-readout">
        <span className="chart-readout__date">{fmtDate(points[active].date)}</span>
        <span className="chart-readout__item">
          <span className="legend-swatch legend-swatch--asset" aria-hidden="true" />
          <span className="chart-readout__name">Close</span>
          <span className="chart-readout__value">{quotePrice(points[active].close, unit, scale)}</span>
        </span>
      </div>
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
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
            <title id={`${id}-t`}>Close prices for {history.ticker} in {unit}. Use the left and right arrow keys to read values.</title>
            <desc id={`${id}-d`}>
              From {quotePrice(first.close, unit, scale)} on {fmtDate(first.date)} to {quotePrice(latest.close, unit, scale)} on {fmtDate(latest.date)}.{' '}
              {model.dividends.length} dividends and {model.splits.length} splits in this range.
            </desc>
            <g className="chart__grid">
              {model.axis.ticks.map(tick => (
                <line key={tick} x1={margin.left} x2={plotRight} y1={Math.round(model.y(tick)) + 0.5} y2={Math.round(model.y(tick)) + 0.5} />
              ))}
            </g>
            <g className="chart__axis" fontSize={AXIS_FONT}>
              {model.axis.ticks.map(tick => (
                <text key={tick} x={width - 2} y={model.y(tick) + 4} textAnchor="end">
                  {num(tick, model.digits)}
                </text>
              ))}
              {model.ticks.map(tick => (
                <text key={tick.time} x={tick.x} y={height - 6} textAnchor="middle">
                  {tick.label}
                </text>
              ))}
            </g>
            {model.splits.map(split => (
              <g key={`split-${split.date}`} className="chart__split">
                <title>
                  Split {split.numerator}:{split.denominator} on {fmtDate(split.date)}
                </title>
                <line x1={split.x} x2={split.x} y1={margin.top - 4} y2={plotBottom} />
                <text x={split.x + 4} y={margin.top - 8} fontSize={AXIS_FONT}>
                  {split.numerator}:{split.denominator} split
                </text>
              </g>
            ))}
            <path d={model.line} className="chart__line chart__line--asset" />
            <g className="chart__dividends">
              {model.dividends.map(dividend => (
                <g key={`div-${dividend.date}`}>
                  <title>
                    Dividend {quotePrice(dividend.amount, unit, scale)} on {fmtDate(dividend.date)}
                  </title>
                  <line x1={dividend.x} x2={dividend.x} y1={plotBottom + 3} y2={plotBottom + 11} />
                  <rect x={dividend.x - 4} y={plotBottom + 1} width={8} height={12} className="chart__hit-mark" />
                </g>
              ))}
            </g>
            {cursor !== null && (
              <g className="chart__cursor">
                <line x1={model.xs[cursor]} x2={model.xs[cursor]} y1={margin.top} y2={plotBottom} />
                <circle cx={model.xs[cursor]} cy={model.y(model.closes[cursor])} r={3.5} className="chart__dot chart__dot--asset" />
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
    </div>
  );
}
