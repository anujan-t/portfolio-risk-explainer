import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ChartNoAxesCombined, Check, ChevronDown, FolderOpen, LockKeyhole, Moon, Plus, RefreshCw, Save, SlidersHorizontal, Sun, Trash2 } from 'lucide-react';
import type { Analysis, AnalysisRequest, Asset, HistoryRange, PortfolioInput, SavedPortfolio } from './types';
import { api, errorMessage, isAbort, portfolioCopy, validTicker, validatePortfolio } from './api';
import { date } from './format';
import Dashboard from './components/Dashboard';
import PortfolioBuilder from './components/PortfolioBuilder';
import Scenario from './components/Scenario';
import Methodology from './components/Methodology';
import { ConfirmDialog, EmptyState, Notice, PanelHeading, Spinner } from './components/Shared';

type View = 'dashboard' | 'builder' | 'scenario' | 'methodology';
interface Applied { request: AnalysisRequest; analysis: Analysis; hypothetical: boolean }
const emptyPortfolio = (): PortfolioInput => ({ name: 'Untitled portfolio', base_currency: 'USD', holdings: [] });
const benchmarks = ['SPY', 'QQQ', 'VTI', 'XIU.TO', 'VFV.TO'];
const ranges: { value: HistoryRange; label: string }[] = [{ value: '6mo', label: '6M' }, { value: '1y', label: '1Y' }, { value: '2y', label: '2Y' }, { value: '5y', label: '5Y' }];
const navigation = [
  { id: 'dashboard' as const, label: 'Overview' },
  { id: 'builder' as const, label: 'Portfolio builder' },
  { id: 'scenario' as const, label: 'What-if lab' },
  { id: 'methodology' as const, label: 'Methodology' },
];
const headings: Record<View, { eyebrow: string; title: string; subtitle: string }> = {
  dashboard: { eyebrow: 'A personal portfolio observatory', title: 'Look a little closer', subtitle: 'Explore the shape of your allocation. Follow the relationships beneath it.' },
  builder: { eyebrow: 'The composition studio', title: 'Build your allocation', subtitle: 'Find a security, set its quantity, and give it a place in the picture.' },
  scenario: { eyebrow: 'An experiment, not a trade', title: 'Explore another possibility', subtitle: 'Change the composition. Keep the comparison honest.' },
  methodology: { eyebrow: 'The field guide', title: 'Understand the instruments', subtitle: 'Data sources, mathematical assumptions, and the edges of what we know.' },
};

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [theme, setTheme] = useState(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const [draft, setDraft] = useState<PortfolioInput>(emptyPortfolio);
  const [benchmark, setBenchmark] = useState('SPY');
  const [customBenchmark, setCustomBenchmark] = useState(false);
  const [range, setRange] = useState<HistoryRange>('1y');
  const [examples, setExamples] = useState<PortfolioInput[]>([]);
  const [saved, setSaved] = useState<SavedPortfolio[]>([]);
  const [currentSaved, setCurrentSaved] = useState<SavedPortfolio | null>(null);
  const [sample, setSample] = useState(false);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [assets, setAssets] = useState<Record<string, Asset>>({});
  const [starting, setStarting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedPortfolio | null>(null);
  const [error, setError] = useState('');
  const [libraryError, setLibraryError] = useState('');
  const [message, setMessage] = useState('');
  const analysisController = useRef<AbortController | null>(null);
  const draftGeneration = useRef(0);
  const mounted = useRef(true);
  const library = useRef<HTMLDetailsElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const closeLibrary = (event: PointerEvent) => {
      if (event.target instanceof Node && library.current && !library.current.contains(event.target)) library.current.open = false;
    };
    document.addEventListener('pointerdown', closeLibrary);
    return () => document.removeEventListener('pointerdown', closeLibrary);
  }, []);

  function navigate(next: View) {
    setView(next);
    if (library.current) library.current.open = false;
    window.scrollTo({ top: 0, behavior: 'instant' });
    window.setTimeout(() => heading.current?.focus({ preventScroll: true }), 0);
  }

  const updateAsset = useCallback((asset: Asset) => setAssets(previous => ({ ...previous, [asset.ticker]: asset })), []);
  const validation = validatePortfolio(draft);
  const benchmarkError = validTicker(benchmark) ? '' : 'Enter a valid stock or ETF benchmark ticker.';
  const dirty = !!applied && (JSON.stringify(draft) !== JSON.stringify(applied.request.portfolio) || benchmark !== applied.request.benchmark || range !== applied.request.range);
  const unsaved = !currentSaved || JSON.stringify(draft) !== JSON.stringify(portfolioCopy(currentSaved));

  function changeDraft(value: PortfolioInput) { draftGeneration.current += 1; setDraft(value); setMessage(''); }

  async function analyze(portfolio: PortfolioInput, selectedBenchmark: string, selectedRange: HistoryRange, hypothetical: boolean, refresh = false) {
    if (validatePortfolio(portfolio) || !validTicker(selectedBenchmark)) return;
    analysisController.current?.abort();
    const controller = new AbortController();
    analysisController.current = controller;
    const request: AnalysisRequest = { portfolio: portfolioCopy(portfolio), benchmark: selectedBenchmark, range: selectedRange, refresh };
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await api.analyze(request, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      setApplied({ request, analysis: response, hypothetical });
      setAssets(previous => ({ ...previous, ...Object.fromEntries(response.holdings.map(holding => [holding.ticker, holding])) }));
    } catch (err) {
      if (!isAbort(err) && mounted.current) setError(errorMessage(err));
    } finally { if (!controller.signal.aborted && mounted.current) setBusy(false); }
  }

  useEffect(() => {
    mounted.current = true;
    const generation = draftGeneration.current;
    void Promise.allSettled([api.examples(), api.portfolios()]).then(([exampleResult, savedResult]) => {
      if (!mounted.current) return;
      if (savedResult.status === 'fulfilled') setSaved(savedResult.value.portfolios);
      else setLibraryError(errorMessage(savedResult.reason));
      if (exampleResult.status === 'fulfilled') {
        setExamples(exampleResult.value.examples);
        if (draftGeneration.current === generation && exampleResult.value.examples[0]) {
          const first = portfolioCopy(exampleResult.value.examples[0]);
          setDraft(first); setSample(true);
          void analyze(first, 'SPY', '1y', true);
        }
      } else setError(errorMessage(exampleResult.reason));
      setStarting(false);
    });
    return () => { mounted.current = false; analysisController.current?.abort(); };
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
  }
  function load(portfolio: SavedPortfolio) {
    analysisController.current?.abort(); setBusy(false);
    changeDraft(portfolioCopy(portfolio)); setCurrentSaved(portfolio); setSample(false);
    navigate('builder'); setError(''); setMessage(`Loaded “${portfolio.name}” (revision ${portfolio.revision}). Apply analysis to inspect this draft.`);
  }
  function loadExample(portfolio: PortfolioInput) {
    analysisController.current?.abort(); setBusy(false);
    changeDraft(portfolioCopy(portfolio)); setCurrentSaved(null); setSample(true); setError('');
    setMessage('Hypothetical sample loaded. It has not been saved as your portfolio.');
  }
  function startNew() {
    analysisController.current?.abort(); setBusy(false);
    changeDraft(emptyPortfolio()); setCurrentSaved(null); setSample(false); setError(''); navigate('builder');
  }
  async function refreshLibrary() {
    try { const response = await api.portfolios(); setSaved(response.portfolios); setLibraryError(''); }
    catch (err) { setLibraryError(errorMessage(err)); }
  }
  async function save(asNew = false) {
    if (validation || saving) return;
    const snapshot = portfolioCopy(draft);
    const generation = draftGeneration.current;
    const target = asNew ? null : currentSaved;
    setSaving(true); setError(''); setMessage('');
    try {
      const result = await api.save(snapshot, target);
      if (!mounted.current) return;
      setSaved(previous => [result, ...previous.filter(item => item.id !== result.id)]);
      if (draftGeneration.current === generation) setCurrentSaved(result);
      else if (target) setCurrentSaved(previous => previous?.id === target.id ? result : previous);
      setMessage(`Saved “${result.name}” locally. ${draftGeneration.current === generation ? 'No data was shared with a broker or cloud portfolio service.' : 'Your later edits remain unsaved.'}`);
    } catch (err) {
      if (mounted.current) setError(errorMessage(err));
      void refreshLibrary();
    } finally { if (mounted.current) setSaving(false); }
  }
  async function deletePortfolio() {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true); setError('');
    try {
      await api.remove(target);
      setSaved(previous => previous.filter(item => item.id !== target.id));
      if (currentSaved?.id === target.id) setCurrentSaved(null);
      setDeleteTarget(null); setMessage(`“${target.name}” was deleted from local storage. Your current draft and analysis remain available.`);
    } catch (err) { setError(errorMessage(err)); setDeleteTarget(null); void refreshLibrary(); }
    finally { setDeleting(false); }
  }

  function apply(refresh = false) { void analyze(draft, benchmark, range, sample, refresh); }
  function cancel() { analysisController.current?.abort(); setBusy(false); setMessage('Analysis cancelled. Any previously applied analysis is unchanged.'); }

  return <div className="lens-app observatory-app">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="lens-masthead">
      <div className="masthead-inner">
        <a className="lens-wordmark" href="#overview" aria-label="LENS home" onClick={event => { event.preventDefault(); navigate('dashboard'); }}><svg className="observatory-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M2 12V2h10M28 2h10v10M38 28v10H28M12 38H2V28" stroke="currentColor" strokeWidth="1.2" /><circle cx="20" cy="20" r="9" stroke="currentColor" strokeWidth="1.2" /><path d="M20 5v8M20 27v8M5 20h8M27 20h8" stroke="var(--cp-accent)" strokeWidth="1.2" /><circle cx="20" cy="20" r="2" fill="var(--cp-accent)" /></svg><strong>LENS<span>.</span></strong><span className="wordmark-descriptor">THE PORTFOLIO<br />OBSERVATORY</span></a>
        <nav className="lens-nav" aria-label="Main navigation">{navigation.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)} aria-current={view === item.id ? 'page' : undefined}>{item.label}</button>)}</nav>
        <div className="masthead-actions">
          <details ref={library} className="lens-library" onKeyDown={event => {
            if (event.key === 'Escape' && library.current) { library.current.open = false; library.current.querySelector('summary')?.focus(); }
          }}>
            <summary><FolderOpen size={16} /><span>Portfolio library</span><span className="library-count">{saved.length}</span><ChevronDown size={13} /></summary>
            <section className="library-popover" aria-label="Portfolio library">
              <div className="library-heading"><div><span className="eyebrow">Private local storage</span><h2>Your portfolios</h2></div><button className="icon-button" aria-label="Refresh saved portfolios" onClick={() => void refreshLibrary()}><RefreshCw size={16} /></button></div>
              {saved.length ? <div className="library-records">{saved.map(portfolio => <button key={portfolio.id} onClick={() => load(portfolio)}><span><strong>{portfolio.name}</strong><small>{portfolio.holdings.length} holdings · revision {portfolio.revision}</small></span><span>{portfolio.base_currency}<ArrowRight size={14} /></span></button>)}</div> : <p className="library-empty-note">No saved portfolios yet. Create an allocation at the holdings desk and save it here.</p>}
              {libraryError && <Notice tone="error">{libraryError}</Notice>}
              <button className="button secondary full-width" onClick={startNew}><Plus size={15} />New portfolio</button>
              <p className="library-privacy"><LockKeyhole size={12} />Share quantities stay on this computer.</p>
            </section>
          </details>
          <button className="icon-button lens-theme" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
        </div>
      </div>
    </header>

    <main id="main-content" className="lens-main" tabIndex={-1}>
      <div className="document-kicker"><span>Independent perspective. Deliberate decisions.</span><span>Local by design / Historical by definition</span></div>
      <div className="lens-document">
        <header className="document-heading"><div><span className="eyebrow">{headings[view].eyebrow}</span><h1 ref={heading} tabIndex={-1}>{headings[view].title}<span className="heading-period">.</span></h1><p>{headings[view].subtitle}</p></div><div className="document-actions"><span className="edition-label">VALUE IS A NUMBER. EXPOSURE IS A PATTERN.</span><button className="button secondary" onClick={view === 'dashboard' ? () => navigate('builder') : startNew}>{view === 'dashboard' ? <><SlidersHorizontal size={15} />Edit portfolio</> : <><Plus size={15} />New portfolio</>}</button></div></header>
        {libraryError && view === 'builder' && <Notice tone="error">{libraryError}</Notice>}
        {message && <Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice>}
        {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}

        {(view === 'dashboard' || view === 'builder') && <section className="analysis-controls" aria-label="Analysis settings">
          <div className="control-field"><label htmlFor="benchmark-select">Benchmark</label><select id="benchmark-select" value={customBenchmark ? '__custom' : benchmark} onChange={event => {
            const value = event.target.value;
            setCustomBenchmark(value === '__custom');
            if (value !== '__custom') setBenchmark(value);
          }}>{benchmarks.map(ticker => <option key={ticker} value={ticker}>{ticker}</option>)}<option value="__custom">Other ticker…</option></select></div>
          {customBenchmark && <div className="control-field custom-benchmark"><label htmlFor="custom-benchmark">Stock / ETF symbol</label><input id="custom-benchmark" value={benchmark} maxLength={20} onChange={event => setBenchmark(event.target.value.toUpperCase().trim())} aria-invalid={!!benchmarkError} placeholder="ETF ticker" /></div>}
          <div className="history-control"><span id="history-label">History</span><div className="segmented" aria-labelledby="history-label">{ranges.map(item => <button key={item.value} className={range === item.value ? 'selected' : ''} aria-pressed={range === item.value} onClick={() => setRange(item.value)}>{item.label}</button>)}</div></div>
          <div className="control-status">{dirty ? <span className="draft-indicator"><i />Unapplied edits</span> : applied ? <span><Check size={14} />Analysis applied</span> : <span>Choose your perspective</span>}</div>
          <div className="control-actions"><button className="button primary" onClick={() => apply()} disabled={!!validation || !!benchmarkError || busy || starting}>{busy ? <Spinner>Analyzing…</Spinner> : <><ChartNoAxesCombined size={17} />Apply analysis</>}</button>{busy ? <button className="text-button" onClick={cancel}>Cancel</button> : <button className="icon-button refresh-data" title="Refresh public market data and apply this draft" aria-label="Refresh market data and apply draft" disabled={!!validation || !!benchmarkError || starting} onClick={() => apply(true)}><RefreshCw size={17} /></button>}</div>
          {benchmarkError && <p className="field-error control-validation">{benchmarkError}</p>}
        </section>}
        {dirty && view === 'dashboard' && <Notice>Your draft has changed. The charts below still describe <strong>{applied?.request.portfolio.name}</strong> in {applied?.request.portfolio.base_currency}, compared with {applied?.request.benchmark} over {applied?.request.range}. Choose <strong>Apply analysis</strong> to update them.</Notice>}
        {busy && (applied || view === 'builder') && <div className="analysis-progress" role="status"><Spinner>Retrieving completed prices and aligning daily returns…</Spinner><span>First-time requests can take 20–60 seconds. Edits made now won’t alter the request in progress.</span></div>}

        {view === 'dashboard' && (applied ? <Dashboard analysis={applied.analysis} hypothetical={applied.hypothetical} onScenario={() => navigate('scenario')} onMethodology={() => navigate('methodology')} /> : busy || starting ? <LoadingDashboard starting={starting} sample={sample} /> : <section className="panel"><EmptyState title="A clearer view starts with a portfolio." text="Add your stocks and ETFs, then apply an analysis. We use real historical prices — never made-up data or an arbitrary risk score." action={<button className="button primary" onClick={() => navigate('builder')}>Build a portfolio <ArrowRight size={17} /></button>} /></section>)}

        {view === 'builder' && <div className="builder-layout"><section className="panel builder-panel"><PanelHeading eyebrow={sample ? 'Hypothetical sample · never auto-saved' : currentSaved ? `Saved locally · revision ${currentSaved.revision}` : 'Your new, unsaved portfolio'} title="The holdings behind the story" action={<span className="badge">{unsaved ? 'Unsaved draft' : 'Saved locally'}</span>} />
          <PortfolioBuilder portfolio={draft} onChange={changeDraft} assets={assets} onAsset={updateAsset} />
          {validation && <p className="field-hint validation-summary">{validation}</p>}
          <div className="builder-actions"><button className="button primary" disabled={!!validation || !!benchmarkError || busy || starting} onClick={() => { apply(); navigate('dashboard'); }}>{busy ? <Spinner>Analyzing…</Spinner> : <>Analyze portfolio <ArrowRight size={17} /></>}</button><button className="button secondary" disabled={!!validation || saving || starting} onClick={() => void save()}>{saving ? <Spinner>Saving…</Spinner> : <><Save size={16} />{currentSaved ? 'Save changes' : 'Save portfolio'}</>}</button>{currentSaved && <button className="text-button" disabled={!!validation || saving} onClick={() => void save(true)}>Save a copy</button>}</div>
          <p className="field-hint">Saving stores holdings locally. Analysis settings and chart results are not saved; reapply them when you reload a portfolio.</p>
        </section><aside className="builder-aside">
          <section className="panel saved-panel"><PanelHeading eyebrow="Your private collection" title="Saved portfolios" action={<button className="icon-button" aria-label="Reload saved portfolio list" onClick={() => void refreshLibrary()}><RefreshCw size={16} /></button>} />
            {saved.length ? <div className="saved-cards">{saved.map(portfolio => <div className="saved-card" key={portfolio.id}><FolderOpen size={19} /><div><strong>{portfolio.name}</strong><span>{portfolio.holdings.length} holdings · {portfolio.base_currency}</span><small>Updated {date(portfolio.updated_at)} · v{portfolio.revision}</small><button className="text-button" onClick={() => load(portfolio)}>Load portfolio <ArrowRight size={13} /></button></div><button className="icon-button" aria-label={`Delete ${portfolio.name}`} onClick={() => setDeleteTarget(portfolio)}><Trash2 size={16} /></button></div>)}</div> : <div className="small-empty"><FolderOpen size={24} /><strong>No saved portfolios yet</strong><p>Save a portfolio to keep your holdings here between visits.</p></div>}
            <button className="button secondary full-width" onClick={startNew}><Plus size={16} />Start a new portfolio</button>
          </section>
          {!!examples.length && <section className="example-panel"><span className="eyebrow">Just looking around?</span><h2>Start with a sample.</h2><p>Hypothetical allocations for exploring the app. Not suggested investments or real accounts.</p>{examples.map(example => <button key={example.name} className="example-button" onClick={() => loadExample(example)}><span>{example.name}<small>{example.holdings.map(h => h.ticker).join(' · ')}</small></span><ArrowRight size={16} /></button>)}</section>}
          <div className="builder-privacy"><LockKeyhole size={18} /><p>No broker connection. No trades.<br /><strong>Just a better understanding.</strong></p></div>
        </aside></div>}

        {view === 'scenario' && (applied ? <Scenario key={applied.analysis.generated_at} applied={applied.request} analysis={applied.analysis} assets={assets} onAsset={updateAsset} /> : <section className="panel"><EmptyState title="First, establish your baseline." text="Apply a portfolio analysis to create the baseline for a what-if comparison. Your saved portfolio will not be changed." action={<button className="button primary" onClick={() => navigate('builder')}>Build your baseline <ArrowRight size={17} /></button>} /></section>)}
        {view === 'methodology' && <Methodology />}
        <footer className="footer"><span className="footer-brand">LENS.</span><p>A clearer perspective. Not investment advice.</p><span>Historical data · Deterministic explanations · Local storage</span></footer>
      </div>
    </main>
    {deleteTarget && <ConfirmDialog title={`Delete “${deleteTarget.name}”?`} confirmLabel="Delete local portfolio" busy={deleting} onConfirm={() => void deletePortfolio()} onClose={() => setDeleteTarget(null)}><p>This permanently removes the saved portfolio from this app’s local storage. Your current draft can remain open.</p><p>No holdings are sold and no financial account is affected.</p></ConfirmDialog>}
  </div>;
}

function LoadingDashboard({ starting, sample }: { starting: boolean; sample: boolean }) {
  return <section className="loading-dashboard" role="status"><div className="loading-visual" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div><span className="eyebrow">{starting ? 'Opening your private portfolio app' : 'A real perspective takes real data'}</span><h2>{starting ? 'Bringing things into focus.' : 'Putting your portfolio in perspective.'}</h2><p>{starting ? 'Loading sample allocations and your locally saved portfolios.' : `Retrieving completed historical closes${sample ? ' for a hypothetical sample' : ''}, converting currencies and aligning returns. A first request can take 20–60 seconds.`}</p><Spinner>{starting ? 'Connecting to the local service…' : 'No simulated prices. No shortcuts.'}</Spinner></section>;
}
