import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Search } from 'lucide-react';
import type { SearchResult } from '../types';
import { api, errorMessage, isAbort } from '../lib/api';
import { useDebouncedValue } from '../lib/hooks';
import { normalizeTicker, validTicker } from '../lib/portfolio';
import { cx } from './ui';

interface SearchState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  query: string;
  results: SearchResult[];
  error: string | null;
}

const IDLE: SearchState = { status: 'idle', query: '', results: [], error: null };

interface Option {
  key: string;
  ticker: string;
  result: SearchResult | null;
}

/** Combobox: debounced (300 ms) ticker search with stale requests aborted and full keyboard support. */
export function TickerSearch({
  onPick,
  label = 'Find a security',
  hideLabel,
  placeholder = 'Ticker or company, e.g. RY.TO or Shell',
  disabled,
  disabledReason,
  autoFocus,
  inputRef,
}: {
  onPick: (ticker: string, result: SearchResult | null) => void;
  label?: string;
  hideLabel?: boolean;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const statusId = `${id}-status`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [state, setState] = useState<SearchState>(IDLE);
  const debounced = useDebouncedValue(query.trim(), 300);
  const blurTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!debounced) {
      setState(IDLE);
      return undefined;
    }
    const controller = new AbortController();
    setState(previous => ({ ...previous, status: 'loading', query: debounced, error: null }));
    api
      .search(debounced, controller.signal)
      .then(response => {
        if (!controller.signal.aborted) setState({ status: 'ready', query: debounced, results: response.results.slice(0, 8), error: null });
      })
      .catch(error => {
        if (!isAbort(error) && !controller.signal.aborted) setState({ status: 'error', query: debounced, results: [], error: errorMessage(error) });
      });
    return () => controller.abort();
  }, [debounced]);

  useEffect(() => () => window.clearTimeout(blurTimer.current), []);

  const typed = normalizeTicker(query);
  const options = useMemo<Option[]>(() => {
    const list: Option[] = state.query && state.query === query.trim() ? state.results.map(result => ({ key: `r-${result.ticker}`, ticker: result.ticker, result })) : [];
    if (typed && validTicker(typed) && !list.some(option => option.ticker === typed)) list.push({ key: `exact-${typed}`, ticker: typed, result: null });
    return list;
  }, [state, query, typed]);

  const pick = (option: Option) => {
    onPick(option.ticker, option.result);
    setQuery('');
    setActive(-1);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive(previous => (options.length ? (previous + 1) % options.length : -1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive(previous => (options.length ? (previous <= 0 ? options.length - 1 : previous - 1) : -1));
    } else if (event.key === 'Enter') {
      if (!query.trim()) return;
      event.preventDefault();
      const chosen = active >= 0 ? options[active] : options.find(option => option.ticker === typed) ?? (options.length === 1 ? options[0] : undefined);
      if (chosen) pick(chosen);
    } else if (event.key === 'Escape') {
      if (open && query) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setActive(-1);
      } else if (query) {
        event.preventDefault();
        event.stopPropagation();
        setQuery('');
      }
    }
  };

  const showList = open && query.trim().length > 0 && options.length > 0;
  let status = '';
  if (disabled && disabledReason) status = disabledReason;
  else if (query.trim()) {
    if (state.status === 'loading' || debounced !== query.trim()) status = 'Searching…';
    else if (state.status === 'error') status = `Search is unavailable right now: ${state.error}`;
    else if (state.status === 'ready' && !state.results.length)
      status = validTicker(typed) ? `No listed matches for “${query.trim()}”. You can still look up ${typed} exactly as typed.` : `No matches for “${query.trim()}”.`;
    else if (state.status === 'ready') status = `${state.results.length} ${state.results.length === 1 ? 'match' : 'matches'}. Use the arrow keys to choose.`;
  }

  return (
    <div className="search">
      <label htmlFor={inputId} className={cx('field__label', hideLabel && 'sr-only')}>
        {label}
      </label>
      <div className={cx('search__box', disabled && 'is-disabled')}>
        <Search size={15} aria-hidden="true" className="search__icon" />
        <input
          ref={inputRef}
          id={inputId}
          className="search__input"
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={statusId}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={placeholder}
          value={query}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={event => {
            setQuery(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            window.clearTimeout(blurTimer.current);
            setOpen(true);
          }}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 150);
          }}
        />
      </div>
      <ul id={listId} role="listbox" aria-label="Matching securities" className={cx('search__list', showList && 'is-open')} hidden={!showList}>
        {showList &&
          options.map((option, index) => (
            <li
              key={option.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={cx('search__option', index === active && 'is-active')}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(option)}
            >
              <span className="search__ticker">{option.ticker}</span>
              {option.result ? (
                <span className="search__detail">
                  <span className="search__name">{option.result.name}</span>
                  <span className="search__meta">
                    {[option.result.exchange, option.result.instrument, option.result.sector].filter(Boolean).join(' · ')}
                  </span>
                </span>
              ) : (
                <span className="search__detail">
                  <span className="search__name">Look up “{option.ticker}” exactly as typed</span>
                  <span className="search__meta">Checked against market data before it is added</span>
                </span>
              )}
            </li>
          ))}
      </ul>
      <p id={statusId} className="search__status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
