import { useMemo, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import type { Analysis } from '../types';
import { useAppliedNews, useLens } from '../state/store';
import { useNow } from '../lib/hooks';
import { amount, dateRange, fmtDate, fmtTime, fmtWhen, num, parseDate, percent, plural, relative, sameDay, sentence, shortDate, signedPercent } from '../lib/format';
import { boardCloseDate, boardHasContent, boardHasMoves, heldTickersByItem, orderSectors, previewNews, sectorExposures } from '../lib/derive';
import { AnalysisStatus, NoAnalysis, PageHeader } from '../components/page';
import { Delta, FigureTable, Notice, Panel, ScrollRegion, Spinner, cx, type FigureRow } from '../components/ui';
import { Sparkline } from '../components/charts/Sparkline';
import { DivergingBars } from '../components/Bars';
import { NewsList } from '../components/News';

const SPARK_POINTS = 90;

function newsDateline(at: string | null, refreshing: boolean, today: Date): string {
  const parsed = parseDate(at);
  if (!parsed) return refreshing ? 'News being collected' : 'News not collected yet';
  return sameDay(parsed, today) ? `News updated ${fmtTime(parsed)}` : `News ${shortDate(at, today)}`;
}

export function BriefingPage() {
  const { applied, board, draft } = useLens();
  const now = useNow(60_000);
  const analysis = applied?.analysis ?? null;
  const today = new Date(now);
  const priceDate = analysis ? (analysis.session.latest_date ?? analysis.coverage.end_date) : null;
  const newsAt = board.status?.refreshed_at ?? board.data?.refreshed_at ?? null;
  const name = analysis?.portfolio.name ?? draft.portfolio.name;

  return (
    <div className="page briefing">
      <PageHeader
        title="Briefing"
        dateline={[
          name,
          priceDate ? `Prices to ${shortDate(priceDate, today)}` : 'Not yet analyzed',
          newsDateline(newsAt, board.refreshing, today),
        ]}
        example={applied?.hypothetical}
      />
      <AnalysisStatus />
      {analysis ? <KeyFigures analysis={analysis} /> : <NoAnalysis what="Key figures" />}
      <div className="grid band">
        {analysis && <LargestMoves analysis={analysis} />}
        {analysis && <HoldingsNewsPanel analysis={analysis} now={now} />}
        <SectorPerformance analysis={analysis} wide={!analysis} />
      </div>
      <SectorNews analysis={analysis} now={now} />
    </div>
  );
}

// ---- Key figures -----------------------------------------------------------------------

function KeyFigures({ analysis }: { analysis: Analysis }) {
  const base = analysis.portfolio.base_currency;
  const session = analysis.session;
  const coverage = analysis.coverage;
  const risk = analysis.risk;
  const benchmark = analysis.benchmark.ticker;
  const recent = analysis.series.slice(-SPARK_POINTS);
  const unit = coverage.frequency === 'weekly' ? 'week' : 'session';
  const trend = recent.length > 1 ? recent[recent.length - 1].portfolio / recent[0].portfolio - 1 : null;
  const currencies = analysis.concentration.currency_exposures.length;
  const holdings = `${plural(analysis.concentration.positions, 'holding')} in ${plural(currencies, 'currency', 'currencies')}`;
  const covered = `covers ${percent(session.covered_weight, 0)} of value`;

  const valueRows: FigureRow[] = [
    {
      label: 'Total value',
      detail: coverage.priced_weight < 0.9995 ? `${holdings}; ${percent(coverage.priced_weight, 0)} of value priced` : holdings,
      value: `${amount(analysis.total_value, base)} ${base}`,
      headline: true,
    },
    {
      label: 'Change, last session',
      detail: session.latest_date ? `${fmtDate(session.latest_date)}; ${covered}` : covered,
      value: (
        <>
          <Delta kind="money" value={session.change_base} currency={base} /> (<Delta value={session.return_base} />)
        </>
      ),
    },
    {
      label: `Last ${plural(recent.length, unit)}`,
      detail: recent.length > 1 ? dateRange(recent[0].date, recent[recent.length - 1].date) : undefined,
      value: (
        <div className="figure-trend">
          <div className="figure-trend__spark">
            <Sparkline
              values={recent.map(point => point.portfolio)}
              height={22}
              title="Portfolio value index"
              description={`Portfolio value index over the last ${recent.length} ${unit}s; ${trend === null ? 'no change is available' : `the change was ${signedPercent(trend, 1)}`}.`}
            />
          </div>
          <Delta value={trend} />
        </div>
      ),
    },
  ];
  const riskRows: FigureRow[] = [
    {
      label: 'Return over the period',
      detail: (
        <>
          <span className="mono">{benchmark}</span> {signedPercent(risk.benchmark_return, 1)}
        </>
      ),
      value: <Delta value={risk.historical_return} digits={1} />,
    },
    { label: 'Annual volatility', value: percent(risk.annual_volatility, 1) },
    {
      label: (
        <>
          Beta to <span className="mono">{benchmark}</span>
        </>
      ),
      detail: analysis.benchmark.name,
      value: num(risk.beta, 2),
    },
    { label: 'Maximum drawdown', value: percent(risk.max_drawdown, 1) },
  ];

  return (
    <Panel
      className="key-figures"
      title="Key figures"
      meta={`Values in ${base}. Return and risk use ${coverage.frequency} returns, ${dateRange(coverage.start_date, coverage.end_date)}.`}
      source="Yahoo Finance daily closes, dividends and exchange rates; LENS calculations."
    >
      <div className="key-figures__tables">
        <FigureTable rows={valueRows} caption={`Portfolio value and recent change, in ${base}`} />
        <FigureTable rows={riskRows} caption="Return and risk over the analysis period" />
      </div>
    </Panel>
  );
}

// ---- Largest moves -------------------------------------------------------------------------

function LargestMoves({ analysis }: { analysis: Analysis }) {
  const [all, setAll] = useState(false);
  const base = analysis.portfolio.base_currency;
  const sorted = useMemo(
    () =>
      [...analysis.holdings].sort((a, b) => {
        const left = a.session?.change_base;
        const right = b.session?.change_base;
        if (left == null && right == null) return a.ticker.localeCompare(b.ticker);
        if (left == null) return 1;
        if (right == null) return -1;
        return right - left;
      }),
    [analysis.holdings],
  );
  const limited = sorted.length > 10 && !all;
  const withValue = sorted.filter(holding => holding.session?.change_base != null);
  const missing = sorted.filter(holding => holding.session?.change_base == null);
  const shown = limited ? [...withValue.slice(0, 5), ...withValue.slice(-5).filter(holding => !withValue.slice(0, 5).includes(holding))] : [...withValue, ...missing];

  return (
    <Panel
      className="col-4 movers"
      title="Largest moves, last session"
      meta={`Change in value of each holding over its latest completed session, in ${base}`}
      source="Yahoo Finance daily closes and exchange rates; LENS calculations."
      actions={
        sorted.length > 10 ? (
          <button type="button" className="button button--quiet button--small" onClick={() => setAll(value => !value)} aria-expanded={all}>
            {all ? 'Show top and bottom 5' : `Show all ${sorted.length}`}
          </button>
        ) : undefined
      }
    >
      {withValue.length === 0 && <p className="faint">No holding has a completed session with a same-date exchange rate yet.</p>}
      <DivergingBars
        label={`Holdings by change in value over the latest session, in ${base}`}
        data={shown.map(holding => ({
          key: holding.ticker,
          label: <span className="mono">{holding.ticker}</span>,
          value: holding.session?.change_base ?? null,
          title: holding.session
            ? `${holding.name}: close on ${fmtDate(holding.session.date)} against ${fmtDate(holding.session.previous_date)}`
            : `${holding.name}: no completed session`,
          display: (
            <span className="dbars__figure">
              <Delta kind="money" value={holding.session?.change_base} currency={base} />
              <span className="dbars__sub">
                <Delta value={holding.session?.return_base ?? holding.session?.return_local} />
              </span>
            </span>
          ),
        }))}
      />
      {limited && <p className="panel__foot faint">The five largest gains and five largest losses of {sorted.length} holdings.</p>}
      {missing.length > 0 && !limited && (
        <p className="panel__foot faint">
          {plural(missing.length, 'holding')} without a completed session or a same-date exchange rate {missing.length === 1 ? 'is' : 'are'} listed last.
        </p>
      )}
    </Panel>
  );
}

// ---- Holdings news -----------------------------------------------------------------------

const NEWS_PREVIEW = 4;

function HoldingsNewsPanel({ analysis, now }: { analysis: Analysis; now: number }) {
  const news = useAppliedNews();
  const [all, setAll] = useState(false);
  const held = useMemo(() => (news?.data ? heldTickersByItem(news.data, analysis.holdings) : null), [news, analysis.holdings]);
  const items = news?.data?.items ?? [];
  const preview = useMemo(() => previewNews(items, held, NEWS_PREVIEW), [items, held]);
  const shown = all ? items : preview;

  return (
    <Panel
      className="col-4 headlines"
      title="News on your holdings"
      meta={news?.data ? `Recent headlines that mention your holdings; updated ${relative(news.data.refreshed_at, now)}` : 'Recent headlines that mention your holdings'}
      source="Yahoo Finance news search for each holding."
      actions={
        items.length > NEWS_PREVIEW ? (
          <button type="button" className="button button--quiet button--small" onClick={() => setAll(value => !value)} aria-expanded={all}>
            {all ? 'Show fewer' : `Show all ${items.length}`}
          </button>
        ) : undefined
      }
    >
      {(!news || news.status === 'loading') && (
        <p className="loading-line">
          <Spinner /> Collecting headlines for {plural(analysis.holdings.length, 'holding')}…
        </p>
      )}
      {news?.status === 'error' && (
        <Notice tone="error" title="Headlines could not be loaded">
          {news.error}
        </Notice>
      )}
      {news?.status === 'ready' && news.data && (
        <>
          {items.length === 0 ? (
            <p className="faint">No recent headlines were found for these holdings.</p>
          ) : (
            <NewsList items={shown} now={now} label="Headlines that mention your holdings" heldFor={item => held?.get(item.id) ?? []} />
          )}
          {news.data.warnings.length > 0 && (
            <details className="panel__details" open={news.data.warnings.some(warning => /could not/i.test(warning))}>
              <summary>Notes on these headlines ({news.data.warnings.length})</summary>
              <ul className="panel__notes" role="list">
                {news.data.warnings.map(warning => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="panel__foot faint">Headlines link to the publisher’s site.</p>
        </>
      )}
    </Panel>
  );
}

// ---- Sector performance ------------------------------------------------------------------

function SectorPerformance({ analysis, wide }: { analysis: Analysis | null; wide: boolean }) {
  const { board } = useLens();
  const exposures = useMemo(() => sectorExposures(analysis), [analysis]);
  const sectors = boardHasMoves(board.data) ? (board.data?.sectors ?? []) : [];
  const closeDate = boardCloseDate(board.data);
  const unmapped = [...exposures].filter(([name, weight]) => weight > 0 && !sectors.some(sector => sector.name === name));

  return (
    <Panel
      className={wide ? 'col-12' : 'col-4 col-wide-md'}
      title="Sector performance"
      meta={`Sector ETF returns${closeDate ? ` to the ${shortDate(closeDate)} close` : ''}; US Select Sector SPDR and iShares Global sector funds as proxies`}
      source="Yahoo Finance daily closes of the sector ETFs; LENS calculations."
    >
      {board.loading && !board.data && (
        <p className="loading-line">
          <Spinner /> Loading sector returns…
        </p>
      )}
      {board.loadError && !board.data && (
        <Notice tone="error" title="Sector returns could not be loaded">
          {board.loadError}
        </Notice>
      )}
      {board.data && sectors.length === 0 &&
        (board.refreshing ? (
          <p className="loading-line">
            <Spinner /> Collecting sector ETF prices. The first collection after LENS starts takes about a minute.
          </p>
        ) : (
          <p className="faint">Sector returns have not been collected yet. Use Refresh under Sector news to collect them.</p>
        ))}
      {sectors.length > 0 && (
        <ScrollRegion label="Sector performance table">
          <table className="ledger ledger--compact pulse">
            <caption className="sr-only">Sector returns for the latest completed session and the last month, with the portfolio’s weight in each sector.</caption>
            <thead>
              <tr>
                <th scope="col">Sector</th>
                {analysis && (
                  <th scope="col" className="num">
                    Weight
                  </th>
                )}
                <th scope="col" className="num">
                  US 1D
                </th>
                <th scope="col" className="num pulse__global">
                  Global 1D
                </th>
                <th scope="col" className="num">
                  1M
                </th>
              </tr>
            </thead>
            <tbody>
              {sectors.map(sector => {
                const exposure = exposures.get(sector.name) ?? 0;
                const held = exposure > 0;
                const month = sector.us ?? sector.global;
                return (
                  <tr key={sector.id} className={cx(held && 'is-held')}>
                    <th scope="row" className="pulse__name">
                      {sector.name}
                      {held && <span className="sr-only"> (held)</span>}
                    </th>
                    {analysis && <td className="num">{held ? percent(exposure, 1) : <span className="sr-only">Not held</span>}</td>}
                    <td className="num" title={sector.us ? `${sector.us.proxy_name} (${sector.us.proxy})` : 'No US proxy data'}>
                      <Delta value={sector.us?.d1} />
                    </td>
                    <td className="num pulse__global" title={sector.global ? `${sector.global.proxy_name} (${sector.global.proxy})` : 'No global proxy data'}>
                      <Delta value={sector.global?.d1} />
                    </td>
                    <td className="num" title={month ? `${month.proxy}: one-month return` : undefined}>
                      <Delta value={month?.m1} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      {sectors.length > 0 && (
        <p className="panel__foot faint">
          {analysis ? 'Sectors in bold are held in the portfolio. ' : ''}1M uses the US proxy where available.
          {unmapped.length > 0 && ` Not mapped to a sector: ${unmapped.map(([name, weight]) => `${name} ${percent(weight, 1)}`).join(', ')}.`}
        </p>
      )}
    </Panel>
  );
}

// ---- Sector news -------------------------------------------------------------------------

function SectorNews({ analysis, now }: { analysis: Analysis | null; now: number }) {
  const { board, refreshNews, reloadBoard, config } = useLens();
  const exposures = useMemo(() => sectorExposures(analysis), [analysis]);
  const ordered = useMemo(() => orderSectors(board.data, exposures), [board.data, exposures]);
  const status = board.status;
  const refreshedAt = status?.refreshed_at ?? board.data?.refreshed_at ?? null;
  const nextAt = status?.next_refresh_at ?? board.data?.next_refresh_at ?? null;
  const lastError = status?.last_error ?? board.data?.last_error ?? null;
  const refreshing = board.refreshing;
  const collected = boardHasContent(board.data);

  const meta = refreshedAt
    ? `Updated ${fmtWhen(refreshedAt)} (${relative(refreshedAt, now)}).${nextAt ? ` Refreshed automatically about every ${plural(config?.news_refresh_hours ?? 6, 'hour')}; next at ${fmtWhen(nextAt)}.` : ''}`
    : refreshing
      ? 'The first collection is in progress.'
      : 'Not collected yet.';

  return (
    <Panel
      id="sector-news"
      className="desk-panel"
      title="Sector news"
      meta={meta}
      source="Yahoo Finance news search by sector and daily closes of the sector ETFs."
      actions={
        <button type="button" className="button" onClick={refreshNews} disabled={refreshing || (board.loading && !board.data)}>
          <RefreshCw size={14} aria-hidden="true" className={cx(refreshing && 'spin')} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      {/* Progress and results are announced once through the app-wide live region. */}
      <div className="desk__status">
        {refreshing && (
          <p className="loading-line">
            <Spinner /> Collecting sector headlines and ETF prices. This can take a minute; the rest of the page can be used meanwhile.
          </p>
        )}
        {board.note && <p className="faint">{board.note}</p>}
        {board.refreshError && (
          <Notice tone="error" title="The refresh could not be started" live>
            {board.refreshError}
          </Notice>
        )}
      </div>
      {board.loading && !board.data && (
        <p className="loading-line">
          <Spinner /> Loading sector news…
        </p>
      )}
      {board.loadError && !board.data && (
        <Notice
          tone="error"
          title="Sector news could not be loaded"
          actions={
            <button type="button" className="button" onClick={reloadBoard}>
              <RotateCcw size={14} aria-hidden="true" />
              Try again
            </button>
          }
        >
          {board.loadError}
        </Notice>
      )}
      {lastError && board.data && (
        <Notice tone="warn" title="The last news refresh was incomplete">
          {lastError}
          {refreshedAt ? ` ${sentence(`Headlines below are from ${fmtWhen(refreshedAt)}`)}` : ''}
        </Notice>
      )}
      {board.data && !collected && !refreshing && <p className="faint">Sector news has not been collected yet. Use Refresh to collect it.</p>}
      {collected && (
        <div className="desk">
          {ordered.all.map(sector => {
            const exposure = exposures.get(sector.name) ?? 0;
            const held = exposure > 0;
            return (
              <article key={sector.id} className={cx('desk__sector', held && 'is-held')} aria-labelledby={`desk-${sector.id}`}>
                <header className="desk__head">
                  <h3 className="desk__name" id={`desk-${sector.id}`}>
                    {sector.name}
                  </h3>
                  {held && <span className="desk__held">Held, {percent(exposure, 1)}</span>}
                </header>
                <p className="desk__moves">
                  {[sector.us, sector.global].map((move, index) =>
                    move ? (
                      <span key={move.proxy} className="desk__move" title={`${move.proxy_name}${move.as_of ? `, close ${fmtDate(move.as_of)}` : ''}`}>
                        <span className="desk__proxy">{move.proxy}</span>
                        <Delta value={move.d1} />
                      </span>
                    ) : (
                      <span key={index} className="desk__move faint">
                        No {index === 0 ? 'US' : 'global'} proxy price
                      </span>
                    ),
                  )}
                </p>
                {sector.headlines.length ? (
                  <NewsList items={sector.headlines.slice(0, 3)} now={now} compact label={`${sector.name} headlines`} />
                ) : (
                  <p className="desk__empty">{refreshing ? 'Collecting headlines…' : 'No headlines collected for this sector yet.'}</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
