import { useId, useMemo } from 'react';
import { useElementSize } from '../../lib/hooks';
import { areaPath, linePath, linear } from './scale';

export function safeId(raw: string) {
  return `lx${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** Minimal portfolio trend line: brass 1.5px, faint fill, end marker. */
export function Sparkline({ values, title, description, height = 56 }: { values: number[]; title: string; description: string; height?: number }) {
  const [ref, size] = useElementSize<HTMLDivElement>();
  const id = safeId(useId());
  const width = size.width;
  const shape = useMemo(() => {
    const finite = values.filter(Number.isFinite);
    if (width <= 0 || finite.length < 2) return null;
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const pad = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
    const x = linear([0, values.length - 1], [1, width - 4]);
    const y = linear([min - pad, max + pad], [height - 2, 2]);
    const xs = values.map((_, index) => x(index));
    const ys = values.map(value => y(value));
    const last = values.length - 1;
    return { line: linePath(xs, ys), area: areaPath(xs, ys, height), endX: xs[last], endY: ys[last] };
  }, [values, width, height]);

  return (
    <div className="spark" ref={ref} style={{ height }}>
      {shape && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{description}</desc>
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" className="chart__fill-stop chart__fill-stop--top" />
              <stop offset="100%" className="chart__fill-stop chart__fill-stop--bottom" />
            </linearGradient>
          </defs>
          <path d={shape.area} fill={`url(#${id}-fill)`} />
          <path d={shape.line} className="chart__line chart__line--portfolio" />
          <circle cx={shape.endX} cy={shape.endY} r={2.5} className="chart__end" />
        </svg>
      )}
    </div>
  );
}
