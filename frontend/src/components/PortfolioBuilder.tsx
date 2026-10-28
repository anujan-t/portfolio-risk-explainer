import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownLeft, Check, Plus, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, errorMessage, isAbort, validTicker } from '../api';
import type { Asset, Currency, PortfolioInput, SearchResult } from '../types';
import { date, money, number } from '../format';
import { Notice, PanelHeading, Spinner } from './Shared';

interface Props {
  portfolio: PortfolioInput;
  onChange: (value: PortfolioInput) => void;
  assets: Record<string, Asset>;
  onAsset: (asset: Asset) => void;
  lockCurrency?: boolean;
  compact?: boolean;
}

export default function PortfolioBuilder({ portfolio, onChange, assets, onAsset, lockCurrency = false, compact = false }: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const resolveController = useRef<AbortController | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    if (selected || query.trim().length < 1) {
      setResults([]); setSearching(false); setSearched(false);
      return () => controller.abort();
    }
    setSearching(true); setSearched(false); setResults([]); setActiveIndex(-1);
    const timer = window.setTimeout(() => {
      api.search(query.trim(), controller.signal).then(value => {
        if (!controller.signal.aborted) { setResults(value.results); setSearched(true); }
      }).catch(err => {
        if (!isAbort(err) && !controller.signal.aborted) { setError(errorMessage(err)); setSearched(true); }
      }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, selected]);

  useEffect(() => () => resolveController.current?.abort(), []);
  useEffect(() => {
    const listener = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', listener);
    return () => document.removeEventListener('pointerdown', listener);
  }, []);

  async function resolve(ticker: string) {
    setOpen(false); setError(''); setSelected(null);
    resolveController.current?.abort();
    const controller = new AbortController();
    resolveController.current = controller;
    setResolving(true);
    try {
      const asset = await api.asset(ticker.toUpperCase(), controller.signal);
      if (controller.signal.aborted) return;
      onAsset(asset); setSelected(asset); setQuery(asset.ticker);
      if (portfolio.holdings.some(h => h.ticker === asset.ticker)) setError(`${asset.ticker} is already in this portfolio. Edit its share quantity below instead.`);
    } catch (err) {
      if (!isAbort(err)) setError(errorMessage(err));
    } finally { if (!controller.signal.aborted) setResolving(false); }
  }

  function add() {
    if (!selected) return;
    const shares = Number(quantity);
    if (!Number.isFinite(shares) || shares <= 0 || shares > 1e9) { setError('Enter a share quantity greater than zero and at most 1 billion.'); return; }
    if (portfolio.holdings.length >= 20) { setError('This portfolio has reached the 20-holding limit.'); return; }
    if (portfolio.holdings.some(h => h.ticker === selected.ticker)) { setError(`${selected.ticker} is already included. Edit the existing holding instead.`); return; }
    onChange({ ...portfolio, holdings: [...portfolio.holdings, { ticker: selected.ticker, shares }] });
    setSelected(null); setQuery(''); setQuantity('1'); setError(''); setOpen(false);
    input.current?.focus();
  }

  function changeQuery(value: string) {
    resolveController.current?.abort(); setResolving(false);
    setQuery(value); setSelected(null); setOpen(true); setError('');
  }

  return <div className={`builder-content ${compact ? 'compact-builder' : ''}`}>
    <div className="form-grid">
      <div className="field"><label htmlFor={`${id}-name`}>Portfolio name</label><input id={`${id}-name`} value={portfolio.name} maxLength={80} placeholder="A name that means something to you" onChange={event => onChange({ ...portfolio, name: event.target.value })} /></div>
      <div className="field"><label htmlFor={`${id}-currency`}>Base currency</label><select id={`${id}-currency`} disabled={lockCurrency} value={portfolio.base_currency} onChange={event => onChange({ ...portfolio, base_currency: event.target.value as Currency })}><option value="USD">USD · US dollar</option><option value="CAD">CAD · Canadian dollar</option></select></div>
    </div>
    {lockCurrency && <p className="field-hint">Base currency stays the same as the baseline for a like-for-like comparison.</p>}

    <div className="add-position">
      <div className="section-label"><span className="eyebrow">Add a position</span><span className="microcopy">US & Canadian stocks / ETFs</span></div>
      <div className="asset-search" ref={container}>
        <label className="sr-only" htmlFor={`${id}-search`}>Search by ticker or company name</label>
        <div className="search-input"><Search size={19} />
          <input ref={input} id={`${id}-search`} placeholder="Search a company or ticker…"
            value={query} autoComplete="off" role="combobox" aria-expanded={open && !!query && !selected}
            aria-controls={`${id}-results`} aria-autocomplete="list" aria-activedescendant={open && activeIndex >= 0 ? `${id}-result-${activeIndex}` : undefined}
            onChange={event => changeQuery(event.target.value)} onFocus={() => { if (!selected) setOpen(true); }}
            onKeyDown={event => {
              if (event.key === 'Escape') { setOpen(false); setActiveIndex(-1); }
              if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActiveIndex(i => Math.min(i + 1, results.length - 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
              if (event.key === 'Enter' && !resolving) {
                event.preventDefault();
                if (open && activeIndex >= 0 && results[activeIndex]) void resolve(results[activeIndex].ticker);
                else if (!selected && validTicker(query.trim().toUpperCase())) void resolve(query.trim());
              }
            }} />
          {(searching || resolving) ? <Spinner /> : query && <button className="icon-button" aria-label="Clear ticker search" onClick={() => changeQuery('')}><X size={16} /></button>}
        </div>
        {open && !!query && !selected && <div className="search-dropdown">
          <div id={`${id}-results`} role="listbox" aria-label="Matching stocks and ETFs">
            {results.map((result, index) => <button type="button" role="option" aria-selected={index === activeIndex} id={`${id}-result-${index}`} key={result.ticker}
              className={`search-result ${activeIndex === index ? 'active' : ''}`} onClick={() => void resolve(result.ticker)}>
              <span className="ticker-tile small">{result.ticker.slice(0, 2)}</span>
              <span className="result-name"><strong>{result.ticker}</strong><span>{result.name}</span></span><span className="result-type">{result.instrument}<small>{result.exchange}</small></span>
            </button>)}
          </div>
          {searching && <div className="search-status"><Spinner>Searching public market symbols…</Spinner></div>}
          {!searching && searched && !results.length && <div className="search-status">No search matches. Try a company name or resolve an exact ticker.</div>}
          {validTicker(query.trim().toUpperCase()) && <button className="direct-lookup" disabled={resolving} onClick={() => void resolve(query.trim())}>Look up exact symbol <strong>{query.trim().toUpperCase()}</strong><ArrowDownLeft size={15} /></button>}
        </div>}
      </div>
      <p className="field-hint">Search sends symbols or company names only. Share quantities never go to the market-data provider.</p>
      {selected && <div className="selected-asset">
        <div className="selected-title"><span className="ticker-tile">{selected.ticker.slice(0, 2)}</span><div><strong>{selected.ticker} <Check className="verified" size={14} /></strong><span>{selected.name}</span></div><span className="badge">{selected.instrument === 'ETF' ? 'ETF' : 'Stock'}</span></div>
        <div className="asset-quote"><strong>{money(selected.price, selected.currency, 2)} <span>{selected.currency}</span></strong><span>Completed daily close · {date(selected.price_date)}</span></div>
        <p className="field-hint">{selected.exchange} · {selected.sector || (selected.instrument === 'ETF' ? 'Fund — no sector look-through' : 'Sector not available')}</p>
        <div className="quantity-add"><div className="field"><label htmlFor={`${id}-quantity`}>Shares</label><input type="number" id={`${id}-quantity`} min="0.00000001" max="1000000000" step="any" inputMode="decimal" value={quantity} onChange={event => setQuantity(event.target.value)} /></div><button className="button primary" disabled={portfolio.holdings.length >= 20} onClick={add}><Plus size={17} />Add holding</button></div>
        {selected.warnings.map(warning => <Notice key={warning}>{warning}</Notice>)}
      </div>}
      {error && <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>}
    </div>

    <PanelHeading title="Your positions" action={<span className="count-label">{portfolio.holdings.length} / 20</span>} />
    {portfolio.holdings.length ? <div className="position-list">
      <div className="position-list-header"><span>Asset</span><span>Shares</span><span className="sr-only">Remove</span></div>
      {portfolio.holdings.map(holding => {
        const asset = assets[holding.ticker];
        const invalid = !Number.isFinite(holding.shares) || holding.shares <= 0 || holding.shares > 1e9;
        return <div className="position-row" key={holding.ticker}>
          <div className="position-name"><span className="ticker-tile small">{holding.ticker.slice(0, 2)}</span><div><strong>{holding.ticker}</strong><span>{asset?.name || 'Metadata resolved when analyzed'}</span>{asset && <small>{asset.currency} · {asset.instrument === 'ETF' ? 'ETF' : 'Stock'}</small>}</div></div>
          <div className="position-quantity"><label className="sr-only" htmlFor={`${id}-${holding.ticker}`}>{holding.ticker} shares</label><input id={`${id}-${holding.ticker}`} type="number" min="0.00000001" max="1000000000" step="any" inputMode="decimal" value={holding.shares || ''} aria-invalid={invalid} onChange={event => {
            const shares = Number(event.target.value);
            onChange({ ...portfolio, holdings: portfolio.holdings.map(h => h.ticker === holding.ticker ? { ...h, shares } : h) });
          }} />{invalid && <small className="field-error">Positive quantity required (≤ 1B)</small>}</div>
          <button className="icon-button remove-holding" aria-label={`Remove ${holding.ticker}`} onClick={() => onChange({ ...portfolio, holdings: portfolio.holdings.filter(h => h.ticker !== holding.ticker) })}><Trash2 size={17} /></button>
        </div>;
      })}
      <div className="positions-foot"><ShieldCheck size={15} /><span>Private quantities · {number(portfolio.holdings.reduce((sum, h) => sum + (Number.isFinite(h.shares) ? h.shares : 0), 0), 4)} total shares across {portfolio.holdings.length} positions</span></div>
    </div> : <div className="empty-positions"><Plus size={22} /><strong>Start with your first holding.</strong><span>Find a company or ETF above, then enter how many shares you hold.</span></div>}
  </div>;
}
