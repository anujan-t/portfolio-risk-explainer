import { Fragment, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { useLens } from '../state/store';
import { navigate, useElapsedSeconds, useNow, useSticky } from '../lib/hooks';
import { fmtDate, frequencyLabel, rangeWords } from '../lib/format';
import { EmptyState, ExampleNote, Notice, Spinner } from './ui';

type DatelineItem = ReactNode | false | null | undefined;

/**
 * Report-style page header: serif title, one sans dateline (today's date, then the given items,
 * separated by middle dots), an optional one-sentence deck, and the example note when relevant.
 */
export function PageHeader({
  title,
  dateline = [],
  deck,
  example,
  dated = true,
  children,
}: {
  title: string;
  dateline?: DatelineItem[];
  deck?: ReactNode;
  example?: boolean;
  dated?: boolean;
  children?: ReactNode;
}) {
  const now = useNow(60_000);
  const items = [dated ? fmtDate(new Date(now), 'long') : null, ...dateline].filter(item => item !== null && item !== undefined && item !== false && item !== '');
  return (
    <header className="page-head">
      <div className="page-head__text">
        <h1 className="page-head__title" tabIndex={-1}>
          {title}
        </h1>
        {items.length > 0 && (
          <p className="page-head__dateline">
            {items.map((item, index) => (
              <Fragment key={index}>
                {index > 0 && <span className="page-head__dot"> · </span>}
                <span className="page-head__item">{item}</span>
              </Fragment>
            ))}
          </p>
        )}
        {deck && <p className="page-head__deck">{deck}</p>}
        {example && <ExampleNote />}
      </div>
      {children && <div className="page-head__aside">{children}</div>}
    </header>
  );
}

/** Pending / failed analysis state, shown above results. Results below always describe the applied request. */
export function AnalysisStatus() {
  const { pending, failure, applied, cancelAnalysis, retryAnalysis } = useLens();
  const elapsed = useElapsedSeconds(pending?.startedAt);
  const [dismissed, setDismissed] = useSticky<number>('failure-dismissed', () => 0);

  if (pending) {
    const request = pending.request;
    return (
      <div className="status-bar" role="status" aria-live="polite">
        <Spinner />
        <p className="status-bar__text">
          {pending.refresh ? 'Refreshing market data for' : 'Analyzing'} <strong>{request.portfolio.name}</strong> against{' '}
          <span className="mono">{request.benchmark}</span> over {rangeWords(request.range)} ({frequencyLabel(request.frequency).toLowerCase()} frequency).
          <span className="status-bar__time" aria-hidden="true">
            {' '}
            {elapsed} s
          </span>
          <span className="status-bar__hint">
            {elapsed >= 8 ? ' The first download of prices and exchange rates can take up to a minute.' : ''}
            {applied ? ' Results below are from the previous analysis until this one finishes.' : ''}
          </span>
        </p>
        <button type="button" className="button button--quiet" onClick={cancelAnalysis}>
          Cancel
        </button>
      </div>
    );
  }
  if (failure && (!applied || failure.id > applied.id) && failure.id !== dismissed) {
    return (
      <Notice
        tone="error"
        title="The analysis did not complete"
        onDismiss={() => setDismissed(failure.id)}
        actions={
          <button type="button" className="button" onClick={retryAnalysis}>
            <RotateCcw size={14} aria-hidden="true" />
            Try again
          </button>
        }
      >
        <p>{failure.message}</p>
        {applied && <p className="faint">Results below are from the previous analysis of “{applied.request.portfolio.name}”.</p>}
      </Notice>
    );
  }
  return null;
}

/** Shown in place of results when there is no applied analysis yet. */
export function NoAnalysis({ what }: { what: string }) {
  const { pending, failure } = useLens();
  const elapsed = useElapsedSeconds(pending?.startedAt);
  if (pending) {
    // The status bar above already announces the pending analysis; this block only explains the wait.
    return (
      <div className="waiting">
        <div className="waiting__bar" aria-hidden="true" />
        <p className="waiting__title">Preparing the first analysis of “{pending.request.portfolio.name}”</p>
        <p className="waiting__text">
          Prices, dividends and exchange rates are downloaded from Yahoo Finance on first use. This usually takes 20–60 seconds; later analyses use the
          cache and are faster. <span aria-hidden="true">{elapsed} s elapsed.</span>
        </p>
      </div>
    );
  }
  return (
    <EmptyState
      title={
        failure
          ? 'There are no results because the last analysis did not complete; open a portfolio from the portfolio menu or build one in Import.'
          : `${what} appear here after a portfolio is analyzed; open one from the portfolio menu or build one in Import.`
      }
      action={
        <button type="button" className="button" onClick={() => navigate('import', 'manual')}>
          Go to Import
        </button>
      }
    />
  );
}
