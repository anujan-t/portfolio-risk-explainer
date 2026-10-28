import { useId, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Pencil, RefreshCw } from 'lucide-react';
import type { Analysis, AnalysisRequest, Frequency, HistoryRange, PortfolioInput } from '../types';
import { useLens, type Applied, type Controls } from '../state/store';
import { hrefFor, navigate } from '../lib/hooks';
import {
  DASH,
  amount,
  dateRange,
  fmtDate,
  fmtTimestamp,
  frequencyLabel,
  fxRate,
  horizonLabel,
  isNum,
  num,
  percent,
  plural,
  rangeLabel,
  rangeWords,
  signedNum,
} from '../lib/format';
import { normalizeTicker, sameHoldings, validTicker, weeklyAllowed } from '../lib/portfolio';
import { AnalysisStatus, NoAnalysis, PageHeader } from '../components/page';
import { Badge, Delta, ExampleBadge, FieldMessage, KeyValue, Notice, Panel, ScrollRegion, Segmented, cx } from '../components/ui';
import { PerformanceChart } from '../components/charts/PerformanceChart';
import { DrawdownChart } from '../components/charts/DrawdownChart';
import { DivergingBars } from '../components/Bars';
import { CorrelationMatrix } from '../components/CorrelationMatrix';

const OTHER = '__other__';

export function RiskPage() {
  const { applied } = useLens();
  const analysis = applied?.analysis ?? null;
  return (
    <div className="page risk">
      <PageHeader title="Risk" meta={applied ? <AppliedLine applied={applied} /> : 'No analysis applied yet'}>
        {applied?.hypothetical && <ExampleBadge />}
      </PageHeader>
      <RiskControls />
      <AnalysisStatus />
      {applied && analysis ? <RiskResults applied={applied} /> : <NoAnalysis what="Risk results" />}
    </div>
  );
}

function AppliedLine({ applied }: { applied: Applied }) {
  const { analysis, request } = applied;
  return (
    <>
      <span>{analysis.portfolio.name}</span>
      <span className="page-head__sep" aria-hidden="true" />
      <span>
        vs <span className="mono">{analysis.benchmark.ticker}</span> {analysis.benchmark.name}
      </span>
      <span className="page-head__sep" aria-hidden="true" />
      <span>
        {rangeWords(request.range)}, {analysis.coverage.frequency} returns
      </span>
      <span className="page-head__sep" aria-hidden="true" />
      <span>{dateRange(analysis.coverage.start_date, analysis.coverage.end_date)}</span>
    </>
  );
}

// ---- Controls ------------------------------------------------------------------------------

function describeHoldingChanges(applied: PortfolioInput, draft: PortfolioInput): string | null {
  if (sameHoldings(applied.holdings, draft.holdings)) return null;
  const before = new Map(applied.holdings.map(holding => [holding.ticker, holding.shares]));
  const after = new Map(draft.holdings.map(holding => [holding.ticker, holding.shares]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [ticker, shares] of after) {
    if (!before.has(ticker)) added += 1;
    else if (before.get(ticker) !== shares) changed += 1;
  }
  for (const ticker of before.keys()) if (!after.has(ticker)) removed += 1;
  const parts = [added && `${added} added`, removed && `${removed} removed`, changed && `${changed} changed`].filter(Boolean);
  return `holdings (${parts.join(', ') || 'edited'})`;
}

function describeChanges(request: AnalysisRequest, draft: PortfolioInput, controls: Controls): string[] {
  const changes: string[] = [];
  const holdings = describeHoldingChanges(request.portfolio, draft);
  if (holdings) changes.push(holdings);
  if (request.portfolio.base_currency !== draft.base_currency) changes.push(`base currency ${request.portfolio.base_currency} → ${draft.base_currency}`);
  if (request.portfolio.name.trim() !== draft.name.trim()) changes.push('portfolio name');
  if (request.benchmark !== controls.benchmark) changes.push(`benchmark ${request.benchmark} → ${controls.benchmark || 'none'}`);
  if (request.range !== controls.range) changes.push(`range ${rangeLabel(request.range)} → ${rangeLabel(controls.range)}`);
  if (request.frequency !== controls.frequency) changes.push(`frequency ${frequencyLabel(request.frequency)} → ${frequencyLabel(controls.frequency)}`);
  return changes;
}

const FREQUENCY_HELP: Record<Frequency, string> = {
  auto: 'Auto uses weekly returns when holdings trade in different time zones, otherwise daily.',
  daily: 'Daily returns give more observations but can understate co-movement between markets that close at different times.',
  weekly: 'Weekly returns line up markets that close at different times; they need a range of 1 year or longer.',
};

function RiskControls() {
  const { config, controls, setControls, apply, applied, pending, draft, refreshMarketData, importNotice, dismissImportNotice } = useLens();
  const ids = useId();
  const known = (ticker: string) => config?.benchmarks.some(benchmark => benchmark.ticker === ticker) ?? false;
  const [otherOpen, setOtherOpen] = useState(() => Boolean(controls.benchmark) && !known(controls.benchmark));
  const [otherText, setOtherText] = useState(() => (controls.benchmark && !known(controls.benchmark) ? controls.benchmark : ''));
  const [problems, setProblems] = useState<string[]>([]);
  if (!config) return null;

  const ranges: HistoryRange[] = config.ranges;
  const frequencies: Frequency[] = config.frequencies;
  const otherInvalid = otherOpen && otherText.trim() !== '' && !validTicker(normalizeTicker(otherText));
  const changes = applied ? describeChanges(applied.request, draft.portfolio, controls) : [];
  const pendingMatches = pending ? describeChanges(pending.request, draft.portfolio, controls).length === 0 : false;
  const upToDate = Boolean(applied) && changes.length === 0 && !pending;
  const appliedFrequency = applied && applied.request.frequency === controls.frequency && applied.request.range === controls.range ? applied.analysis.coverage.frequency_reason : null;
  const regions = [...new Set(config.benchmarks.map(benchmark => benchmark.region))];

  const onApply = () => {
    const found = apply();
    setProblems(found);
    if (!found.length) dismissImportNotice();
  };

  return (
    <section className="controls" aria-label="Analysis settings">
      <div className="controls__draft">
        <span className="controls__draft-label">Draft</span>
        <span className="controls__draft-name">{draft.portfolio.name || 'Untitled portfolio'}</span>
        <span className="faint">
          {plural(draft.portfolio.holdings.length, 'holding')} · {draft.portfolio.base_currency}
        </span>
        <a className="button button--quiet button--small controls__edit" href={hrefFor('import', 'manual')}>
          <Pencil size={13} aria-hidden="true" />
          Edit holdings
        </a>
      </div>
      <div className="controls__row">
        <div className="field controls__benchmark">
          <label className="field__label" htmlFor={`${ids}-benchmark`}>
            Benchmark
          </label>
          <select
            id={`${ids}-benchmark`}
            className="input select"
            value={otherOpen ? OTHER : controls.benchmark}
            onChange={event => {
              const value = event.target.value;
              if (value === OTHER) {
                setOtherOpen(true);
                setControls({ benchmark: normalizeTicker(otherText) });
              } else {
                setOtherOpen(false);
                setControls({ benchmark: value });
              }
            }}
          >
            {regions.map(region => (
              <optgroup key={region} label={region}>
                {config.benchmarks
                  .filter(benchmark => benchmark.region === region)
                  .map(benchmark => (
                    <option key={benchmark.ticker} value={benchmark.ticker}>
                      {benchmark.ticker} · {benchmark.name}
                    </option>
                  ))}
              </optgroup>
            ))}
            <option value={OTHER}>Other ticker…</option>
          </select>
        </div>
        {otherOpen && (
          <div className="field controls__other">
            <label className="field__label" htmlFor={`${ids}-other`}>
              Benchmark ticker
            </label>
            <input
              id={`${ids}-other`}
              className={cx('input mono', otherInvalid && 'is-invalid')}
              value={otherText}
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. ^STOXX50E"
              maxLength={20}
              aria-invalid={otherInvalid || undefined}
              aria-describedby={otherInvalid ? `${ids}-other-error` : undefined}
              onChange={event => {
                setOtherText(event.target.value);
                setControls({ benchmark: normalizeTicker(event.target.value) });
              }}
            />
            {otherInvalid && <FieldMessage id={`${ids}-other-error`}>Use letters, digits, “.”, “-”, “^” or “=”.</FieldMessage>}
          </div>
        )}
        <div className="field">
          <span className="field__label" id={`${ids}-range`}>
            Range
          </span>
          <Segmented<HistoryRange>
            labelledBy={`${ids}-range`}
            value={controls.range}
            onChange={range => setControls({ range })}
            options={ranges.map(range => ({ value: range, label: rangeLabel(range), title: rangeWords(range) }))}
          />
        </div>
        <div className="field">
          <span className="field__label" id={`${ids}-frequency`}>
            Returns
          </span>
          <Segmented<Frequency>
            labelledBy={`${ids}-frequency`}
            describedBy={`${ids}-frequency-help`}
            value={controls.frequency}
            onChange={frequency => setControls({ frequency })}
            options={frequencies.map(frequency => {
              const blocked = frequency === 'weekly' && !weeklyAllowed(controls.range);
              return {
                value: frequency,
                label: frequencyLabel(frequency),
                disabled: blocked,
                title: blocked ? 'Weekly returns need a range of 1 year or longer' : FREQUENCY_HELP[frequency],
              };
            })}
          />
        </div>
        <div className="controls__actions">
          {upToDate && (
            <span className="controls__state">
              <Check size={14} aria-hidden="true" />
              Results match these settings
            </span>
          )}
          <button type="button" className="button button--primary" onClick={onApply} disabled={(Boolean(pending) && pendingMatches) || upToDate}>
            {pending && pendingMatches ? 'Applying…' : 'Apply'}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={refreshMarketData}
            disabled={!applied || Boolean(pending)}
            aria-label="Refresh market data for the applied analysis"
            title="Fetch fresh prices and exchange rates for the applied analysis"
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <p className="controls__help" id={`${ids}-frequency-help`}>
        {appliedFrequency ? <>Applied: {appliedFrequency}</> : FREQUENCY_HELP[controls.frequency]}
        {!weeklyAllowed(controls.range) && ' Weekly is unavailable for 6M because it would leave too few observations.'}
      </p>
      {applied && changes.length > 0 && !(pending && pendingMatches) && (
        <p className="unapplied" role="status">
          <span className="unapplied__mark" aria-hidden="true" />
          <span>
            <strong>Unapplied changes</strong> — {changes.join('; ')}. The results below still describe the applied analysis.
          </span>
        </p>
      )}
      {!applied && !pending && <p className="controls__help">Choose settings, then Apply to analyze the draft.</p>}
      {importNotice && (
        <Notice
          tone="success"
          title={`Draft updated from a screenshot: ${plural(importNotice.count, 'holding')} (${importNotice.mode === 'replace' ? 'replaced the draft' : 'added to the draft'})`}
          onDismiss={dismissImportNotice}
          actions={
            <>
              <button type="button" className="button button--primary" onClick={onApply}>
                Apply analysis
              </button>
              <button type="button" className="button" onClick={() => navigate('import', 'manual')}>
                Review holdings
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            </>
          }
        >
          Nothing has been analyzed or saved yet. Review the holdings if you like, then apply the analysis.
        </Notice>
      )}
      {problems.length > 0 && (
        <Notice tone="error" title="The analysis was not started" live onDismiss={() => setProblems([])}>
          <ul className="plain-list" role="list">
            {problems.map(problem => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      )}
    </section>
  );
}

// ---- Results -------------------------------------------------------------------------------

function troughDate(series: Analysis['series']): string | null {
  let worst = 0;
  let date: string | null = null;
  for (const point of series) {
    if (point.drawdown < worst) {
      worst = point.drawdown;
      date = point.date;
    }
  }
  return date;
}

function Metric({ label, value, sub, title }: { label: ReactNode; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="metric" title={title}>
      <dt className="metric__label">{label}</dt>
      <dd className="metric__value">{value}</dd>
      {sub && <dd className="metric__sub">{sub}</dd>}
    </div>
  );
}

function RiskResults({ applied }: { applied: Applied }) {
  const windowId = useId();
  const analysis = applied.analysis;
  const { risk, coverage, benchmark } = analysis;
  const base = analysis.portfolio.base_currency;
  const horizon = horizonLabel(coverage.horizon);
  const unit = coverage.horizon === 'week' ? 'week' : 'day';
  const trough = troughDate(analysis.series);

  return (
    <>
      {analysis.warnings.length > 0 && (
        <Notice tone="warn" title={`${plural(analysis.warnings.length, 'data warning')} for this analysis`}>
          <ul className="plain-list" role="list">
            {analysis.warnings.map(warning => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
      <dl className="metric-strip" aria-label="Risk metrics for the applied analysis">
        <Metric label="Annual volatility" value={percent(risk.annual_volatility, 1)} sub={<>Benchmark {percent(risk.benchmark_volatility, 1)}</>} />
        <Metric
          label={
            <>
              Beta vs <span className="mono">{benchmark.ticker}</span>
            </>
          }
          value={num(risk.beta, 2)}
          sub={isNum(risk.beta) ? 'Sensitivity to benchmark moves' : 'Not enough overlapping data'}
        />
        <Metric label="Correlation" value={signedNum(risk.benchmark_correlation, 2)} sub={<>with <span className="mono">{benchmark.ticker}</span></>} />
        <Metric label="Max drawdown" value={percent(risk.max_drawdown, 1)} sub={trough ? `Trough ${fmtDate(trough)}` : 'No decline from a peak'} />
        <Metric
          label={`VaR 95 · ${horizon}`}
          value={percent(risk.historical_var_95, 1)}
          sub={`${amount(risk.var_amount, base)} ${base}`}
          title={`Historical value at risk: in 5% of ${unit}s in this window, the portfolio lost more than this.`}
        />
        <Metric
          label={`ES 95 · ${horizon}`}
          value={percent(risk.historical_es_95, 1)}
          sub={`${amount(risk.es_amount, base)} ${base}`}
          title={`Expected shortfall: the average loss on the worst 5% of ${unit}s in this window.`}
        />
      </dl>

      <div className="grid grid--dense risk-grid">
        <Panel
          className="col-12"
          title="Performance"
          meta={
            <>
              Index = 100 at the window start · in {base} · {coverage.frequency} closes
            </>
          }
        >
          <PerformanceChart
            key={applied.id}
            series={analysis.series}
            portfolioName={analysis.portfolio.name}
            benchmarkTicker={benchmark.ticker}
            benchmarkName={benchmark.name}
          />
          <section className="window-facts" aria-labelledby={windowId}>
            <h3 className="section-title" id={windowId}>
              Applied window <span className="faint">· {dateRange(coverage.start_date, coverage.end_date)}</span>
            </h3>
            <KeyValue
              className="facts--strip"
              items={[
                { label: 'Portfolio return', value: <Delta value={risk.historical_return} digits={1} /> },
                { label: <>{benchmark.ticker} return</>, value: <Delta value={risk.benchmark_return} digits={1} /> },
                { label: `Best ${unit}`, value: <Delta value={risk.best_period} digits={2} /> },
                { label: `Worst ${unit}`, value: <Delta value={risk.worst_period} digits={2} /> },
                { label: `${unit === 'day' ? 'Daily' : 'Weekly'} volatility`, value: percent(risk.period_volatility, 2) },
                { label: 'Observations', value: `${num(coverage.observations, 0)} ${unit}s` },
              ]}
            />
          </section>
        </Panel>
        <Panel className="col-8 col-wide-md" title="Drawdown" meta="Decline from the previous peak of the portfolio index">
          <DrawdownChart key={applied.id} series={analysis.series} fill />
        </Panel>
        <Panel className="col-4" title="Risk contribution" meta="Share of portfolio variance by holding">
          <RiskContribution analysis={analysis} />
        </Panel>
        <Panel className="col-6 col-wide-md" title="Correlation" meta={`Pairwise correlation of ${coverage.frequency} returns`}>
          <CorrelationMatrix correlations={analysis.correlations} frequency={coverage.frequency} />
        </Panel>
        <Panel className="col-6 col-wide-md" title="Risk notes" actions={<Badge tone="brass">Rule-based, not AI</Badge>}>
          {analysis.explanations.length ? (
            <ol className="notes" role="list">
              {analysis.explanations.map((note, index) => (
                <li key={`${note.metric}-${index}`} className={cx('notes__item', note.severity === 'warning' && 'notes__item--warning')}>
                  <span className="notes__number" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="notes__body">
                    <p className="notes__title">
                      {note.title}
                      {note.severity === 'warning' && <Badge tone="warn">Watch</Badge>}
                    </p>
                    <p className="notes__text">{note.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="faint">No notes were generated for this analysis.</p>
          )}
          {analysis.explanation_method && <p className="panel__foot faint">{analysis.explanation_method}</p>}
        </Panel>
        <AssumptionsPanel applied={applied} />
      </div>
    </>
  );
}

function RiskContribution({ analysis }: { analysis: Analysis }) {
  const rows = useMemo(
    () => [...analysis.holdings].sort((a, b) => (b.risk_contribution ?? Number.NEGATIVE_INFINITY) - (a.risk_contribution ?? Number.NEGATIVE_INFINITY)),
    [analysis.holdings],
  );
  const offsets = rows.filter(holding => isNum(holding.risk_contribution) && holding.risk_contribution < 0);
  return (
    <>
      <DivergingBars
        tone="neutral"
        label="Risk contribution by holding"
        data={rows.map(holding => ({
          key: holding.ticker,
          label: <span className="mono">{holding.ticker}</span>,
          value: holding.risk_contribution,
          title: `${holding.name}: weight ${percent(holding.weight, 1)}, risk share ${percent(holding.risk_contribution, 1)}`,
          display: (
            <span className="dbars__figure">
              {percent(holding.risk_contribution, 1)}
              <span className="dbars__sub">wt {percent(holding.weight, 1)}</span>
            </span>
          ),
        }))}
      />
      <p className="panel__foot faint">
        Bars right of the axis added to portfolio variance.{' '}
        {offsets.length > 0 ? (
          <>
            Bars left of it are a <strong className="muted">historical offset</strong>: {offsets.map(holding => holding.ticker).join(', ')} moved against the rest in this window, which may not
            persist.
          </>
        ) : (
          'No holding acted as a historical offset in this window.'
        )}
      </p>
    </>
  );
}

function AssumptionsPanel({ applied }: { applied: Applied }) {
  const { analysis, request } = applied;
  const { coverage } = analysis;
  const base = analysis.portfolio.base_currency;
  return (
    <Panel className="col-12" title="Assumptions and data" meta={`${analysis.source} · market data fetched ${fmtTimestamp(analysis.market_fetched_at)}`}>
      <div className="data-layout">
        <section className="data-layout__fx" aria-labelledby="fx-heading">
          <h3 className="section-title" id="fx-heading">
            Exchange-rate conversions
          </h3>
          {analysis.fx.length ? (
            <ScrollRegion label="Exchange-rate conversions">
              <table className="ledger ledger--compact">
                <caption className="sr-only">Exchange rates used to convert holdings into {base}</caption>
                <thead>
                  <tr>
                    <th scope="col">Currency</th>
                    <th scope="col" className="num">
                      Rate to {base}
                    </th>
                    <th scope="col">Date</th>
                    <th scope="col">Method</th>
                    <th scope="col">Pairs</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.fx.map(fx => (
                    <tr key={fx.currency}>
                      <th scope="row" className="mono">
                        {fx.currency}
                      </th>
                      <td className="num" title={`1 ${fx.currency} = ${num(fx.rate, 6)} ${fx.base}`}>
                        {fxRate(fx.rate)}
                      </td>
                      <td className="nowrap">{fmtDate(fx.date)}</td>
                      <td>{fx.method === 'direct' ? 'Direct' : fx.method === 'inverse' ? 'Inverse' : 'Triangulated'}</td>
                      <td className="mono">{fx.pairs.join(' · ') || DASH}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          ) : (
            <p className="faint">Every holding is priced in {base}; no conversion was needed.</p>
          )}
          <p className="faint data-layout__note">
            Prices in minor units (GBp, ZAc, ILA) are scaled to their ISO currency before conversion. Historical closes use the exchange rate from the same date; current values use the
            latest completed rate shown here.
          </p>
        </section>
        <section className="data-layout__coverage" aria-labelledby="coverage-heading">
          <h3 className="section-title" id="coverage-heading">
            Coverage
          </h3>
          <KeyValue
            className="facts--compact"
            items={[
              { label: 'Window', value: `${fmtDate(coverage.start_date)} – ${fmtDate(coverage.end_date)}` },
              { label: 'Requested range', value: rangeWords(request.range) },
              {
                label: 'Frequency',
                value: `${frequencyLabel(coverage.requested_frequency)} → ${coverage.frequency} (${horizonLabel(coverage.horizon)} horizon)`,
              },
              { label: 'Observations', value: `${num(coverage.observations, 0)} used of ${num(coverage.candidate_observations, 0)} (minimum ${num(coverage.min_observations, 0)})` },
              { label: 'Dropped', value: `${num(coverage.dropped_observations, 0)} incomplete ${coverage.frequency === 'weekly' ? 'weeks' : 'days'}` },
              { label: 'Priced weight', value: percent(coverage.priced_weight, 1) },
              { label: 'Return method', value: coverage.return_method },
              { label: 'Periods per year', value: num(coverage.periods_per_year, 0) },
              { label: 'Generated', value: fmtTimestamp(analysis.generated_at) },
            ]}
          />
        </section>
        <section className="data-layout__assumptions" aria-labelledby="assumptions-heading">
          <h3 className="section-title" id="assumptions-heading">
            Assumptions
          </h3>
          {analysis.assumptions.length ? (
            <ul className="bullet-list">
              {analysis.assumptions.map(assumption => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          ) : (
            <p className="faint">No additional assumptions were reported.</p>
          )}
          {analysis.warnings.length > 0 && (
            <p className="faint data-layout__note">
              {plural(analysis.warnings.length, 'data warning')} for this analysis {analysis.warnings.length === 1 ? 'is' : 'are'} listed above the risk metrics.
            </p>
          )}
        </section>
      </div>
    </Panel>
  );
}
