import type { NewsItem } from '../types';
import { safeHttpUrl } from '../lib/api';
import { fmtTimestamp, percent, relative } from '../lib/format';
import { TickerChip, cx } from './ui';

export interface HeldTicker {
  ticker: string;
  weight: number;
}

/** One headline: title linked to the original publisher (http(s) only), then publisher, time and the holdings it mentions. */
export function NewsEntry({ item, held, now, compact }: { item: NewsItem; held?: HeldTicker[]; now: number; compact?: boolean }) {
  const href = safeHttpUrl(item.url);
  return (
    <li className={cx('news__item', compact && 'news__item--compact')}>
      {href ? (
        <a className="news__title" href={href} target="_blank" rel="noopener noreferrer">
          {item.title.trim()}
          <span className="sr-only"> (opens the publisher’s site in a new tab)</span>
        </a>
      ) : (
        <span className="news__title">{item.title}</span>
      )}
      <p className="news__meta">
        <span className="news__publisher">{item.publisher || 'Publisher not given'}</span>
        {', '}
        <time dateTime={item.published_at} title={fmtTimestamp(item.published_at)}>
          {relative(item.published_at, now)}
        </time>
      </p>
      {held && held.length > 0 && (
        <p className="news__chips">
          <span className="news__held">Held:</span>
          {held.map(entry => (
            <TickerChip key={entry.ticker} ticker={entry.ticker} detail={percent(entry.weight, 1)} title={`${entry.ticker} is ${percent(entry.weight, 1)} of the portfolio`} />
          ))}
        </p>
      )}
    </li>
  );
}

export function NewsList({ items, heldFor, now, compact, label }: { items: NewsItem[]; heldFor?: (item: NewsItem) => HeldTicker[]; now: number; compact?: boolean; label: string }) {
  return (
    <ul className="news" role="list" aria-label={label}>
      {items.map(item => (
        <NewsEntry key={item.id} item={item} held={heldFor?.(item)} now={now} compact={compact} />
      ))}
    </ul>
  );
}
