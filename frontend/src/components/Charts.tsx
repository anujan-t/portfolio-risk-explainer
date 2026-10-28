import { useId, useMemo, useState } from 'react';
import type { Analysis } from '../types';
import { date, money, number, percent } from '../format';

export function HistoryChart({ analysis, drawdown = false }: { analysis: Analysis; drawdown?: boolean }) {
  const titleId = useId();
  const gradientId = useId().replaceAll(':', '');
  const [mode, setMode] = useState<'index' | 'money'>('index');
  const [hover, setHover] = useState<number | null>(null);
  const points = analysis.series;
  const data = useMemo(() => {
    const factor = !drawdown && mode === 'money' ? analysis.total_value / 100 : 1;
    const values = points.flatMap(point => drawdown ? [point.drawdown] : [point.portfolio * factor, point.benchmark * factor]);
    let min = Math.min(...values, drawdown ? 0 : Number.POSITIVE_INFINITY);
    let max = Math.max(...values, drawdown ? 0 : Number.NEGATIVE_INFINITY);
    const padding = (max - min) * .12 || (drawdown ? .01 : 1);
    min -= padding;
    max = drawdown ? 0 : max + padding;
    const x = (index: number) => 58 + index / Math.max(points.length - 1, 1) * 750;
    const y = (value: number) => 22 + (max - value) / (max - min) * 210;
    const path = (key: 'portfolio' | 'benchmark' | 'drawdown') => points.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(2)} ${y(point[key] * (drawdown ? 1 : factor)).toFixed(2)}`).join(' ');
    return { factor, min, max, x, y, portfolio: path(drawdown ? 'drawdown' : 'portfolio'), benchmark: path('benchmark') };
  }, [points, mode, drawdown, analysis.total_value]);
  if (!points.length) return <div className="chart-unavailable">No aligned price history is available.</div>;
  const activeIndex = hover === null ? null : Math.min(hover, points.length - 1);
  const highlighted = points[activeIndex ?? points.length - 1];
  const display = (value: number) => drawdown ? percent(value) : mode === 'money' ? money(value, analysis.portfolio.base_currency) : number(value, 1);
  return <div className="history-chart">
    <div className="chart-toolbar">
      <div className="chart-legend"><span><i className="legend-dot accent" />Portfolio</span>{!drawdown && <span><i className="legend-dot muted" />{analysis.benchmark.ticker}</span>}</div>
      {!drawdown && <div className="segmented" aria-label="Chart display">
        <button aria-pressed={mode === 'index'} className={mode === 'index' ? 'selected' : ''} onClick={() => setMode('index')}>Index 100</button>
        <button aria-pressed={mode === 'money'} className={mode === 'money' ? 'selected' : ''} onClick={() => setMode('money')}>Hypothetical {analysis.portfolio.base_currency}</button>
      </div>}
    </div>
    <div className="chart-readout" aria-live="off"><span>{date(highlighted.date)}</span><strong>{display((drawdown ? highlighted.drawdown : highlighted.portfolio) * data.factor)}</strong>{!drawdown && <span>{analysis.benchmark.ticker} <b>{display(highlighted.benchmark * data.factor)}</b></span>}</div>
    <svg className="line-chart" viewBox="0 0 840 270" role="img" aria-labelledby={titleId} onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width * 840;
      setHover(Math.min(points.length - 1, Math.max(0, Math.round((x - 58) / 750 * (points.length - 1)))));
    }} onPointerLeave={() => setHover(null)}>
      <title id={titleId}>{drawdown ? 'Historical hypothetical drawdown' : 'Historical constant-current-weight performance compared with benchmark'}. {date(analysis.coverage.start_date)} to {date(analysis.coverage.end_date)}. {drawdown ? `Maximum drawdown ${percent(analysis.risk.max_drawdown)}` : 'Both series start at 100. This is not actual account performance.'}</title>
      <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--cp-accent)" stopOpacity=".14" /><stop offset="100%" stopColor="var(--cp-accent)" stopOpacity=".01" /></linearGradient></defs>
      {[0, 1, 2, 3, 4].map(index => {
        const value = data.max - (data.max - data.min) * index / 4;
        return <g key={index}><line x1="58" x2="808" y1={data.y(value)} y2={data.y(value)} className="chart-grid" /><text x="46" y={data.y(value) + 4} textAnchor="end" className="axis-label">{drawdown ? percent(value, 0) : mode === 'money' ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : number(value, 0)}</text></g>;
      })}
      <path d={`${data.portfolio} L 808 ${drawdown ? data.y(0) : 232} L 58 ${drawdown ? data.y(0) : 232} Z`} fill={`url(#${gradientId})`} />
      {!drawdown && <path d={data.benchmark} className="benchmark-line" />}
      <path d={data.portfolio} className="portfolio-line" />
      {[0, .25, .5, .75, 1].map((ratio, index) => {
        const point = points[Math.round((points.length - 1) * ratio)];
        return <text key={index} x={58 + ratio * 750} y="258" textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'} className="axis-label">{new Date(`${point.date.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</text>;
      })}
      {activeIndex !== null && <g><line x1={data.x(activeIndex)} x2={data.x(activeIndex)} y1="22" y2="232" className="hover-line" /><circle cx={data.x(activeIndex)} cy={data.y((drawdown ? points[activeIndex].drawdown : points[activeIndex].portfolio) * data.factor)} r="4" className="chart-point" /></g>}
    </svg>
    <label className="sr-only" htmlFor={`${titleId}-range`}>Explore historical chart dates</label>
    <input className="chart-date-range" id={`${titleId}-range`} type="range" min="0" max={points.length - 1} value={activeIndex ?? points.length - 1} onChange={event => setHover(Number(event.target.value))} aria-valuetext={`${date(highlighted.date)}: Portfolio ${display((drawdown ? highlighted.drawdown : highlighted.portfolio) * data.factor)}${drawdown ? '' : `, benchmark ${display(highlighted.benchmark * data.factor)}`}`} />
    <p className="chart-caption">{drawdown ? 'Decline from the previous hypothetical peak. A new peak resets drawdown to zero.' : mode === 'money' ? `Both paths start with today’s ${money(analysis.total_value, analysis.portfolio.base_currency)} valuation. Hypothetical only — not your profit or loss.` : 'Growth of a hypothetical 100. Current weights held constant with daily rebalancing; not actual account returns.'}</p>
  </div>;
}

export function AllocationChart({ analysis }: { analysis: Analysis }) {
  const sorted = [...analysis.holdings].sort((a, b) => b.weight - a.weight);
  return <div className="allocation-ledger">
    <div className="allocation-strip" role="img" aria-label={`Portfolio weights: ${sorted.map(h => `${h.ticker} ${percent(h.weight)}`).join(', ')}`}>
      {sorted.map((holding, index) => <span key={holding.ticker} title={`${holding.ticker}: ${percent(holding.weight)}`} style={{ width: `${holding.weight * 100}%`, opacity: Math.max(.25, 1 - index * .1) }} />)}
    </div>
    <ol className="allocation-entries">{sorted.map((holding, index) => <li key={holding.ticker}><span className="allocation-order">{String(index + 1).padStart(2, '0')}</span><span className="allocation-security"><strong>{holding.ticker}</strong><span>{holding.name}</span></span><span className="allocation-amount">{money(holding.market_value, analysis.portfolio.base_currency)}<strong>{percent(holding.weight)}</strong></span></li>)}</ol>
  </div>;
}

export function RiskContributionChart({ analysis }: { analysis: Analysis }) {
  const maximum = Math.max(.01, ...analysis.holdings.map(h => Math.abs(h.risk_contribution ?? 0)));
  const hasNegative = analysis.holdings.some(h => (h.risk_contribution ?? 0) < 0);
  return <div className="risk-bars">
    {[...analysis.holdings].sort((a, b) => (b.risk_contribution ?? -Infinity) - (a.risk_contribution ?? -Infinity)).map(holding => {
      const value = holding.risk_contribution;
      return <div className="risk-bar-row" key={holding.ticker}><strong>{holding.ticker}</strong>
        <div className={`bar-track ${hasNegative ? 'diverging' : ''}`} aria-hidden="true">
          {hasNegative && <i className="bar-zero" />}
          <i className={`bar-fill ${value !== null && value < 0 ? 'negative' : ''}`} style={{ width: `${value === null ? 0 : Math.abs(value) / maximum * (hasNegative ? 50 : 100)}%`, left: hasNegative ? value !== null && value < 0 ? `${50 - Math.abs(value) / maximum * 50}%` : '50%' : '0%' }} />
        </div><span>{percent(value)}</span></div>;
    })}
    <p className="chart-caption">Share of portfolio volatility, not portfolio value. Negative values represent a historical offset to risk. Undefined when variance is effectively zero.</p>
  </div>;
}

export function CorrelationChart({ analysis }: { analysis: Analysis }) {
  const { tickers, matrix } = analysis.correlations;
  return <div className="correlation-wrap">
    <div className="table-scroll" tabIndex={0} aria-label="Scrollable holding correlation table">
      <table className="correlation-table"><caption className="sr-only">Pairwise daily return correlations between holdings, from minus one to one. A dash means not available.</caption>
        <thead><tr><th scope="col"><span className="sr-only">Holding</span></th>{tickers.map(ticker => <th scope="col" key={ticker}>{ticker}</th>)}</tr></thead>
        <tbody>{tickers.map((ticker, row) => <tr key={ticker}><th scope="row">{ticker}</th>{tickers.map((other, col) => {
          const value = matrix[row]?.[col] ?? null;
          return <td key={other} title={`${ticker} / ${other}: ${number(value)}`}><span className={`correlation-cell ${value === null ? 'unavailable' : value < 0 ? 'negative-correlation' : ''}`} style={{ background: value === null ? 'var(--cp-surface-soft)' : `color-mix(in srgb, var(${value < 0 ? '--cp-text-muted' : '--cp-accent'}) ${Math.round(Math.abs(value) * 24 + 3)}%, var(--cp-surface))` }}>{value === null ? '—' : value.toFixed(2)}</span></td>;
        })}</tr>)}</tbody>
      </table>
    </div>
    <div className="correlation-key"><span>−1 · Opposite movement</span><span>0 · Little linear relationship</span><span>+1 · Move together</span></div>
    <p className="chart-caption">Historical daily returns in {analysis.portfolio.base_currency}. Correlation is not a promise of future diversification. — means undefined, not zero.</p>
  </div>;
}
