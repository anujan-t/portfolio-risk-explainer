import { useId, useMemo } from 'react';
import { useElementSize } from '../../lib/hooks';
import { linePath, linear } from './scale';

export function safeId(raw: string) {
  return `lx${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** Small inline trend line: 1.5px accent, no fill, with an end marker. */
export function Sparkline({ values, title, description, height = 36 }: { values: number[]; title: string; description: string; height?: number }) {
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
    return { line: linePath(xs, ys), endX: xs[last], endY: ys[last] };
  }, [values, width, height]);

  return (
    <div className="spark" ref={ref} style={{ height }}>
      {shape && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>{description}</desc>
          <path d={shape.line} className="chart__line chart__line--portfolio" />
          <circle cx={shape.endX} cy={shape.endY} r={2} className="chart__end" />
        </svg>
      )}
    </div>
  );
}
