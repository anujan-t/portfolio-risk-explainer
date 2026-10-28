import type { CSSProperties, ReactNode } from 'react';
import { useLens } from '../state/store';
import { useElementSize, useReducedMotion } from '../lib/hooks';
import { fmtDate, percent } from '../lib/format';
import { boardHasMoves, shortSector } from '../lib/derive';
import { Delta, cx } from './ui';

const SPEED = 36; // pixels per second

export function TickerTape() {
  const { applied, pending, board } = useLens();
  const reduced = useReducedMotion();
  const [viewportRef, viewport] = useElementSize<HTMLDivElement>();
  const [copyRef, copy] = useElementSize<HTMLDivElement>();

  const holdings = applied?.analysis.holdings ?? [];
  // Before the first collection the board lists every sector without data; leave them off the tape until then.
  const sectors = boardHasMoves(board.data) ? (board.data?.sectors ?? []) : [];

  const pieces: ReactNode[] = [];
  if (holdings.length) {
    pieces.push(
      <span className="tape__group" key="holdings-label" title="Latest completed session per holding, in its quote currency">
        Holdings · local currency
      </span>,
    );
    for (const holding of holdings) {
      const session = holding.session;
      pieces.push(
        <span
          className="tape__item"
          key={`h-${holding.ticker}`}
          title={session ? `${holding.name}: ${percent(session.return_local, 2, true)} in ${holding.currency} on ${fmtDate(session.date, 'medium')}` : `${holding.name}: no completed session`}
        >
          <span className="tape__sym">{holding.ticker}</span>
          <Delta value={session?.return_local} />
        </span>,
      );
    }
  }
  if (sectors.length) {
    pieces.push(
      <span className="tape__group" key="sector-label">
        Sector proxies
      </span>,
    );
    for (const sector of sectors) {
      const move = sector.us ?? sector.global;
      pieces.push(
        <span
          className="tape__item"
          key={`s-${sector.id}`}
          title={move ? `${sector.name} — ${move.proxy_name} (${move.proxy})${move.as_of ? `, close ${fmtDate(move.as_of, 'medium')}` : ''}` : `${sector.name}: no proxy data`}
        >
          <span className="tape__sym">{move?.proxy ?? '—'}</span>
          <span className="tape__name">{shortSector(sector.name)}</span>
          <Delta value={move?.d1} />
        </span>,
      );
    }
  }

  if (!pieces.length) {
    const message = pending
      ? 'Waiting for the first analysis…'
      : board.loading
        ? 'Loading market tape…'
        : board.refreshing
          ? 'Collecting sector proxy prices…'
          : 'The market tape fills in after an analysis and once sector data is available.';
    return (
      <div className="tape tape--empty" role="region" aria-label="Market tape">
        <div className="tape__viewport">
          <span className="tape__note">{message}</span>
        </div>
      </div>
    );
  }

  const fits = copy.width > 0 && viewport.width > 0 && copy.width <= viewport.width;
  const moving = !reduced && copy.width > 0 && !fits;
  const copies = moving ? Math.max(2, Math.ceil(viewport.width / copy.width) + 1) : 1;
  const style = { '--tape-shift': `${copy.width}px`, '--tape-duration': `${Math.max(20, copy.width / SPEED)}s` } as CSSProperties;

  return (
    <div
      className={cx('tape', moving && 'tape--moving', reduced && 'tape--static')}
      role="region"
      aria-label="Market tape: latest-session moves for holdings and sector proxies"
      tabIndex={0}
    >
      <div className="tape__viewport" ref={viewportRef}>
        <div className="tape__track" style={style}>
          <div className="tape__copy" ref={copyRef}>
            {pieces}
          </div>
          {Array.from({ length: copies - 1 }, (_, index) => (
            <div className="tape__copy" aria-hidden="true" key={index}>
              {pieces}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
