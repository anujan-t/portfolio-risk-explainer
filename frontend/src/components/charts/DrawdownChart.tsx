import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Analysis } from '../../types';
import { useElementSize } from '../../lib/hooks';
import { fmtDate, percent } from '../../lib/format';
import { AXIS_FONT, areaPath, linePath, linear, nearestIndex, niceAxis, timeTicks, times } from './scale';
import { safeId } from './Sparkline';

type SeriesPoint = Analysis['series'][number];

/**
 * Portfolio drawdown from its running peak (always ≤ 0), with the trough marked.
 * With `fill`, the plot grows to the height its panel offers (between 160/190 and 440 px).
 */
export function DrawdownChart({ series, height: fixedHeight, fill = false }: { series: SeriesPoint[]; height?: number; fill?: boolean }) {
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const [cursor, setCursor] = useState<number | null>(null);
  const [spoken, setSpoken] = useState('');
  const id = safeId(useId());
  const width = size.width;
  const minHeight = width > 0 && width < 560 ? 160 : 190;
  const height = fixedHeight ?? (fill ? Math.min(440, Math.max(minHeight, size.height)) : minHeight);
  const margin = { top: 10, right: width < 560 ? 40 : 52, bottom: 24, left: 2 };
  const plotRight = Math.max(margin.left + 10, width - margin.right);
  const plotBottom = height - margin.bottom;

  const model = useMemo(() => {
    if (series.length < 2 || width <= 0) return null;
    const t = times(series.map(point => point.date));
    const values = series.map(point => Math.min(0, point.drawdown));
    let troughIndex = 0;
    values.forEach((value, index) => {
      if (value < values[troughIndex]) troughIndex = index;
    });
    const axis = niceAxis(Math.min(values[troughIndex], -0.01), 0, 3);
    const x = linear([t[0], t[t.length - 1]], [margin.left, plotRight]);
    const y = linear([axis.domain[0], 0], [plotBottom, margin.top]);
    const xs = t.map(x);
    const ys = values.map(y);
    return {
      values,
      xs,
      y,
      axis,
      troughIndex,
      line: linePath(xs, ys),
      area: areaPath(xs, ys, y(0)),
      ticks: timeTicks(t[0], t[t.length - 1], plotRight - margin.left).map(tick => ({ ...tick, x: x(tick.time) })),
    };
  }, [series, width, margin.left, plotRight, plotBottom, margin.top]);

  if (series.length < 2) return <p className="faint">Not enough observations to draw drawdowns.</p>;

  const trough = model ? series[model.troughIndex] : null;
  const onPointer = (event: PointerEvent<SVGRectElement>) => {
    if (!model) return;
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (bounds) setCursor(nearestIndex(model.xs, event.clientX - bounds.left));
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!model) return;
    const lastIndex = series.length - 1;
    const current = cursor ?? lastIndex;
    const step = event.shiftKey ? 10 : 1;
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
    setSpoken(`${fmtDate(series[next].date)}: ${percent(model.values[next], 1)} from the previous peak.`);
  };

  const active = cursor ?? series.length - 1;
  const troughX = model && trough ? model.xs[model.troughIndex] : 0;
  const labelLeft = troughX > (plotRight - margin.left) * 0.6;

  return (
    <div className={fill ? 'drawdown drawdown--fill' : 'drawdown'}>
      <div className="chart-readout">
        <span className="chart-readout__date">{fmtDate(series[active].date)}</span>
        <span className="chart-readout__item">
          <span className="legend-swatch legend-swatch--portfolio" aria-hidden="true" />
          <span className="chart-readout__name">From peak</span>
          <span className="chart-readout__value">{percent(model?.values[active] ?? series[active].drawdown, 1)}</span>
        </span>
      </div>
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
      <div className={fill ? 'chart-frame chart-frame--fill' : 'chart-frame'} ref={wrapRef} style={fill ? { minHeight } : { height }}>
        {model && trough && (
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
            <title id={`${id}-t`}>Drawdown from the running peak. Use the left and right arrow keys to read values.</title>
            <desc id={`${id}-d`}>
              The deepest drawdown was {percent(model.values[model.troughIndex], 1)} on {fmtDate(trough.date)}. The latest value is{' '}
              {percent(model.values[series.length - 1], 1)}.
            </desc>
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="1" y2="0">
                <stop offset="0%" className="chart__fill-stop chart__fill-stop--top" />
                <stop offset="100%" className="chart__fill-stop chart__fill-stop--bottom" />
              </linearGradient>
            </defs>
            <g className="chart__grid">
              {model.axis.ticks.map(tick => (
                <line key={tick} x1={margin.left} x2={plotRight} y1={Math.round(model.y(tick)) + 0.5} y2={Math.round(model.y(tick)) + 0.5} className={tick === 0 ? 'is-base' : undefined} />
              ))}
            </g>
            <g className="chart__axis" fontSize={AXIS_FONT}>
              {model.axis.ticks.map(tick => (
                <text key={tick} x={width - 2} y={model.y(tick) + 4} textAnchor="end">
                  {percent(tick, 0)}
                </text>
              ))}
              {model.ticks.map(tick => (
                <text key={tick.time} x={tick.x} y={height - 7} textAnchor="middle">
                  {tick.label}
                </text>
              ))}
            </g>
            <path d={model.area} fill={`url(#${id}-fill)`} />
            <path d={model.line} className="chart__line chart__line--portfolio" />
            <g className="chart__marker">
              <line x1={troughX} x2={troughX} y1={model.y(0)} y2={model.y(model.values[model.troughIndex])} />
              <circle cx={troughX} cy={model.y(model.values[model.troughIndex])} r={3} />
              <text
                x={labelLeft ? troughX - 8 : troughX + 8}
                y={Math.min(plotBottom - 4, model.y(model.values[model.troughIndex]) + 4)}
                textAnchor={labelLeft ? 'end' : 'start'}
                fontSize={AXIS_FONT}
              >
                {percent(model.values[model.troughIndex], 1)} · {fmtDate(trough.date, 'medium')}
              </text>
            </g>
            {cursor !== null && (
              <g className="chart__cursor">
                <line x1={model.xs[cursor]} x2={model.xs[cursor]} y1={margin.top} y2={plotBottom} />
                <circle cx={model.xs[cursor]} cy={model.y(model.values[cursor])} r={3.5} className="chart__dot chart__dot--portfolio" />
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
