import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, RotateCcw, X } from 'lucide-react';
import type { Analysis, AssetHistory, HistoryRange, ValuedHolding } from '../types';
import { useAppliedNews, useLens } from '../state/store';
import { api, errorMessage, isAbort } from '../lib/api';
import { useNow, useSticky } from '../lib/hooks';
import {
  DASH,
  amount,
  fmtDate,
  fmtTimestamp,
  fxRate,
  isNum,
  num,
  percent,
  plural,
  quantity,
  quotePrice,
  quoteUnitLabel,
  rangeLabel,
  relative,
  shortDate,
} from '../lib/format';
import { canonicalSector, newsForTicker, sectorExposures } from '../lib/derive';
import { AnalysisStatus, NoAnalysis, PageHeader } from '../components/page';
import { Delta, Drawer, KeyValue, Notice, Panel, Segmented, Spinner, Tabs, cx, panelId, tabId } from '../components/ui';
import { CompositionBar, WeightMeter, type CompositionItem } from '../components/Bars';
import { PriceChart } from '../components/charts/PriceChart';
import { NewsList } from '../components/News';

type SortKey = 'ticker' | 'name' | 'exchange' | 'currency' | 'shares' | 'price' | 'fx' | 'value' | 'weight' | 'session' | 'm1' | 'y1' | 'vol' | 'risk';
interface Sort {
  key: SortKey;
  direction: 'asc' | 'desc';
}
type CompositionView = 'holding' | 'sector' | 'currency' | 'exchange';

const TEXT_KEYS: SortKey[] = ['ticker', 'name', 'exchange', 'currency'];

function sortValue(holding: ValuedHolding, key: SortKey): string | number | null {
  switch (key) {
    case 'ticker':
      return holding.ticker;
    case 'name':
      return holding.name;
    case 'exchange':
      return holding.exchange;
    case 'currency':
      return holding.currency;
    case 'shares':
      return holding.shares;
    case 'price':
      return holding.price * holding.currency_scale;
    case 'fx':
      return holding.fx_rate;
    case 'value':
      return holding.market_value;
    case 'weight':
      return holding.weight;
    case 'session':
      return holding.session?.return_local ?? null;
    case 'm1':
      return holding.period_returns.m1;
    case 'y1':
      return holding.period_returns.y1;
    case 'vol':
      return holding.annual_volatility;
    case 'risk':
      return holding.risk_contribution;
  }
}

function sortHoldings(holdings: ValuedHolding[], sort: Sort): ValuedHolding[] {
  const factor = sort.direction === 'asc' ? 1 : -1;
  return [...holdings].sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    const leftMissing = left === null || (typeof left === 'number' && !isNum(left));
    const rightMissing = right === null || (typeof right === 'number' && !isNum(right));
    if (leftMissing && rightMissing) return a.ticker.localeCompare(b.ticker);
    if (leftMissing) return 1;
    if (rightMissing) return -1;
    const order = typeof left === 'string' && typeof right === 'string' ? left.localeCompare(right) : (left as number) - (right as number);
    return order === 0 ? a.ticker.localeCompare(b.ticker) : order * factor;
  });
}

export function HoldingsPage() {
  const { applied, draft } = useLens();
  const analysis = applied?.analysis ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const holding = analysis?.holdings.find(entry => entry.ticker === selected) ?? null;
  const name = analysis?.portfolio.name ?? draft.portfolio.name;

  return (
    <div className="page holdings">
      <PageHeader
        title="Holdings"
        dateline={[
          name,
          ...(analysis
            ? [
                `${plural(analysis.holdings.length, 'holding')} valued in ${analysis.portfolio.base_currency}`,
                `Prices to ${shortDate(analysis.session.latest_date ?? analysis.coverage.end_date)}`,
              ]
            : []),
        ]}
        example={applied?.hypothetical}
      />
      <AnalysisStatus />
      {analysis ? (
        <>
          <Composition analysis={analysis} />
          <HoldingsLedger analysis={analysis} onOpen={setSelected} />
        </>
      ) : (
        <NoAnalysis what="Holdings" />
      )}
      {analysis && holding && <HoldingDrawer key={holding.ticker} analysis={analysis} holding={holding} onClose={() => setSelected(null)} />}
    </div>
  );
}

// ---- Composition -------------------------------------------------------------------------

function Composition({ analysis }: { analysis: Analysis }) {
  const [view, setView] = useSticky<CompositionView>('holdings-composition', () => 'holding');
  const concentration = analysis.concentration;
  const items: CompositionItem[] = useMemo(() => {
    switch (view) {
      case 'holding':
        return [...analysis.holdings]
          .sort((a, b) => b.weight - a.weight)
          .map(holding => ({ key: holding.ticker, label: <span className="mono">{holding.ticker}</span>, text: `${holding.ticker} ${holding.name}`, weight: holding.weight }));
      case 'sector':
        return [...sectorExposures(analysis)].sort((a, b) => b[1] - a[1]).map(([name, weight]) => ({ key: name, label: name, text: name, weight }));
      case 'currency':
        return [...concentration.currency_exposures]
          .sort((a, b) => b.weight - a.weight)
          .map(entry => ({ key: entry.currency, label: <span className="mono">{entry.currency}</span>, text: entry.currency, weight: entry.weight }));
      case 'exchange':
        return [...concentration.exchange_exposures].sort((a, b) => b.weight - a.weight).map(entry => ({ key: entry.label, label: entry.label, text: entry.label, weight: entry.weight }));
    }
  }, [view, analysis, concentration]);
  const words: Record<CompositionView, string> = { holding: 'holding', sector: 'sector', currency: 'currency', exchange: 'exchange' };

  return (
    <Panel
      className="composition"
      title="Composition"
      meta={`Share of portfolio value by ${words[view]}`}
      source="Yahoo Finance closes, exchange rates and sector classifications; LENS calculations."
      actions={
        <Tabs<CompositionView>
          label="Group composition by"
          idBase="composition"
          size="small"
          value={view}
          onChange={setView}
          items={[
            { id: 'holding', label: 'Holding' },
            { id: 'sector', label: 'Sector' },
            { id: 'currency', label: 'Currency' },
            { id: 'exchange', label: 'Exchange' },
          ]}
        />
      }
    >
      <div className="composition__layout">
        <div role="tabpanel" id={panelId('composition', view)} aria-labelledby={tabId('composition', view)} className="composition__chart">
          <CompositionBar items={items} label={`Portfolio by ${words[view]}`} />
        </div>
        <KeyValue
          className="facts--compact facts--strip composition__facts"
          items={[
            { label: 'Positions', value: num(concentration.positions, 0) },
            { label: 'Effective positions', value: <span title="1 ÷ HHI: the number of equal-weight holdings with the same concentration">{num(concentration.effective_positions, 1)}</span> },
            { label: 'Largest', value: <><span className="mono">{concentration.largest_position}</span> ({percent(concentration.largest_weight, 1)})</> },
            { label: 'Top 3 holdings', value: percent(concentration.top_3_weight, 1) },
            { label: 'HHI', value: <span title="Herfindahl–Hirschman index: the sum of squared weights">{num(concentration.hhi, 3)}</span> },
            { label: 'Funds (not looked through)', value: percent(concentration.fund_weight, 1) },
            { label: 'Sector unknown', value: percent(concentration.unknown_sector_weight, 1) },
          ]}
        />
      </div>
    </Panel>
  );
}

// ---- Positions ------------------------------------------------------------------------------

function HoldingsLedger({ analysis, onOpen }: { analysis: Analysis; onOpen: (ticker: string) => void }) {
  const [sort, setSort] = useSticky<Sort>('holdings-sort', () => ({ key: 'weight', direction: 'desc' }));
  const base = analysis.portfolio.base_currency;
  const rows = useMemo(() => sortHoldings(analysis.holdings, sort), [analysis.holdings, sort]);
  const maxWeight = Math.max(...analysis.holdings.map(holding => holding.weight), 0);
  const weightSum = analysis.holdings.reduce((sum, holding) => sum + holding.weight, 0);
  const riskValues = analysis.holdings.map(holding => holding.risk_contribution).filter(isNum);
  const riskSum = riskValues.length ? riskValues.reduce((sum, value) => sum + value, 0) : null;
  const flagged = analysis.holdings.some(holding => holding.warnings.length > 0);
  const minorUnits = [
    ...new Set(
      analysis.holdings
        .filter(holding => holding.currency !== holding.currency_iso && holding.currency_scale > 0 && holding.currency_scale < 1)
        .map(holding => `${holding.currency} is quoted in minor units: ${num(1 / holding.currency_scale, 0)} ${holding.currency} = 1 ${holding.currency_iso}`),
    ),
  ];

  const columns: { key: SortKey; label: string; numeric: boolean; title?: string }[] = [
    { key: 'ticker', label: 'Ticker', numeric: false },
    { key: 'name', label: 'Name', numeric: false },
    { key: 'exchange', label: 'Exchange', numeric: false },
    { key: 'currency', label: 'Quote', numeric: false, title: 'Currency the price is quoted in' },
    { key: 'shares', label: 'Shares', numeric: true },
    { key: 'price', label: 'Last close', numeric: true, title: 'Latest completed close, in quote units' },
    { key: 'fx', label: `FX to ${base}`, numeric: true, title: `${base} per unit of the holding’s ISO currency` },
    { key: 'value', label: `Value (${base})`, numeric: true },
    { key: 'weight', label: 'Weight', numeric: true },
    { key: 'session', label: 'Session', numeric: true, title: 'Return over the latest completed session, in the quote currency' },
    { key: 'm1', label: '1M', numeric: true, title: 'One-month total return, in the quote currency' },
    { key: 'y1', label: '1Y', numeric: true, title: 'One-year total return, in the quote currency' },
    { key: 'vol', label: 'Volatility', numeric: true, title: 'Annualized volatility' },
    { key: 'risk', label: 'Risk share', numeric: true, title: 'Share of portfolio variance. A negative share means the holding offset risk over the period.' },
  ];

  const toggle = (key: SortKey) =>
    setSort(previous => (previous.key === key ? { key, direction: previous.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: TEXT_KEYS.includes(key) ? 'asc' : 'desc' }));

  return (
    <Panel
      className="ledger-panel"
      title="Positions"
      meta={`Values in ${base}. Session, 1M and 1Y are total returns in each holding’s quote currency.`}
      source="Yahoo Finance daily closes, dividends and exchange rates; LENS calculations."
      flush
    >
      <div className="table-scroll" role="region" aria-label="Positions table" tabIndex={0}>
        <table className="ledger ledger--holdings">
          <caption className="sr-only">
            Holdings, sorted by {columns.find(column => column.key === sort.key)?.label} {sort.direction === 'asc' ? 'ascending' : 'descending'}. Select a ticker to open its details.
          </caption>
          <thead>
            <tr>
              {columns.map(column => {
                const active = sort.key === column.key;
                const Icon = active ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className={cx(column.numeric && 'num', column.key === 'ticker' && 'sticky-col', column.key === 'name' && 'col-name')}
                    aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button type="button" className={cx('sort', active && 'is-active')} onClick={() => toggle(column.key)} title={column.title}>
                      <span>{column.label}</span>
                      <Icon size={12} aria-hidden="true" className="sort__icon" />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(holding => {
              const sameCurrency = holding.currency_iso === base;
              return (
                <tr
                  key={holding.ticker}
                  className="is-clickable"
                  onClick={event => {
                    // Park focus on the row's button so closing the drawer returns there.
                    event.currentTarget.querySelector<HTMLButtonElement>('.ticker-button')?.focus({ preventScroll: true });
                    onOpen(holding.ticker);
                  }}
                >
                  <th scope="row" className="sticky-col">
                    <button
                      type="button"
                      className="ticker-button"
                      aria-haspopup="dialog"
                      onClick={event => {
                        event.stopPropagation();
                        onOpen(holding.ticker);
                      }}
                    >
                      {holding.ticker}
                      {holding.warnings.length > 0 && (
                        <>
                          <span className="ticker-button__warn" aria-hidden="true">
                            *
                          </span>
                          <span className="sr-only"> (has data warnings)</span>
                        </>
                      )}
                    </button>
                  </th>
                  <td className="col-name" title={holding.name}>
                    <span className="truncate">{holding.name}</span>
                  </td>
                  <td className="nowrap">{holding.exchange}</td>
                  <td className="mono">{holding.currency}</td>
                  <td className="num">{quantity(holding.shares)}</td>
                  <td className="num nowrap" title={`Close on ${fmtDate(holding.price_date)}`}>
                    {quotePrice(holding.price, holding.currency, holding.currency_scale)}
                  </td>
                  <td
                    className="num"
                    title={sameCurrency ? `Quoted in ${base}` : `1 ${holding.currency_iso} = ${num(holding.fx_rate, 6)} ${base} on ${fmtDate(holding.fx_date)}`}
                  >
                    {sameCurrency ? <span className="faint">{fxRate(1)}</span> : fxRate(holding.fx_rate)}
                  </td>
                  <td className="num">{amount(holding.market_value, base)}</td>
                  <td className="num">
                    <span className="weight-cell">
                      {percent(holding.weight, 1)}
                      <WeightMeter weight={holding.weight} max={maxWeight} />
                    </span>
                  </td>
                  <td className="num" title={holding.session ? `Close on ${fmtDate(holding.session.date)} against ${fmtDate(holding.session.previous_date)}` : 'No completed session'}>
                    <Delta value={holding.session?.return_local} />
                  </td>
                  <td className="num">
                    <Delta value={holding.period_returns.m1} />
                  </td>
                  <td className="num">
                    <Delta value={holding.period_returns.y1} />
                  </td>
                  <td className="num">{percent(holding.annual_volatility, 1)}</td>
                  <td className="num" title={isNum(holding.risk_contribution) && holding.risk_contribution < 0 ? 'This holding reduced portfolio variance over the period' : undefined}>
                    {percent(holding.risk_contribution, 1)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="sticky-col">
                Total
              </th>
              <td colSpan={6} className="faint">
                {plural(analysis.holdings.length, 'holding')}
              </td>
              <td className="num">{amount(analysis.total_value, base)}</td>
              <td className="num">{percent(weightSum, 1)}</td>
              <td className="num" title={`Portfolio return in ${base}; covers ${percent(analysis.session.covered_weight, 0)} of value`}>
                <Delta value={analysis.session.return_base} />
              </td>
              <td className="num" />
              <td className="num" />
              <td className="num" title="Portfolio annualized volatility">
                {percent(analysis.risk.annual_volatility, 1)}
              </td>
              <td className="num">{percent(riskSum, 1)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {(flagged || minorUnits.length > 0) && (
        <p className="panel__foot faint">
          {flagged && 'An asterisk marks a holding with data warnings; select it for details. '}
          {minorUnits.length > 0 && `${minorUnits.join('; ')}. Last close is shown as quoted; FX and value use the ISO currency.`}
        </p>
      )}
    </Panel>
  );
}

// ---- Drawer --------------------------------------------------------------------------------

const HISTORY_RANGES: HistoryRange[] = ['1y', '5y', '10y', 'max'];
const FX_METHOD: Record<'direct' | 'inverse' | 'triangulated', string> = { direct: 'direct quote', inverse: 'inverted quote', triangulated: 'cross rate' };
const historyCache = new Map<string, AssetHistory>();

interface HistoryState {
  key: string;
  status: 'loading' | 'ready' | 'error';
  data: AssetHistory | null;
  error: string | null;
}

function useAssetHistory(ticker: string, range: HistoryRange, attempt: number): HistoryState {
  const key = `${ticker}|${range}`;
  const [state, setState] = useState<HistoryState>(() => {
    const cached = historyCache.get(key);
    return cached ? { key, status: 'ready', data: cached, error: null } : { key, status: 'loading', data: null, error: null };
  });
  useEffect(() => {
    const cached = historyCache.get(key);
    if (cached) {
      setState({ key, status: 'ready', data: cached, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ key, status: 'loading', data: null, error: null });
    api
      .history(ticker, range, controller.signal)
      .then(data => {
        historyCache.set(key, data);
        setState({ key, status: 'ready', data, error: null });
      })
      .catch(error => {
        if (isAbort(error)) return;
        setState({ key, status: 'error', data: null, error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [key, ticker, range, attempt]);
  return state.key === key ? state : { key, status: 'loading', data: null, error: null };
}

function HoldingDrawer({ analysis, holding, onClose }: { analysis: Analysis; holding: ValuedHolding; onClose: () => void }) {
  const [range, setRange] = useSticky<HistoryRange>('drawer-range', () => '1y');
  const [attempt, setAttempt] = useState(0);
  const history = useAssetHistory(holding.ticker, range, attempt);
  const news = useAppliedNews();
  const now = useNow(60_000);
  const base = analysis.portfolio.base_currency;
  const titleId = 'holding-drawer-title';
  const items = news?.data ? newsForTicker(news.data, holding.ticker) : [];
  const fx = analysis.fx.find(entry => entry.currency === holding.currency_iso);

  return (
    <Drawer open onClose={onClose} labelledBy={titleId}>
      <header className="drawer__head">
        <div className="drawer__titles">
          <p className="drawer__ticker">{holding.ticker}</p>
          <h2 className="drawer__title" id={titleId}>
            {holding.name}
          </h2>
          <p className="drawer__meta">
            {holding.exchange}, quoted in {holding.currency}, {percent(holding.weight, 1)} of the portfolio
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="drawer__body">
        <section className="drawer__section" aria-labelledby="drawer-history">
          <div className="drawer__section-head">
            <h3 id="drawer-history" className="section-title">
              Price history
            </h3>
            <Segmented<HistoryRange> label="History range" value={range} onChange={setRange} options={HISTORY_RANGES.map(value => ({ value, label: rangeLabel(value) }))} />
          </div>
          {history.status === 'loading' && (
            <div className="chart-placeholder" aria-live="polite">
              <Spinner /> Loading daily closes…
            </div>
          )}
          {history.status === 'error' && (
            <Notice
              tone="error"
              title="Price history could not be loaded"
              actions={
                <button type="button" className="button" onClick={() => setAttempt(value => value + 1)}>
                  <RotateCcw size={14} aria-hidden="true" />
                  Try again
                </button>
              }
            >
              {history.error}
            </Notice>
          )}
          {history.status === 'ready' && history.data && (
            <>
              <PriceChart history={history.data} />
              <p className="drawer__note faint">
                Daily closes in {history.data.currency}.
                {history.data.dividends.length > 0 && ` ${plural(history.data.dividends.length, 'dividend')} marked below the axis.`}
                {history.data.splits.length > 0 && ` ${plural(history.data.splits.length, 'split')} marked.`}
                {` Source: Yahoo Finance, fetched ${relative(history.data.fetched_at, now)}.`}
              </p>
              {history.data.warnings.length > 0 && (
                <ul className="warning-list" role="list">
                  {history.data.warnings.map(warning => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="drawer__section" aria-labelledby="drawer-position">
          <h3 id="drawer-position" className="section-title">
            Position
          </h3>
          <KeyValue
            items={[
              { label: 'Shares', value: quantity(holding.shares) },
              { label: 'Last close', value: `${quotePrice(holding.price, holding.currency, holding.currency_scale)} on ${fmtDate(holding.price_date)}` },
              {
                label: `Value in ${base}`,
                value: `${amount(holding.market_value, base)} ${base}`,
              },
              {
                label: 'FX rate',
                value:
                  holding.currency_iso === base
                    ? `Not needed (quoted in ${base})`
                    : `1 ${holding.currency_iso} = ${fxRate(holding.fx_rate)} ${base} on ${fmtDate(holding.fx_date)}${fx ? ` (${FX_METHOD[fx.method]})` : ''}`,
              },
              { label: 'Latest session', value: <SessionFacts holding={holding} base={base} /> },
              { label: '1-month return (local)', value: <Delta value={holding.period_returns.m1} /> },
              { label: '1-year return (local)', value: <Delta value={holding.period_returns.y1} /> },
              { label: 'Annual volatility', value: percent(holding.annual_volatility, 1) },
              { label: `Beta to ${analysis.benchmark.ticker}`, value: num(holding.beta, 2) },
              {
                label: 'Risk share',
                value: isNum(holding.risk_contribution) ? `${percent(holding.risk_contribution, 1)}${holding.risk_contribution < 0 ? ' (reduced portfolio risk)' : ''}` : DASH,
              },
            ]}
          />
        </section>

        <section className="drawer__section" aria-labelledby="drawer-facts">
          <h3 id="drawer-facts" className="section-title">
            Key facts
          </h3>
          <KeyValue
            items={[
              { label: 'Exchange', value: holding.exchange },
              { label: 'Exchange time zone', value: holding.exchange_timezone || DASH },
              { label: 'Quote currency', value: quoteUnitLabel(holding.currency, holding.currency_iso, holding.currency_scale) },
              { label: 'Instrument', value: holding.instrument === 'MUTUALFUND' ? 'Mutual fund' : holding.instrument === 'ETF' ? 'ETF' : 'Equity' },
              { label: 'Sector', value: holding.sector ? canonicalSector(holding.sector) : holding.instrument === 'EQUITY' ? 'Unknown' : 'Fund (not looked through)' },
              { label: 'Price date', value: fmtDate(holding.price_date) },
              { label: 'Source', value: holding.source },
              { label: 'Fetched', value: fmtTimestamp(holding.fetched_at) },
            ]}
          />
          {holding.warnings.length > 0 && (
            <Notice tone="warn" title="Data warnings">
              <ul className="plain-list" role="list">
                {holding.warnings.map(warning => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Notice>
          )}
        </section>

        <section className="drawer__section" aria-labelledby="drawer-news">
          <h3 id="drawer-news" className="section-title">
            News on {holding.ticker}
          </h3>
          {(!news || news.status === 'loading') && (
            <p className="loading-line">
              <Spinner /> Collecting headlines…
            </p>
          )}
          {news?.status === 'error' && (
            <Notice tone="error" title="Headlines could not be loaded">
              {news.error}
            </Notice>
          )}
          {news?.status === 'ready' &&
            (items.length ? (
              <NewsList items={items} now={now} label={`Headlines that mention ${holding.ticker}`} />
            ) : (
              <p className="faint">No recent headlines were found for {holding.ticker}.</p>
            ))}
        </section>
      </div>
    </Drawer>
  );
}

function SessionFacts({ holding, base }: { holding: ValuedHolding; base: string }) {
  const session = holding.session;
  if (!session) return <span className="faint">No completed session</span>;
  return (
    <span className="session-facts">
      <span>
        <Delta value={session.return_local} /> local
      </span>
      <span>
        <Delta value={session.return_base} /> in {base}
      </span>
      <span>
        <Delta kind="money" value={session.change_base} currency={base} /> {base}
      </span>
      <span className="faint">
        {shortDate(session.date)} close against {shortDate(session.previous_date)}
      </span>
    </span>
  );
}
