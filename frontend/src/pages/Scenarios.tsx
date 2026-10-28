import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CircleStop, Play, RotateCcw } from 'lucide-react';
import type { Analysis, HoldingInput, ScenarioResponse } from '../types';
import { useLens, type Applied } from '../state/store';
import { api, errorMessage, isAbort, type ScenarioRequest } from '../lib/api';
import { setSticky, useElapsedSeconds, useSticky } from '../lib/hooks';
import { amount, currencyDigits, frequencyLabel, horizonLabel, isNum, num, percent, plural, rangeWords, signedNum } from '../lib/format';
import { checkPortfolio, sameHoldings } from '../lib/portfolio';
import { AnalysisStatus, NoAnalysis, PageHeader } from '../components/page';
import { Badge, Delta, ExampleBadge, Notice, Panel, ScrollRegion, Spinner, cx } from '../components/ui';
import { HoldingsEditor } from '../components/HoldingsEditor';

interface ScenarioRun {
  id: number;
  basisId: number;
  holdings: HoldingInput[];
  startedAt: number;
}

interface ScenarioResult {
  basisId: number;
  holdings: HoldingInput[];
  request: ScenarioRequest;
  response: ScenarioResponse;
  at: number;
}

interface ScenarioState {
  basisId: number | null;
  /** The applied portfolio the what-if is compared with (name and holdings when it was adopted). */
  basisName: string;
  basisHoldings: HoldingInput[];
  /** Name of the portfolio the what-if holdings were first copied from. */
  origin: string;
  holdings: HoldingInput[];
  running: ScenarioRun | null;
  result: ScenarioResult | null;
  error: string | null;
}

const KEY = 'scenario';
const EMPTY: ScenarioState = { basisId: null, basisName: '', basisHoldings: [], origin: '', holdings: [], running: null, result: null, error: null };
let controller: AbortController | null = null;
let sequence = 0;

const copyHoldings = (holdings: HoldingInput[]) => holdings.map(holding => ({ ticker: holding.ticker, shares: holding.shares }));

function stopRunning() {
  sequence += 1;
  controller?.abort();
  controller = null;
}

function startOver(applied: Applied) {
  stopRunning();
  const portfolio = applied.request.portfolio;
  setSticky<ScenarioState>(KEY, {
    basisId: applied.id,
    basisName: portfolio.name,
    basisHoldings: copyHoldings(portfolio.holdings),
    origin: portfolio.name,
    holdings: copyHoldings(portfolio.holdings),
    running: null,
    result: null,
    error: null,
  });
}

/** Keeps the edited holdings but compares them with a newly applied analysis; results for the old one are dropped. */
function rebase(applied: Applied) {
  stopRunning();
  const portfolio = applied.request.portfolio;
  setSticky<ScenarioState>(KEY, previous => ({
    ...previous,
    basisId: applied.id,
    basisName: portfolio.name,
    basisHoldings: copyHoldings(portfolio.holdings),
    running: null,
    result: null,
    error: null,
  }));
}

function runScenario(applied: Applied, holdings: HoldingInput[]) {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  const id = ++sequence;
  const frozen = copyHoldings(holdings);
  const baseline = applied.request.portfolio;
  const request: ScenarioRequest = {
    baseline: { name: baseline.name, base_currency: baseline.base_currency, holdings: copyHoldings(baseline.holdings) },
    scenario: { name: baseline.name, base_currency: baseline.base_currency, holdings: frozen },
    benchmark: applied.request.benchmark,
    range: applied.request.range,
    frequency: applied.request.frequency,
  };
  setSticky<ScenarioState>(KEY, previous => ({ ...previous, running: { id, basisId: applied.id, holdings: frozen, startedAt: Date.now() }, error: null }));
  api
    .scenario(request, current.signal)
    .then(response => {
      if (id !== sequence) return;
      controller = null;
      setSticky<ScenarioState>(KEY, previous => ({
        ...previous,
        running: null,
        error: null,
        result: { basisId: applied.id, holdings: frozen, request, response, at: Date.now() },
      }));
    })
    .catch(error => {
      if (id !== sequence || isAbort(error)) return;
      controller = null;
      setSticky<ScenarioState>(KEY, previous => ({ ...previous, running: null, error: errorMessage(error) }));
    });
}

function cancelScenario() {
  stopRunning();
  setSticky<ScenarioState>(KEY, previous => ({ ...previous, running: null }));
}

export function ScenariosPage() {
  const { applied } = useLens();
  return (
    <div className="page scenarios">
      <PageHeader title="Scenarios" meta="Change share counts or add and remove holdings, then compare against the applied portfolio.">
        <Badge tone="brass">Unsaved what-if — nothing is traded</Badge>
        {applied?.hypothetical && <ExampleBadge />}
      </PageHeader>
      <AnalysisStatus />
      {applied ? <ScenarioWorkbench applied={applied} /> : <NoAnalysis what="Scenarios" />}
    </div>
  );
}

function ScenarioWorkbench({ applied }: { applied: Applied }) {
  const { config } = useLens();
  const [state, setState] = useSticky<ScenarioState>(KEY, () => EMPTY);
  const [showErrors, setShowErrors] = useState(false);
  const elapsed = useElapsedSeconds(state.running?.startedAt);

  const portfolio = applied.request.portfolio;
  const basisChanged = state.basisId !== null && state.basisId !== applied.id;
  const edited = state.basisId !== null && !sameHoldings(state.holdings, state.basisHoldings);
  const samePortfolio = state.basisName === portfolio.name && sameHoldings(state.basisHoldings, portfolio.holdings);

  useEffect(() => {
    // Follow the applied analysis automatically unless that would discard edits made to a different portfolio.
    if (state.basisId === null || (basisChanged && !edited)) startOver(applied);
    else if (basisChanged && samePortfolio) rebase(applied);
  }, [state.basisId, basisChanged, edited, samePortfolio, applied]);

  const holdings = state.basisId === null ? portfolio.holdings : state.holdings;
  const check = checkPortfolio({ ...portfolio, holdings }, config);
  const unchanged = sameHoldings(holdings, portfolio.holdings);
  const result = state.result && state.result.basisId === applied.id ? state.result : null;
  const stale = result ? !sameHoldings(result.holdings, holdings) : false;
  const running = state.running && state.running.basisId === applied.id ? state.running : null;

  const compare = () => {
    if (!check.ok) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    runScenario(applied, holdings);
  };

  return (
    <>
      {basisChanged && edited && !samePortfolio && (
        <Notice
          tone="info"
          title="The applied analysis changed since this what-if was started"
          actions={
            <>
              <button type="button" className="button" onClick={() => startOver(applied)}>
                <RotateCcw size={14} aria-hidden="true" />
                Start from “{portfolio.name}”
              </button>
              <button type="button" className="button button--quiet" onClick={() => rebase(applied)}>
                Keep my edits
              </button>
            </>
          }
        >
          Your what-if holdings came from “{state.basisName}”. Comparisons always start from the applied portfolio, with its benchmark, range and return frequency.
        </Notice>
      )}
      <div className="grid scenario-grid">
        <Panel
          className="col-5 col-wide-md"
          title="What-if holdings"
          meta={
            state.basisId !== null && state.origin !== portfolio.name ? (
              <>
                Edited from “{state.origin}” · compared with “{portfolio.name}” · unsaved
              </>
            ) : (
              <>
                Copy of “{portfolio.name}” · {portfolio.base_currency} · unsaved
              </>
            )
          }
          actions={
            <button type="button" className="button button--quiet button--small" onClick={() => startOver(applied)} disabled={unchanged && !state.result}>
              <RotateCcw size={14} aria-hidden="true" />
              Reset
            </button>
          }
        >
          <HoldingsEditor
            holdings={holdings}
            onChange={next => setState(previous => ({ ...previous, holdings: next }))}
            rowErrors={check.rowErrors}
            maxHoldings={config?.max_holdings ?? 20}
            caption="What-if holdings"
          />
          {showErrors && !check.ok && (
            <Notice tone="error" title="The comparison was not started" live>
              <ul className="plain-list" role="list">
                {check.messages.map(message => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="action-row">
            {running ? (
              <button type="button" className="button" onClick={cancelScenario}>
                <CircleStop size={14} aria-hidden="true" />
                Cancel comparison
              </button>
            ) : (
              <button type="button" className="button button--primary" onClick={compare} disabled={basisChanged}>
                <Play size={14} aria-hidden="true" />
                Compare
              </button>
            )}
            <p className="action-row__note faint">
              vs <span className="mono">{applied.request.benchmark}</span> · {rangeWords(applied.request.range)} · {frequencyLabel(applied.request.frequency)} returns
            </p>
          </div>
        </Panel>
        <Panel
          className="col-7 col-wide-md"
          title="Comparison"
          meta={result ? `Applied portfolio vs what-if · same benchmark, range and frequency` : 'Run a comparison to see the effect of your edits'}
        >
          <div aria-live="polite">
            {running && (
              <div className="waiting waiting--inline">
                <div className="waiting__bar" aria-hidden="true" />
                <p className="waiting__title">
                  <Spinner /> Comparing… <span aria-hidden="true">{elapsed > 0 ? `${elapsed} s` : ''}</span>
                </p>
                <p className="waiting__text">Both portfolios are priced and analyzed with the same settings. The first run for new securities can take up to a minute.</p>
              </div>
            )}
            {state.error && !running && (
              <Notice tone="error" title="The comparison could not be completed">
                {state.error}
              </Notice>
            )}
          </div>
          {!running && !result && !state.error && (
            <p className="faint">
              {unchanged ? 'Edit share counts, add or remove holdings in the what-if editor, then select Compare.' : 'Select Compare to see how your edits change risk and weights.'}
            </p>
          )}
          {result && (
            <>
              {stale && !running && (
                <Notice tone="warn" title="Edited since this comparison">
                  The figures below describe the holdings as they were when you selected Compare. Compare again to update them.
                </Notice>
              )}
              <ComparisonTable response={result.response} />
              <WeightsTable baseline={result.response.baseline} scenario={result.response.scenario} />
            </>
          )}
        </Panel>
      </div>
    </>
  );
}

interface Row {
  label: ReactNode;
  before: string;
  after: string;
  change: ReactNode;
}

/** Rounds half away from zero (as Intl number formatting does) to the number of decimals a figure is shown with. */
function asShown(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
}

/** The change between two figures as displayed, so each change equals the difference of the figures beside it. */
function shownChange(after: number | null | undefined, before: number | null | undefined, decimals: number): number | null {
  return isNum(after) && isNum(before) ? asShown(asShown(after, decimals) - asShown(before, decimals), decimals) : null;
}

function ComparisonTable({ response }: { response: ScenarioResponse }) {
  const { baseline, scenario } = response;
  const base = baseline.portfolio.base_currency;
  const cents = currencyDigits(base);
  const horizon = horizonLabel(scenario.coverage.horizon);
  // Percent figures are stored as fractions, so one displayed decimal of a percent is three decimals of the fraction.
  const points = (after: number | null, before: number | null, digits = 1) => (
    <Delta tone="neutral" kind="points" digits={digits} value={shownChange(after, before, digits + 2)} />
  );
  const rows: Row[] = [
    {
      label: `Total value (${base})`,
      before: amount(baseline.total_value, base),
      after: amount(scenario.total_value, base),
      change: <Delta tone="neutral" kind="money" currency={base} value={shownChange(scenario.total_value, baseline.total_value, cents)} />,
    },
    {
      label: 'Annual volatility',
      before: percent(baseline.risk.annual_volatility, 1),
      after: percent(scenario.risk.annual_volatility, 1),
      change: points(scenario.risk.annual_volatility, baseline.risk.annual_volatility),
    },
    {
      label: (
        <>
          Beta vs <span className="mono">{scenario.benchmark.ticker}</span>
        </>
      ),
      before: num(baseline.risk.beta, 2),
      after: num(scenario.risk.beta, 2),
      change: <Delta tone="neutral" kind="number" digits={2} value={shownChange(scenario.risk.beta, baseline.risk.beta, 2)} />,
    },
    {
      label: 'Correlation with benchmark',
      before: signedNum(baseline.risk.benchmark_correlation, 2),
      after: signedNum(scenario.risk.benchmark_correlation, 2),
      change: <Delta tone="neutral" kind="number" digits={2} value={shownChange(scenario.risk.benchmark_correlation, baseline.risk.benchmark_correlation, 2)} />,
    },
    {
      label: 'Max drawdown',
      before: percent(baseline.risk.max_drawdown, 1),
      after: percent(scenario.risk.max_drawdown, 1),
      change: points(scenario.risk.max_drawdown, baseline.risk.max_drawdown),
    },
    // Tail losses are small numbers, so they get a second decimal to make modest changes visible.
    {
      label: `VaR 95 · ${horizon}`,
      before: percent(baseline.risk.historical_var_95, 2),
      after: percent(scenario.risk.historical_var_95, 2),
      change: points(scenario.risk.historical_var_95, baseline.risk.historical_var_95, 2),
    },
    {
      label: `ES 95 · ${horizon}`,
      before: percent(baseline.risk.historical_es_95, 2),
      after: percent(scenario.risk.historical_es_95, 2),
      change: points(scenario.risk.historical_es_95, baseline.risk.historical_es_95, 2),
    },
    {
      label: 'Effective positions',
      before: num(baseline.concentration.effective_positions, 1),
      after: num(scenario.concentration.effective_positions, 1),
      change: (
        <Delta
          tone="neutral"
          kind="number"
          digits={1}
          value={shownChange(scenario.concentration.effective_positions, baseline.concentration.effective_positions, 1)}
        />
      ),
    },
    {
      label: 'Largest position',
      before: `${baseline.concentration.largest_position} ${percent(baseline.concentration.largest_weight, 1)}`,
      after: `${scenario.concentration.largest_position} ${percent(scenario.concentration.largest_weight, 1)}`,
      change: points(scenario.concentration.largest_weight, baseline.concentration.largest_weight),
    },
  ];
  return (
    <>
      <ScrollRegion label="What-if comparison">
        <table className="ledger ledger--compare">
          <caption className="sr-only">Risk metrics for the applied portfolio and the what-if, with the change</caption>
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col" className="num">
                Applied
              </th>
              <th scope="col" className="num">
                What-if
              </th>
              <th scope="col" className="num">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <th scope="row">{row.label}</th>
                <td className="num">{row.before}</td>
                <td className="num">{row.after}</td>
                <td className="num">{row.change}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="panel__foot faint">
        Changes are shown as ▲ higher / ▼ lower, without judging them as good or bad, and are taken between the figures as shown. Percentage-point changes are marked “pp”.
      </p>
    </>
  );
}

function WeightsTable({ baseline, scenario }: { baseline: Analysis; scenario: Analysis }) {
  const rows = useMemo(() => {
    const before = new Map(baseline.holdings.map(holding => [holding.ticker, holding]));
    const after = new Map(scenario.holdings.map(holding => [holding.ticker, holding]));
    const tickers = [...new Set([...after.keys(), ...before.keys()])];
    return tickers
      .map(ticker => ({
        ticker,
        name: after.get(ticker)?.name ?? before.get(ticker)?.name ?? ticker,
        before: before.get(ticker)?.weight ?? 0,
        after: after.get(ticker)?.weight ?? 0,
        sharesBefore: before.get(ticker)?.shares ?? 0,
        sharesAfter: after.get(ticker)?.shares ?? 0,
      }))
      .sort((a, b) => b.after - a.after || b.before - a.before);
  }, [baseline.holdings, scenario.holdings]);
  const max = Math.max(...rows.map(row => Math.max(row.before, row.after)), 0) || 1;

  return (
    <section className="weights" aria-labelledby="weights-heading">
      <h3 className="section-title" id="weights-heading">
        Weights before and after
      </h3>
      <ScrollRegion label="Weights before and after">
        <table className="ledger ledger--compact ledger--weights">
          <caption className="sr-only">Portfolio weight of each holding in the applied portfolio and in the what-if</caption>
          <thead>
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col" className="num">
                Shares
              </th>
              <th scope="col" className="num">
                Applied
              </th>
              <th scope="col" className="num">
                What-if
              </th>
              <th scope="col" className="weights__bars-head">
                <span className="legend-swatch legend-swatch--before" aria-hidden="true" /> Applied <span className="legend-swatch legend-swatch--after" aria-hidden="true" /> What-if
              </th>
              <th scope="col" className="num">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.ticker} className={cx(row.after === 0 && 'is-removed', row.before === 0 && 'is-added')}>
                <th scope="row" title={row.name}>
                  <span className="mono">{row.ticker}</span>
                  {row.before === 0 && <span className="weights__tag">new</span>}
                  {row.after === 0 && <span className="weights__tag">removed</span>}
                </th>
                <td className="num" title={`Applied ${num(row.sharesBefore, 6, 0)} → what-if ${num(row.sharesAfter, 6, 0)}`}>
                  {row.sharesBefore === row.sharesAfter ? num(row.sharesAfter, 6, 0) : `${num(row.sharesBefore, 6, 0)} → ${num(row.sharesAfter, 6, 0)}`}
                </td>
                <td className="num">{percent(row.before, 1)}</td>
                <td className="num">{percent(row.after, 1)}</td>
                <td className="weights__bars" aria-hidden="true">
                  <span className="weights__bar weights__bar--before" style={{ width: `${(row.before / max) * 100}%` }} />
                  <span className="weights__bar weights__bar--after" style={{ width: `${(row.after / max) * 100}%` }} />
                </td>
                <td className="num">
                  <Delta tone="neutral" kind="points" value={shownChange(row.after, row.before, 3)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <p className="panel__foot faint">{plural(rows.length, 'security', 'securities')} across both portfolios.</p>
    </section>
  );
}
