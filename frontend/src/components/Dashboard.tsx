import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowRight, ArrowUpRight, ChevronDown, Clock3, Compass, GitCompareArrows, Layers, NotebookPen } from 'lucide-react';
import type { Analysis } from '../types';
import { date, metricLabel, money, number, percent, timestamp } from '../format';
import { AllocationChart, CorrelationChart, HistoryChart, RiskContributionChart } from './Charts';
import { Notice, PanelHeading } from './Shared';
import PortfolioAtlas from './PortfolioAtlas';

const lenses = [
  { id: 'path', label: 'Performance', description: 'Follow the historical path', icon: Compass },
  { id: 'risk', label: 'Risk & relationships', description: 'Look beyond the weights', icon: GitCompareArrows },
  { id: 'holdings', label: 'Holdings', description: 'Account for every position', icon: Layers },
  { id: 'notes', label: 'Field notes', description: 'Read the evidence', icon: NotebookPen },
] as const;
type Lens = typeof lenses[number]['id'];

export default function Dashboard({ analysis, hypothetical, onScenario, onMethodology }: {
  analysis: Analysis; hypothetical: boolean; onScenario: () => void; onMethodology: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>('path');
  const [pathMode, setPathMode] = useState<'growth' | 'drawdown'>('growth');
  const id = useId();
  const { risk, concentration, coverage, portfolio } = analysis;
  const warnings = [...new Set([...analysis.warnings, ...analysis.holdings.flatMap(h => h.warnings.map(warning => `${h.ticker}: ${warning}`))])];

  function navigateLens(event: KeyboardEvent<HTMLButtonElement>, current: Lens) {
    const index = lenses.findIndex(item => item.id === current);
    let next: Lens;
    if (event.key === 'ArrowRight') next = lenses[(index + 1) % lenses.length].id;
    else if (event.key === 'ArrowLeft') next = lenses[(index - 1 + lenses.length) % lenses.length].id;
    else if (event.key === 'Home') next = lenses[0].id;
    else if (event.key === 'End') next = lenses[lenses.length - 1].id;
    else return;
    event.preventDefault();
    setLens(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }

  return <article className="portfolio-observatory" aria-label="Applied portfolio observatory">
    <PortfolioAtlas analysis={analysis} hypothetical={hypothetical} onScenario={onScenario} />

    <div className="lens-selector" role="tablist" aria-label="Portfolio research views">
      {lenses.map(item => <button id={`${id}-tab-${item.id}`} role="tab" key={item.id} aria-selected={lens === item.id} aria-controls={`${id}-panel-${item.id}`} tabIndex={lens === item.id ? 0 : -1} onClick={() => setLens(item.id)} onKeyDown={event => navigateLens(event, item.id)}>
        <item.icon size={17} strokeWidth={1.5} /><span><strong>{item.label}</strong><small>{item.description}</small></span><span className="lens-tab-mark" aria-hidden="true">↗</span>
      </button>)}
    </div>

    <section id={`${id}-panel-path`} role="tabpanel" aria-labelledby={`${id}-tab-path`} hidden={lens !== 'path'} tabIndex={0} className="observatory-panel">
      <div className="observation-heading"><div><span className="report-label">The historical trace</span><h2>{pathMode === 'growth' ? 'A path, not a prediction.' : 'The space below the peak.'}</h2></div><div className="path-switch" aria-label="Historical chart mode"><button aria-pressed={pathMode === 'growth'} onClick={() => setPathMode('growth')}>Growth</button><button aria-pressed={pathMode === 'drawdown'} onClick={() => setPathMode('drawdown')}>Drawdown</button></div></div>
      <p className="observation-context">{date(coverage.start_date)} — {date(coverage.end_date)} <span>/</span> {coverage.observations} aligned returns <span>/</span> Current weights applied to historical observations, not actual account performance.</p>
      <div className="report-evidence observatory-evidence"><div className="report-trajectory"><HistoryChart analysis={analysis} drawdown={pathMode === 'drawdown'} /></div>
        <aside className="risk-register" aria-label="Historical risk register"><span className="report-label">Three reference points</span>
          <RiskLine label="Annual volatility" value={percent(risk.annual_volatility)} note={`${percent(risk.benchmark_volatility)} for ${analysis.benchmark.ticker}; historical variability, annualized.`} />
          <RiskLine label={`Beta to ${analysis.benchmark.ticker}`} value={number(risk.beta)} note="Historical market sensitivity. Not a guaranteed response." />
          <RiskLine label="Maximum drawdown" value={percent(risk.max_drawdown)} note="Largest decline from a peak in this hypothetical path." />
          <button className="register-link" onClick={onScenario}>Explore another composition <ArrowUpRight size={16} /></button>
        </aside>
      </div>
    </section>

    <section id={`${id}-panel-risk`} role="tabpanel" aria-labelledby={`${id}-tab-risk`} hidden={lens !== 'risk'} tabIndex={0} className="observatory-panel">
      <div className="observation-heading"><div><span className="report-label">The relationships underneath</span><h2>Weight is only part of the picture.</h2></div><span className="observation-stamp">Same dates. Same base currency.</span></div>
      <div className="report-two-column"><section className="report-subsection"><PanelHeading title="Who contributes to the variability?" /><RiskContributionChart analysis={analysis} /></section><section className="report-subsection"><PanelHeading title="Which holdings move together?" /><CorrelationChart analysis={analysis} /></section></div>
      <div className="report-two-column secondary-evidence"><section className="report-subsection"><PanelHeading title="Sector classification" /><div className="exposure-bars">{[...concentration.sector_exposures].sort((a, b) => b.weight - a.weight).map(item => <div className="exposure-row" key={item.sector}><div><span>{item.sector}</span><strong>{percent(item.weight)}</strong></div><div className="exposure-track"><i style={{ width: `${item.weight * 100}%` }} /></div></div>)}</div><div className="sector-notes"><span>Funds, no look-through <strong>{percent(concentration.fund_weight)}</strong></span><span>Unknown classification <strong>{percent(concentration.unknown_sector_weight)}</strong></span></div><p className="chart-caption">Fund constituents and overlaps are not inferred. Unknown security exposures are not redistributed.</p></section>
        <section className="report-subsection"><PanelHeading title="Historical downside estimates" /><div className="observatory-tail"><div><span className="report-label">95% one-day VaR</span><strong>{percent(risk.historical_var_95)}</strong><span>{money(risk.var_amount, portfolio.base_currency)} {portfolio.base_currency}</span></div><div><span className="report-label">95% expected shortfall</span><strong>{percent(risk.historical_es_95)}</strong><span>{money(risk.es_amount, portfolio.base_currency)} {portfolio.base_currency}</span></div></div><p className="chart-caption">Historical loss thresholds at today's entered value. Expected shortfall averages returns at or below the fifth percentile, including ties. Neither number caps future losses.</p></section>
      </div>
    </section>

    <section id={`${id}-panel-holdings`} role="tabpanel" aria-labelledby={`${id}-tab-holdings`} hidden={lens !== 'holdings'} tabIndex={0} className="observatory-panel">
      <div className="observation-heading"><div><span className="report-label">The position ledger</span><h2>Every holding, accounted for.</h2></div><span className="observation-stamp">{portfolio.base_currency} reporting currency</span></div>
      <div className="holdings-table-scroll table-scroll" tabIndex={0} aria-label="Scrollable holdings details table"><table className="holdings-table"><caption className="sr-only">Applied holdings, completed close prices, FX conversion, weights and historical risk</caption><thead><tr><th scope="col">Holding</th><th scope="col">Shares</th><th scope="col">Quote close</th><th scope="col">Value ({portfolio.base_currency})</th><th scope="col">Weight</th><th scope="col">Volatility</th><th scope="col">Details</th></tr></thead><tbody>{analysis.holdings.map(holding => <HoldingRows key={holding.ticker} holding={holding} base={portfolio.base_currency} expanded={expanded === holding.ticker} onToggle={() => setExpanded(expanded === holding.ticker ? null : holding.ticker)} />)}</tbody></table></div>
      <div className="currency-exposure"><span>Quote-currency exposure</span>{concentration.currency_exposures.map(item => <span className="badge" key={item.currency}>{item.currency} <strong>{percent(item.weight)}</strong></span>)}<span className="microcopy">Quote denomination, not underlying economic or geographic exposure.</span></div>
      <details className="allocation-detail"><summary>Inspect allocation values and proportions <ChevronDown size={15} /></summary><AllocationChart analysis={analysis} /></details>
    </section>

    <section id={`${id}-panel-notes`} role="tabpanel" aria-labelledby={`${id}-tab-notes`} hidden={lens !== 'notes'} tabIndex={0} className="observatory-panel">
      <div className="observation-heading"><div><span className="report-label">Notes from the instruments</span><h2>Translate the measurements.</h2></div><span className="observation-stamp">Metric-grounded. Not LLM-generated.</span></div>
      <p className="observation-context">A transparent reading of the applied allocation. These observations use fixed rules—not investment opinions or buy-and-sell recommendations.</p>
      <div className="field-notes">{analysis.explanations.map((explanation, index) => <details key={`${explanation.metric}-${index}`} open={index === 0 ? true : undefined}>
        <summary><span className="field-note-index">{String(index + 1).padStart(2, '0')}</span><strong>{explanation.title}</strong>{explanation.severity === 'warning' && <span className="field-note-caution">Context matters</span>}<ChevronDown size={15} /></summary>
        <div className="field-note-body"><p>{explanation.text}</p><span>{metricLabel(explanation.metric)}</span></div>
      </details>)}</div>
      <section className="provenance report-provenance"><div><span className="report-label">Source record</span><h3>What went into this analysis</h3></div><div className="provenance-grid">
        <dl><dt>Historical source</dt><dd>{analysis.source}</dd><dt>Oldest market-data retrieval</dt><dd><Clock3 size={13} />{timestamp(analysis.market_fetched_at)}</dd></dl>
        <dl><dt>Aligned coverage</dt><dd>{date(coverage.start_date)} — {date(coverage.end_date)}</dd><dt>Observations</dt><dd>{coverage.observations} returns · {coverage.dropped_observations} excluded</dd></dl>
        <dl><dt>Price coverage</dt><dd>{percent(coverage.priced_weight, 0)} of holdings by value</dd><dt>Explanation method</dt><dd>{analysis.explanation_method}</dd></dl>
      </div><details><summary>Source assumptions & calculation notes <ChevronDown size={15} /></summary><ul>{analysis.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul><p>{coverage.return_method}</p><p>Analysis generated {timestamp(analysis.generated_at)}. {coverage.candidate_observations} candidate return observations before alignment.</p></details><button className="text-button" onClick={onMethodology}>Read the methodology <ArrowRight size={15} /></button></section>
    </section>

    <aside className="observatory-footnote"><span className="footnote-marker" aria-hidden="true">i</span><div><strong>Keep the limits in view.</strong><span>{coverage.dropped_observations > 0 ? `${coverage.dropped_observations} incomplete return intervals were excluded. ` : ''}Historical estimates are not forecasts. Fund look-through, live execution prices and trading are outside this app.</span></div><span className="footnote-method">REAL DATA<br />EXPLICIT ASSUMPTIONS</span></aside>
    {warnings.length > 0 && <details className="observatory-warnings"><summary>Data quality & limitations <span>{warnings.length}</span><ChevronDown size={15} /></summary>{warnings.map(warning => <Notice key={warning}>{warning}</Notice>)}</details>}
  </article>;
}

function RiskLine({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="risk-register-row"><span>{label}</span><strong className={value === 'Not available' ? 'undefined-metric' : ''}>{value}</strong><p>{note}</p></div>;
}

function HoldingRows({ holding, base, expanded, onToggle }: { holding: Analysis['holdings'][number]; base: string; expanded: boolean; onToggle: () => void }) {
  return <><tr><th scope="row"><div className="table-asset"><span className="ticker-tile small">{holding.ticker.slice(0, 2)}</span><div><strong>{holding.ticker}</strong><span>{holding.name}</span><small>{holding.instrument === 'ETF' ? 'ETF' : 'Stock'} · {holding.exchange}</small></div></div></th>
    <td>{number(holding.shares, 8)}</td><td>{money(holding.price, holding.currency, 2)}<small>{holding.currency} · {date(holding.price_date)}</small></td><td className="value-cell">{money(holding.market_value, base, 2)}</td><td>{percent(holding.weight)}</td><td>{percent(holding.annual_volatility)}</td><td><button className={`icon-button ${expanded ? 'expanded' : ''}`} aria-label={`${expanded ? 'Hide' : 'Show'} ${holding.ticker} quote and risk details`} aria-expanded={expanded} onClick={onToggle}><ChevronDown size={17} /></button></td></tr>
    {expanded && <tr className="holding-detail-row"><td colSpan={7}><div className="holding-detail-grid">
      <dl><dt>Sector</dt><dd>{holding.sector || (holding.instrument === 'ETF' ? 'Fund — no look-through' : 'Unknown')}</dd><dt>Historical beta</dt><dd>{number(holding.beta)}</dd><dt>Volatility contribution</dt><dd>{percent(holding.risk_contribution)}</dd></dl>
      <dl><dt>Quote to base FX</dt><dd>1 {holding.currency} = {number(holding.fx_rate, 6)} {base}</dd><dt>FX date</dt><dd>{date(holding.fx_date)}</dd><dt>Converted close</dt><dd>{money(holding.price_base, base, 4)}</dd></dl>
      <dl><dt>Quote price date</dt><dd>{date(holding.price_date)}</dd><dt>Market data retrieved</dt><dd>{timestamp(holding.fetched_at)}</dd><dt>Source</dt><dd>{holding.source}</dd></dl>
    </div>{holding.warnings.map(warning => <p className="field-hint" key={warning}>{warning}</p>)}</td></tr>}
  </>;
}
