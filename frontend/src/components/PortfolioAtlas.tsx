import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronDown, Crosshair, MoveUpRight } from 'lucide-react';
import type { Analysis, ValuedHolding } from '../types';
import { date, money, number, percent, timestamp } from '../format';

export interface AllocationItem {
  ticker: string;
  weight: number;
}

export interface AllocationRect extends AllocationItem {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WeightedItem extends AllocationItem {
  scaledWeight: number;
}

/**
 * Balanced binary treemap, split along each region's longer side.
 * Geometry is unguttered and proportional to normalized weights; invalid input
 * rejects the entire layout rather than silently excluding a position.
 */
export function layoutAllocation(items: AllocationItem[], width = 100, height = 100): AllocationRect[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
    !items.length || items.some(item => !item.ticker || !Number.isFinite(item.weight) || item.weight <= 0) ||
    new Set(items.map(item => item.ticker)).size !== items.length) return [];

  const largest = Math.max(...items.map(item => item.weight));
  const sorted: WeightedItem[] = items.map(item => ({
    ...item,
    scaledWeight: Math.max(Number.MIN_VALUE, item.weight / largest),
  })).sort((a, b) => b.weight - a.weight || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  const rects: AllocationRect[] = [];
  const sum = (group: WeightedItem[]) => group.reduce((total, item) => total + item.scaledWeight, 0);

  function divide(group: WeightedItem[], x: number, y: number, w: number, h: number) {
    if (group.length === 1) {
      const { ticker, weight } = group[0];
      rects.push({ ticker, weight, x, y, width: w, height: h });
      return;
    }
    const total = sum(group);
    let split = 1;
    let cumulative = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < group.length; index += 1) {
      cumulative += group[index - 1].scaledWeight;
      const nextDistance = Math.abs(total / 2 - cumulative);
      if (nextDistance < distance) { distance = nextDistance; split = index; }
    }
    const left = group.slice(0, split);
    const right = group.slice(split);
    const firstFraction = sum(left) / total;
    const secondFraction = sum(right) / total;
    // Calculate both spans directly: subtracting a nearly full span would erase tiny holdings.
    if (w >= h) {
      divide(left, x, y, w * firstFraction, h);
      divide(right, x + w * firstFraction, y, w * secondFraction, h);
    } else {
      divide(left, x, y, w, h * firstFraction);
      divide(right, x, y + h * firstFraction, w, h * secondFraction);
    }
  }
  divide(sorted, 0, 0, width, height);
  return rects;
}

function allocationPercent(weight: number) {
  return weight > 0 && weight < .0001 ? '<0.01%' : percent(weight, weight < .01 ? 2 : 1);
}

function quantity(shares: number) {
  return shares > 0 && shares < .00000001 ? shares.toExponential(4) : number(shares, 8);
}

function sector(holding: ValuedHolding) {
  return holding.instrument === 'ETF' ? 'Funds (no look-through)' : holding.sector || 'Unknown sector';
}

function FrameMark({ className = '' }: { className?: string }) {
  return <svg className={`atlas-frame-mark ${className}`} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <circle cx="16" cy="16" r="9" />
    <circle cx="16" cy="16" r="3" />
    <path d="M16 0v9m0 14v9M0 16h9m14 0h9" />
  </svg>;
}

export default function PortfolioAtlas({ analysis, hypothetical, onScenario }: {
  analysis: Analysis;
  hypothetical: boolean;
  onScenario: () => void;
}) {
  const id = useId();
  const patternId = `${id.replaceAll(':', '')}-atlas-grid`;
  const mapElement = useRef<HTMLDivElement>(null);
  const [mapSize, setMapSize] = useState({ width: 900, height: 280 });
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const ordered = useMemo(() => [...analysis.holdings].sort((a, b) =>
    b.weight - a.weight || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0)), [analysis.holdings]);
  const selected = ordered.find(holding => holding.ticker === selectedTicker) ?? ordered[0] ?? null;
  const selectedIndex = selected ? ordered.findIndex(holding => holding.ticker === selected.ticker) : -1;
  const weightSum = ordered.reduce((total, holding) => total + holding.weight, 0);
  const validAllocation = ordered.length > 0 && ordered.length <= 20 &&
    ordered.every(holding => !!holding.ticker && Number.isFinite(holding.weight) && holding.weight > 0) &&
    new Set(ordered.map(holding => holding.ticker)).size === ordered.length &&
    Math.abs(weightSum - 1) < .000001;
  const layout = useMemo(() => validAllocation ? layoutAllocation(ordered, mapSize.width, mapSize.height) : [],
    [ordered, mapSize, validAllocation]);
  const valueAvailable = Number.isFinite(analysis.total_value) && analysis.total_value >= 0;
  const value = valueAvailable ? money(analysis.total_value, analysis.portfolio.base_currency, 2) : '';
  const baseCurrency = analysis.portfolio.base_currency;

  useEffect(() => {
    const element = mapElement.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width > 0 && height > 0) setMapSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [validAllocation]);

  return <section className="atlas-shell" aria-labelledby={`${id}-title`}>
    <header className="atlas-heading">
      <div className="atlas-heading-title">
        <FrameMark />
        <div><span className="atlas-eyebrow">Personal portfolio observatory</span><h2 id={`${id}-title`}>Portfolio atlas<span>.</span></h2></div>
      </div>
      <div className="atlas-heading-context">
        <span className={`atlas-status ${hypothetical ? 'atlas-status-sample' : ''}`}>
          <span aria-hidden="true" />{hypothetical ? 'Hypothetical sample allocation' : 'Applied portfolio allocation'}
        </span>
        <span className="atlas-window">{date(analysis.coverage.start_date)} <span aria-hidden="true">—</span> {date(analysis.coverage.end_date)}</span>
        <span className="atlas-observations">{number(analysis.coverage.observations, 0)} aligned daily returns · historical, not live</span>
      </div>
    </header>

    <div className="atlas-workbench">
      <aside className="atlas-overview" aria-label="Applied portfolio valuation">
        <div className="atlas-portfolio-identity"><span className="atlas-eyebrow">The portfolio in view</span><h3>{analysis.portfolio.name}</h3></div>
        <div className="atlas-value-block">
          <span className="atlas-value-label">Current valuation <b>{baseCurrency}</b></span>
          {valueAvailable ? <div className={`atlas-value ${value.length > 11 ? 'atlas-value-long' : ''}`} aria-label={`${value} ${baseCurrency}`}>
            <span aria-hidden="true">{value.slice(0, -3)}</span><span className="atlas-value-decimals" aria-hidden="true">{value.slice(-3)}</span>
          </div> : <p className="atlas-unavailable-value">Value not available</p>}
          <p className="atlas-value-note">Completed daily closes.<br />Not live prices or account profit / loss.</p>
        </div>
        <dl className="atlas-register">
          <div><dt>Holdings</dt><dd>{number(analysis.concentration.positions, 0).padStart(2, '0')}</dd></div>
          <div><dt>Effective positions</dt><dd>{number(analysis.concentration.effective_positions, 1)}</dd></div>
          <div className="atlas-top-three"><dt>Top three weight</dt><dd>{percent(analysis.concentration.top_3_weight)}</dd>
            <span className="atlas-register-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, analysis.concentration.top_3_weight * 100))}%` }} /></span>
          </div>
        </dl>
        <button className="atlas-scenario-button" type="button" onClick={onScenario}><span>Explore allocation changes<small>Open an unsaved what-if study</small></span><ArrowUpRight size={22} /></button>
      </aside>

      <div className="atlas-map-station">
        <div className="atlas-map-heading"><span><i aria-hidden="true" />Allocation field</span><span>Choose a holding to inspect <ArrowDownRight size={13} /></span></div>
        <div className="atlas-map-frame">
          <span className="atlas-corner atlas-corner-tl" aria-hidden="true" /><span className="atlas-corner atlas-corner-tr" aria-hidden="true" />
          <span className="atlas-corner atlas-corner-bl" aria-hidden="true" /><span className="atlas-corner atlas-corner-br" aria-hidden="true" />
          <div className="atlas-map" ref={mapElement} role="group" aria-label="Portfolio allocation map" aria-describedby={`${id}-map-note`}>
            <svg className="atlas-map-grid" width="100%" height="100%" aria-hidden="true">
              <defs><pattern id={patternId} width="24" height="24" patternUnits="userSpaceOnUse"><path d="M0 4V0H4M22 24h2v-2" /></pattern></defs>
              <rect width="100%" height="100%" fill={`url(#${patternId})`} />
            </svg>
            {layout.map((rect, index) => {
              const holding = ordered.find(item => item.ticker === rect.ticker)!;
              const tiny = rect.width < 56 || rect.height < 44;
              const compact = !tiny && (rect.width < 145 || rect.height < 115);
              const generous = rect.width >= 230 && rect.height >= 175;
              const style: CSSProperties = {
                left: `${rect.x / mapSize.width * 100}%`, top: `${rect.y / mapSize.height * 100}%`,
                width: `${rect.width / mapSize.width * 100}%`, height: `${rect.height / mapSize.height * 100}%`,
                padding: `${Math.min(1.5, rect.height * .1)}px ${Math.min(1.5, rect.width * .1)}px`,
              };
              return <button className={`atlas-tile atlas-tone-${index % 6}${selected?.ticker === rect.ticker ? ' atlas-tile-selected' : ''}${tiny ? ' atlas-tile-tiny' : ''}${compact ? ' atlas-tile-compact' : ''}${generous ? ' atlas-tile-generous' : ''}`}
                style={style} type="button" key={rect.ticker}
                aria-label={`Inspect ${rect.ticker}, ${allocationPercent(rect.weight)} of portfolio`}
                aria-pressed={selected?.ticker === rect.ticker} aria-controls={`${id}-inspector`}
                onClick={() => setSelectedTicker(rect.ticker)} onFocus={() => setSelectedTicker(rect.ticker)}>
                <span className="atlas-tile-face">
                  {!tiny && <span className="atlas-tile-content" aria-hidden="true">
                    <span className="atlas-tile-topline"><span>{String(index + 1).padStart(2, '0')}<span className="atlas-tile-type"> / {holding.instrument === 'ETF' ? 'FUND' : 'EQUITY'}</span></span><MoveUpRight /></span>
                    <strong className="atlas-tile-ticker" style={{ fontSize: Math.min(generous ? 54 : compact ? 21 : 36, Math.max(12, (rect.width - (compact ? 16 : 36)) / (rect.ticker.length * .68))) }}>{rect.ticker}</strong>
                    {generous && <span className="atlas-tile-name">{holding.name}</span>}
                    <span className="atlas-tile-bottomline"><span className="atlas-tile-weight">{allocationPercent(rect.weight)}</span>{generous && <span className="atlas-tile-value">{money(holding.market_value, baseCurrency)} <small>{baseCurrency}</small></span>}</span>
                  </span>}
                  {selected?.ticker === rect.ticker && <span className="atlas-tile-reticle" aria-hidden="true"><span /><span /><span /><span /></span>}
                </span>
              </button>;
            })}
            {!validAllocation && <div className="atlas-map-empty" role="status"><Crosshair size={28} /><strong>Allocation map unavailable</strong><p>{ordered.length ? 'The allocation contains missing, duplicate, or invalid weights. No positions have been silently removed or reallocated.' : 'This analysis has no holdings to map.'}</p></div>}
          </div>
        </div>
        <div className="atlas-map-footer">
          <div className="atlas-focus-control"><label htmlFor={`${id}-focus`}><Crosshair size={14} />Focus holding</label>
            <div className="atlas-select-wrap"><select id={`${id}-focus`} value={selected?.ticker ?? ''} disabled={!ordered.length}
              onChange={event => setSelectedTicker(event.target.value)} aria-controls={`${id}-inspector`}>
              {!ordered.length && <option value="">No holdings</option>}
              {ordered.map(holding => <option key={holding.ticker} value={holding.ticker}>{holding.ticker} · {allocationPercent(holding.weight)} · {holding.name}</option>)}
            </select><ChevronDown size={14} aria-hidden="true" /></div>
          </div>
          <span className="atlas-field-count">{String(Math.max(0, selectedIndex + 1)).padStart(2, '0')} <span>/</span> {String(ordered.length).padStart(2, '0')}<small>in focus / total</small></span>
        </div>
        <p id={`${id}-map-note`} className="atlas-map-note">Area represents portfolio allocation. Position and color are visual only — not risk, geography, or correlation. Every holding is available in the selector, including tiny allocations.</p>
      </div>
    </div>

    {selected && <section className="atlas-inspector" id={`${id}-inspector`} aria-label={`Selected holding: ${selected.ticker}`}>
      <div className="atlas-inspector-identity"><div className="atlas-inspector-kicker"><span className="atlas-eyebrow">Under the lens</span><span className="atlas-instrument">{selected.instrument === 'ETF' ? 'ETF' : 'Stock'}</span></div>
        <div className="atlas-selected-ticker"><FrameMark /><h3>{selected.ticker}</h3><span className="atlas-inspector-rank">{String(selectedIndex + 1).padStart(2, '0')}</span></div>
        <p className="atlas-selected-name">{selected.name}</p><p className="atlas-selected-sector">{sector(selected)}</p>
      </div>
      <dl className="atlas-holding-register">
        <div className="atlas-holding-measure atlas-weight-measure"><dt>Current weight</dt><dd>{allocationPercent(selected.weight)}</dd><span>{money(selected.market_value, baseCurrency, 2)} {baseCurrency}</span></div>
        <div className="atlas-holding-measure atlas-shares-measure"><dt>Shares held</dt><dd>{quantity(selected.shares)}</dd><span>{money(selected.price, selected.currency, 2)} {selected.currency} / share</span><small>Close · {date(selected.price_date)}</small></div>
        <div className="atlas-holding-measure"><dt>Annual volatility</dt><dd>{percent(selected.annual_volatility)}</dd><span>Historical variability</span></div>
        <div className="atlas-holding-measure"><dt>Beta</dt><dd className={selected.beta === null ? 'atlas-metric-unavailable' : ''}>{number(selected.beta)}</dd><span>vs {analysis.benchmark.ticker}</span></div>
        <div className="atlas-holding-measure atlas-contribution-measure"><dt>Volatility contribution</dt><dd className={selected.risk_contribution === null ? 'atlas-metric-unavailable' : ''}>{percent(selected.risk_contribution)}</dd><span>{selected.risk_contribution === null ? 'Undefined at near-zero variance' : selected.risk_contribution < 0 ? 'Negative = historical risk offset' : 'Share of portfolio volatility'}</span></div>
      </dl>
      <div className="atlas-sr-only" aria-live="polite" aria-atomic="true">{selected.ticker} selected. {allocationPercent(selected.weight)} allocation, {money(selected.market_value, baseCurrency, 2)} {baseCurrency}.</div>
    </section>}

    <details className="atlas-provenance">
      <summary><span><span className="atlas-source-dot" aria-hidden="true" />Quote & FX provenance{selected && <span className="atlas-source-ticker"> / {selected.ticker}</span>}</span><span className="atlas-source-time">Retrieved {timestamp(analysis.market_fetched_at)}</span><ChevronDown size={14} /></summary>
      <div className="atlas-provenance-content">
        {selected && <dl><div><dt>Completed quote</dt><dd>{money(selected.price, selected.currency, 4)} {selected.currency}<span>{date(selected.price_date)} · {selected.exchange}</span></dd></div>
          <div><dt>Quote → base currency</dt><dd>1 {selected.currency} = {number(selected.fx_rate, 6)} {baseCurrency}<span>FX date · {date(selected.fx_date)}</span></dd></div>
          <div><dt>Converted close</dt><dd>{money(selected.price_base, baseCurrency, 4)} {baseCurrency}<span>Retrieved {timestamp(selected.fetched_at)}</span></dd></div>
          <div><dt>Source</dt><dd>{selected.source}</dd></div>
        </dl>}
        <p>Values use completed daily closes, not executable or real-time prices. Retrieval time is not the quote’s trading date. Historical metrics use {date(analysis.coverage.start_date)} – {date(analysis.coverage.end_date)}. This map changes only the selected view, never the portfolio.</p>
        {selected?.warnings.length ? <ul>{selected.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
      </div>
    </details>
  </section>;
}
