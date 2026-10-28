import { useMemo, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import type { Analysis } from '../types';
import { useAppliedNews, useLens } from '../state/store';
import { useNow } from '../lib/hooks';
import { amountParts, dateRange, fmtDate, fmtWhen, num, percent, plural, relative, sentence, shortDate } from '../lib/format';
import { boardCloseDate, boardHasContent, boardHasMoves, heldTickersByItem, orderSectors, previewNews, sectorExposures, shortSector } from '../lib/derive';
import { AnalysisStatus, NoAnalysis, PageHeader } from '../components/page';
import { Badge, Delta, ExampleBadge, Notice, Panel, ScrollRegion, Spinner, cx } from '../components/ui';
import { Sparkline } from '../components/charts/Sparkline';
import { DivergingBars } from '../components/Bars';
import { NewsList } from '../components/News';

const SPARK_POINTS = 90;

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
        meta={
          <>
            <span className="page-head__date">{fmtDate(today, 'long')}</span>
            <span className="page-head__sep" aria-hidden="true" />
            <span>{name}</span>
            <span className="page-head__sep" aria-hidden="true" />
            <span>{priceDate ? `Prices: completed closes to ${shortDate(priceDate, today)}` : 'Prices: not analyzed yet'}</span>
            <span className="page-head__sep" aria-hidden="true" />
            <span>{newsAt ? `News updated ${fmtWhen(newsAt, today)}` : board.refreshing ? 'News: collecting now' : 'News: not collected yet'}</span>
          </>
        }
      >
        {applied?.hypothetical && <ExampleBadge />}
      </PageHeader>
      <AnalysisStatus />
      {analysis ? <KeyFigures analysis={analysis} /> : <NoAnalysis what="Portfolio figures" />}
      <div className="grid band">
        {analysis && <Movers analysis={analysis} />}
        {analysis && <HoldingsNewsPanel analysis={analysis} now={now} />}
        <SectorPulse analysis={analysis} wide={!analysis} />
      </div>
      <SectorDesk analysis={analysis} now={now} />
    </div>
  );
}

// ---- Key figures -----------------------------------------------------------------------

function KeyFigures({ analysis }: { analysis: Analysis }) {
  const base = analysis.portfolio.base_currency;
  const { whole, fraction } = amountParts(analysis.total_value, base);
  const session = analysis.session;
  const recent = analysis.series.slice(-SPARK_POINTS);
  const unit = analysis.coverage.frequency === 'weekly' ? 'week' : 'session';
  const sparkChange = recent.length > 1 ? recent[recent.length - 1].portfolio / recent[0].portfolio - 1 : null;
  const currencies = analysis.concentration.currency_exposures.length;
  const risk = analysis.risk;

  return (
    <section className="figures" aria-label="Key figures">
      <div className="figures__cell figures__cell--value">
        <p className="figure-label">Total value</p>
        <p className="hero-figure">
          <span className="hero-figure__whole">{whole}</span>
          <span className="hero-figure__fraction">{fraction}</span>
          <span className="hero-figure__ccy">{base}</span>
        </p>
        <p className="figure-sub">
          {plural(analysis.concentration.positions, 'holding')} · {plural(currencies, 'currency', 'currencies')}
          {analysis.coverage.priced_weight < 0.9995 ? ` · ${percent(analysis.coverage.priced_weight, 0)} priced` : ''}
        </p>
      </div>
      <div className="figures__cell">
        <p className="figure-label">Latest session{session.latest_date ? ` · ${shortDate(session.latest_date)}` : ''}</p>
        <p className="big-figure">
          <Delta kind="money" value={session.change_base} currency={base} />
          <span className="big-figure__ccy">{base}</span>
        </p>
        <p className="figure-sub">
          <Delta value={session.return_base} />
          <span className="figure-sub__note">covers {percent(session.covered_weight, 0)} of holdings by value</span>
        </p>
      </div>
      <div className="figures__cell figures__cell--spark">
        <p className="figure-label">
          Last {plural(recent.length, unit)}
          {recent.length > 1 ? ` · ${dateRange(recent[0].date, recent[recent.length - 1].date)}` : ''}
        </p>
        <Sparkline
          values={recent.map(point => point.portfolio)}
          title="Portfolio trend"
          description={`Portfolio value index over the last ${recent.length} ${unit}s, ${sparkChange === null ? 'no change available' : `a change of ${percent(sparkChange, 1, true)}`}.`}
        />
        <p className="figure-sub">
          <Delta value={sparkChange} /> <span className="figure-sub__note">over this stretch, in {base}</span>
        </p>
      </div>
      <dl className="figures__list">
        <div className="figures__item">
          <dt>Annual volatility</dt>
          <dd>{percent(risk.annual_volatility, 1)}</dd>
        </div>
        <div className="figures__item">
          <dt>
            Beta vs <span className="mono">{analysis.benchmark.ticker}</span>
          </dt>
          <dd>{num(risk.beta, 2)}</dd>
        </div>
        <div className="figures__item">
          <dt>Max drawdown</dt>
          <dd>{percent(risk.max_drawdown, 1)}</dd>
        </div>
      </dl>
    </section>
  );
}

// ---- Movers ------------------------------------------------------------------------------

function Movers({ analysis }: { analysis: Analysis }) {
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
      title="Movers"
      meta={`Latest completed session per holding · value change in ${base}`}
      actions={
        sorted.length > 10 ? (
          <button type="button" className="button button--quiet button--small" onClick={() => setAll(value => !value)} aria-expanded={all}>
            {all ? 'Top and bottom 5' : `All ${sorted.length}`}
          </button>
        ) : undefined
      }
    >
      {withValue.length === 0 && <p className="faint">No holding has a completed session with same-date exchange rates yet.</p>}
      <DivergingBars
        label={`Holdings by latest-session value change in ${base}`}
        data={shown.map(holding => ({
          key: holding.ticker,
          label: <span className="mono">{holding.ticker}</span>,
          value: holding.session?.change_base ?? null,
          title: holding.session
            ? `${holding.name}: session ${fmtDate(holding.session.date)} vs ${fmtDate(holding.session.previous_date)}`
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
      {limited && <p className="panel__foot faint">Showing the five largest gains and losses of {sorted.length} holdings.</p>}
      {missing.length > 0 && !limited && (
        <p className="panel__foot faint">
          {plural(missing.length, 'holding')} without a same-date exchange rate or completed session {missing.length === 1 ? 'is' : 'are'} listed last.
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
      title="In the news"
      meta={news?.data ? `Headlines about your holdings · updated ${relative(news.data.refreshed_at, now)}` : 'Headlines about your holdings'}
      actions={
        items.length > NEWS_PREVIEW ? (
          <button type="button" className="button button--quiet button--small" onClick={() => setAll(value => !value)} aria-expanded={all}>
            {all ? 'Fewer' : `All ${items.length}`}
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
        <Notice tone="error" title="News is unavailable right now">
          {news.error}
        </Notice>
      )}
      {news?.status === 'ready' && news.data && (
        <>
          {items.length === 0 ? (
            <p className="faint">No recent headlines were found for these holdings.</p>
          ) : (
            <NewsList items={shown} now={now} label="Headlines about your holdings" heldFor={item => held?.get(item.id) ?? []} />
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
          <p className="panel__foot faint">Links open the original publisher. Source: {news.data.source}.</p>
        </>
      )}
    </Panel>
  );
}

// ---- Sector pulse ------------------------------------------------------------------------

function SectorPulse({ analysis, wide }: { analysis: Analysis | null; wide: boolean }) {
  const { board } = useLens();
  const exposures = useMemo(() => sectorExposures(analysis), [analysis]);
  const sectors = boardHasMoves(board.data) ? (board.data?.sectors ?? []) : [];
  const closeDate = boardCloseDate(board.data);
  const unmapped = [...exposures].filter(([name, weight]) => weight > 0 && !sectors.some(sector => sector.name === name));

  return (
    <Panel
      className={wide ? 'col-12' : 'col-4 col-wide-md'}
      title="Sector pulse"
      meta={`US Select Sector and iShares Global sector proxies${closeDate ? ` · closes to ${shortDate(closeDate)}` : ''}`}
    >
      {board.loading && !board.data && (
        <p className="loading-line">
          <Spinner /> Loading sector proxies…
        </p>
      )}
      {board.loadError && !board.data && (
        <Notice tone="error" title="Sector data is unavailable right now">
          {board.loadError}
        </Notice>
      )}
      {board.data && sectors.length === 0 &&
        (board.refreshing ? (
          <p className="loading-line">
            <Spinner /> Collecting sector proxy prices. The first collection after the service starts takes about a minute.
          </p>
        ) : (
          <p className="faint">No sector data has been collected yet. Use Refresh on the sector desk to collect it.</p>
        ))}
      {sectors.length > 0 && (
        <ScrollRegion label="Sector pulse table">
          <table className="ledger ledger--compact pulse">
            <caption className="sr-only">Sector moves for the latest completed session and the last month, with your portfolio’s exposure.</caption>
            <thead>
              <tr>
                <th scope="col">Sector</th>
                {analysis && (
                  <th scope="col" className="num">
                    Yours
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
                    <th scope="row" className="pulse__name" title={sector.name}>
                      <span aria-hidden="true">{shortSector(sector.name)}</span>
                      <span className="sr-only">
                        {sector.name}
                        {held ? ' (held)' : ''}
                      </span>
                    </th>
                    {analysis && <td className="num">{held ? percent(exposure, 1) : <span className="faint">—</span>}</td>}
                    <td className="num" title={sector.us ? `${sector.us.proxy_name} (${sector.us.proxy})` : 'No US proxy data'}>
                      <Delta value={sector.us?.d1} />
                    </td>
                    <td className="num pulse__global" title={sector.global ? `${sector.global.proxy_name} (${sector.global.proxy})` : 'No global proxy data'}>
                      <Delta value={sector.global?.d1} />
                    </td>
                    <td className="num" title={month ? `${month.proxy}: one-month move` : undefined}>
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
          {analysis ? <><span className="held-key" aria-hidden="true" /> Held sector · </> : null}1M uses the US proxy when available.
          {unmapped.length > 0 && ` Not mapped to a sector: ${unmapped.map(([name, weight]) => `${name} ${percent(weight, 1)}`).join(', ')}.`}
        </p>
      )}
    </Panel>
  );
}

// ---- Sector desk -------------------------------------------------------------------------

function SectorDesk({ analysis, now }: { analysis: Analysis | null; now: number }) {
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
    ? `Updated ${fmtWhen(refreshedAt)} (${relative(refreshedAt, now)})${nextAt ? ` · automatic refresh about every ${config?.news_refresh_hours ?? 6} h, next ${fmtWhen(nextAt)}` : ''}`
    : refreshing
      ? 'First collection in progress'
      : 'Not collected yet';

  return (
    <Panel
      id="sector-desk"
      className="desk-panel"
      title="Sector desk"
      meta={meta}
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
            <Spinner /> Collecting sector headlines and proxy prices. This can take a minute; the page stays usable.
          </p>
        )}
        {board.note && <Badge tone="neutral">{board.note}</Badge>}
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
          title="News is unavailable right now"
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
        <Notice tone="warn" title="The last news refresh did not complete">
          {lastError}
          {refreshedAt ? ` ${sentence(`Headlines below are from ${fmtWhen(refreshedAt)}`)}` : ''}
        </Notice>
      )}
      {board.data && !collected && !refreshing && <p className="faint">No sectors have been collected yet. Use Refresh to collect them.</p>}
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
                  {held && <span className="desk__held">Held · {percent(exposure, 1)}</span>}
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
                        {index === 0 ? 'US' : 'Global'} proxy unavailable
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
