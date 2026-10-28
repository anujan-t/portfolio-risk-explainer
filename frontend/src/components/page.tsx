import type { ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { useLens } from '../state/store';
import { navigate, useElapsedSeconds, useSticky } from '../lib/hooks';
import { frequencyLabel, rangeLabel } from '../lib/format';
import { EmptyState, Notice, Spinner } from './ui';

export function PageHeader({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head__text">
        <h1 className="page-head__title" tabIndex={-1}>
          {title}
        </h1>
        {meta && <div className="page-head__meta">{meta}</div>}
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
          <span className="mono">{request.benchmark}</span> · {rangeLabel(request.range)} · {frequencyLabel(request.frequency)}.
          <span className="status-bar__time" aria-hidden="true">
            {' '}
            {elapsed} s
          </span>
          <span className="status-bar__hint">
            {elapsed >= 8 ? ' Fetching prices and FX for the first time can take up to a minute.' : ''}
            {applied ? ' The results below are from the previous analysis until this finishes.' : ''}
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
        title="The analysis could not be completed"
        onDismiss={() => setDismissed(failure.id)}
        actions={
          <button type="button" className="button" onClick={retryAnalysis}>
            <RotateCcw size={14} aria-hidden="true" />
            Try again
          </button>
        }
      >
        <p>{failure.message}</p>
        {applied && <p className="faint">The results below are still from the previous analysis of “{applied.request.portfolio.name}”.</p>}
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
          Prices, dividends and exchange rates are fetched from public market data on first use. This usually takes 20–60 seconds; later analyses are
          faster. <span aria-hidden="true">{elapsed} s elapsed.</span>
        </p>
      </div>
    );
  }
  return (
    <EmptyState
      title={failure ? 'No results to show' : `${what} appear after an analysis`}
      action={
        <div className="row">
          <button type="button" className="button button--primary" onClick={() => navigate('import', 'manual')}>
            Build or open a portfolio
          </button>
          <button type="button" className="button" onClick={() => navigate('import', 'screenshot')}>
            Import a screenshot
          </button>
        </div>
      }
    >
      <p>Open a saved portfolio from the switcher at the top, or build one in Import, then apply the analysis on the Risk page.</p>
    </EmptyState>
  );
}
