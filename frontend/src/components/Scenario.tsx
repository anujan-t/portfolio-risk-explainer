import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FlaskConical, RotateCcw } from 'lucide-react';
import type { Analysis, AnalysisRequest, Asset, PortfolioInput, ScenarioResponse } from '../types';
import { api, errorMessage, isAbort, portfolioCopy, validatePortfolio } from '../api';
import { date, money, number, percent, signed } from '../format';
import PortfolioBuilder from './PortfolioBuilder';
import { Notice, PanelHeading, Spinner } from './Shared';

export default function Scenario({ applied, analysis, assets, onAsset }: {
  applied: AnalysisRequest; analysis: Analysis; assets: Record<string, Asset>; onAsset: (asset: Asset) => void;
}) {
  const baseline = useRef(portfolioCopy(applied.portfolio)).current;
  const initial = () => ({ ...portfolioCopy(baseline), name: `${baseline.name.slice(0, 68)} · What-if` });
  const [draft, setDraft] = useState<PortfolioInput>(initial);
  const [result, setResult] = useState<ScenarioResponse | null>(null);
  const [comparedDraft, setComparedDraft] = useState<PortfolioInput | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const validation = validatePortfolio(draft);
  const dirty = comparedDraft && JSON.stringify(draft) !== JSON.stringify(comparedDraft);
  useEffect(() => () => controller.current?.abort(), []);

  async function compare() {
    if (validation || busy) return;
    const snapshot = portfolioCopy(draft);
    const request = new AbortController();
    controller.current?.abort(); controller.current = request;
    setBusy(true); setError('');
    try {
      const response = await api.scenario(baseline, snapshot, applied.benchmark, applied.range, request.signal);
      if (request.signal.aborted) return;
      setResult(response); setComparedDraft(snapshot);
      response.scenario.holdings.forEach(onAsset);
    } catch (err) { if (!isAbort(err)) setError(errorMessage(err)); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }

  function cancel() { controller.current?.abort(); setBusy(false); }
  return <div className="scenario-page">
    <div className="scenario-intro"><FlaskConical size={22} /><div><strong>A sandbox for your allocation, not your money.</strong><p>This is an unsaved copy of <b>{baseline.name}</b>. Comparisons use {applied.benchmark}, the {applied.range} range and an identical aligned market-data window. Your baseline and saved portfolio never change.</p></div><span className="badge rose">Unsaved scenario</span></div>
    <div className="scenario-layout">
      <section className="panel"><PanelHeading eyebrow="Make a small change. See the difference." title="Alternative allocation" action={<button className="icon-button" aria-label="Reset scenario to baseline holdings" onClick={() => { setDraft(initial()); setError(''); }}><RotateCcw size={17} /></button>} /><PortfolioBuilder portfolio={draft} onChange={setDraft} assets={assets} onAsset={onAsset} lockCurrency compact />
        {validation && <p className="field-error">{validation}</p>}
        <div className="builder-actions"><button className="button primary" disabled={busy || !!validation} onClick={() => void compare()}>{busy ? <Spinner>Comparing aligned histories…</Spinner> : <>Compare with baseline <ArrowRight size={17} /></>}</button>{busy && <button className="text-button" onClick={cancel}>Cancel</button>}</div>
        {busy && <p className="field-hint">A first request may take 20–60 seconds. You can keep editing; results will reflect the copy submitted.</p>}
      </section>
      <div className="scenario-results">
        {error && <Notice tone="error">{error}</Notice>}
        {dirty && <Notice>Your scenario has unapplied edits. These results still describe <strong>{comparedDraft.name}</strong> as it was at the last comparison.</Notice>}
        {result ? <>
          <section className="panel"><PanelHeading eyebrow="A like-for-like view" title="What changed?" action={<span className="badge">Historical, not predictive</span>} />
            <p className="section-description">{date(result.baseline.coverage.start_date)} — {date(result.baseline.coverage.end_date)} · {result.baseline.coverage.observations} aligned daily returns</p>
            <div className="table-scroll"><table className="comparison-table"><caption className="sr-only">Baseline and scenario risk metrics with deltas</caption><thead><tr><th scope="col">Metric</th><th scope="col">Baseline</th><th scope="col">What-if</th><th scope="col">Change</th></tr></thead><tbody>
              <CompareRow label={`Value (${baseline.base_currency})`} before={money(result.baseline.total_value, baseline.base_currency)} after={money(result.scenario.total_value, baseline.base_currency)} delta={`${result.delta.total_value > 0 ? '+' : ''}${money(result.delta.total_value, baseline.base_currency)}`} />
              <CompareRow label="Annual volatility" before={percent(result.baseline.risk.annual_volatility)} after={percent(result.scenario.risk.annual_volatility)} delta={`${signed(result.delta.annual_volatility * 100)} pp`} />
              <CompareRow label={`Beta vs ${applied.benchmark}`} before={number(result.baseline.risk.beta)} after={number(result.scenario.risk.beta)} delta={result.delta.beta === null ? 'Not available' : signed(result.delta.beta)} />
              <CompareRow label="Max drawdown" before={percent(result.baseline.risk.max_drawdown)} after={percent(result.scenario.risk.max_drawdown)} delta={`${signed(result.delta.max_drawdown * 100)} pp`} />
              <CompareRow label="Effective positions" before={number(result.baseline.concentration.effective_positions, 1)} after={number(result.scenario.concentration.effective_positions, 1)} delta={signed(result.delta.effective_positions)} />
            </tbody></table></div>
            <p className="chart-caption">pp = percentage points. Value changes reflect share quantities, not profit or loss. Positive drawdown changes mean a smaller historical decline; no change is a recommendation.</p>
          </section>
          <section className="panel"><PanelHeading title="Before & after weights" /><div className="table-scroll"><table className="comparison-table"><caption className="sr-only">Holding weights in the baseline and compared scenario</caption><thead><tr><th scope="col">Holding</th><th scope="col">Baseline</th><th scope="col">What-if</th><th scope="col">Change</th></tr></thead><tbody>
            {[...new Set([...result.baseline.holdings.map(h => h.ticker), ...result.scenario.holdings.map(h => h.ticker)])].map(ticker => {
              const before = result.baseline.holdings.find(h => h.ticker === ticker)?.weight ?? 0;
              const after = result.scenario.holdings.find(h => h.ticker === ticker)?.weight ?? 0;
              return <CompareRow key={ticker} label={ticker} before={percent(before)} after={percent(after)} delta={`${signed((after - before) * 100)} pp`} />;
            })}
          </tbody></table></div></section>
          <section className="panel scenario-notes"><PanelHeading title="Read this comparison carefully" /><p>Both portfolios were recomputed together. Their baseline metrics may differ from the dashboard if the common coverage changed. The dashboard has not been updated.</p><p><strong>Source:</strong> {result.scenario.source}</p><p><strong>Complete priced coverage:</strong> {percent(result.baseline.coverage.priced_weight, 0)} baseline / {percent(result.scenario.coverage.priced_weight, 0)} scenario.</p>
            {[...new Set([...result.baseline.warnings, ...result.scenario.warnings])].map(warning => <Notice key={warning}>{warning}</Notice>)}
            <details><summary>Calculation assumptions</summary><ul>{[...new Set([...result.baseline.assumptions, ...result.scenario.assumptions])].map(assumption => <li key={assumption}>{assumption}</li>)}</ul></details>
          </section>
        </> : <section className="scenario-placeholder"><div className="comparison-illustration" aria-hidden="true"><span /><span /><span /><ArrowRight size={24} /><span /><span /><span /></div><span className="eyebrow">From “what if” to “now I see”</span><h2>Change the mix.<br />Compare the trade-offs.</h2><p>Edit quantities, add a holding, or remove a position. We’ll compare volatility, concentration, beta and drawdown — not tell you what to buy.</p><div className="baseline-preview"><span>Applied baseline</span><strong>{baseline.name}</strong><span>{baseline.holdings.length} positions · {money(analysis.total_value, baseline.base_currency)} {baseline.base_currency}</span></div></section>}
      </div>
    </div>
  </div>;
}

function CompareRow({ label, before, after, delta }: { label: string; before: string; after: string; delta: string }) {
  return <tr><th scope="row">{label}</th><td>{before}</td><td>{after}</td><td><strong>{delta}</strong></td></tr>;
}
