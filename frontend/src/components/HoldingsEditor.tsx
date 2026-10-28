import { useEffect, useId, useRef, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { Asset, HoldingInput, SearchResult } from '../types';
import { useLens } from '../state/store';
import { api, errorMessage, isAbort } from '../lib/api';
import { fmtDate, quantity, quotePrice } from '../lib/format';
import { mergeHoldings, parseQuantity, quantityProblem, quantityText } from '../lib/portfolio';
import { TickerSearch } from './TickerSearch';
import { FieldMessage, Notice, ScrollRegion, Spinner, cx } from './ui';

// Lookups that failed, kept for the session so rows are not re-requested on every render.
const failedLookups = new Map<string, string>();

/** Resolve rows whose asset details are not cached yet, one at a time. */
function useMissingAssets(tickers: string[]) {
  const { assets, rememberAssets } = useLens();
  const [, setVersion] = useState(0);
  const [loading, setLoading] = useState<string | null>(null);
  const missing = tickers.filter(ticker => !assets[ticker] && !failedLookups.has(ticker));
  const key = missing.join(',');
  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const queue = key.split(',');
    (async () => {
      for (const ticker of queue) {
        if (controller.signal.aborted) return;
        setLoading(ticker);
        try {
          const asset = await api.asset(ticker, controller.signal);
          rememberAssets([asset]);
        } catch (error) {
          if (isAbort(error)) return;
          failedLookups.set(ticker, errorMessage(error));
          setVersion(value => value + 1);
        }
      }
      if (!controller.signal.aborted) setLoading(null);
    })();
    return () => controller.abort();
  }, [key, rememberAssets]);
  return { assets, loading, failures: failedLookups };
}

function QuantityInput({
  value,
  onChange,
  label,
  invalid,
  describedBy,
  id,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  invalid?: boolean;
  describedBy?: string;
  id?: string;
}) {
  const [text, setText] = useState(() => quantityText(value));
  useEffect(() => {
    setText(previous => {
      const parsed = parseQuantity(previous);
      if (Object.is(parsed, value) || (Number.isNaN(parsed) && Number.isNaN(value))) return previous;
      return quantityText(value);
    });
  }, [value]);
  return (
    <input
      id={id}
      className={cx('input', 'input--num', invalid && 'is-invalid')}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={text}
      onChange={event => {
        setText(event.target.value);
        onChange(parseQuantity(event.target.value));
      }}
    />
  );
}

interface Pick {
  ticker: string;
  hint: SearchResult | null;
  status: 'loading' | 'ready' | 'error';
  asset: Asset | null;
  error: string | null;
}

/** Holdings editor shared by Import → Manual and Scenarios. Edits are local until the caller saves or analyzes. */
export function HoldingsEditor({
  holdings,
  onChange,
  rowErrors,
  maxHoldings,
  caption,
}: {
  holdings: HoldingInput[];
  onChange: (holdings: HoldingInput[]) => void;
  rowErrors: Record<string, string>;
  maxHoldings: number;
  caption: string;
}) {
  const { rememberAssets } = useLens();
  const { assets, loading, failures } = useMissingAssets(holdings.map(holding => holding.ticker));
  const [pick, setPick] = useState<Pick | null>(null);
  const [quantityInput, setQuantityInput] = useState('');
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const lookup = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const quantityField = useRef<HTMLInputElement>(null);
  const id = useId();
  const full = holdings.length >= maxHoldings;

  useEffect(() => () => lookup.current?.abort(), []);

  const resolve = (ticker: string, hint: SearchResult | null) => {
    lookup.current?.abort();
    const controller = new AbortController();
    lookup.current = controller;
    setMessage(null);
    setQuantityError(null);
    setPick({ ticker, hint, status: 'loading', asset: null, error: null });
    api
      .asset(ticker, controller.signal)
      .then(asset => {
        if (controller.signal.aborted) return;
        rememberAssets([asset]);
        failedLookups.delete(asset.ticker);
        setPick({ ticker, hint, status: 'ready', asset, error: null });
        window.requestAnimationFrame(() => quantityField.current?.focus());
      })
      .catch(error => {
        if (isAbort(error) || controller.signal.aborted) return;
        setPick({ ticker, hint, status: 'error', asset: null, error: errorMessage(error) });
      });
  };

  const cancelPick = () => {
    lookup.current?.abort();
    setPick(null);
    setQuantityInput('');
    setQuantityError(null);
    window.requestAnimationFrame(() => searchInput.current?.focus());
  };

  const add = () => {
    if (!pick?.asset) return;
    const shares = parseQuantity(quantityInput);
    const problem = quantityProblem(shares, quantityInput);
    if (problem) {
      setQuantityError(problem);
      quantityField.current?.focus();
      return;
    }
    const ticker = pick.asset.ticker;
    const existing = holdings.find(holding => holding.ticker === ticker);
    if (!existing && full) {
      setQuantityError(`A portfolio can hold at most ${maxHoldings} securities.`);
      return;
    }
    const next = mergeHoldings(holdings, [{ ticker, shares }]);
    onChange(next);
    const total = next.find(holding => holding.ticker === ticker)?.shares ?? shares;
    setMessage(existing ? `Added ${quantity(shares)} to ${ticker}; it now holds ${quantity(total)}.` : `Added ${ticker} (${quantity(shares)}).`);
    setPick(null);
    setQuantityInput('');
    window.requestAnimationFrame(() => searchInput.current?.focus());
  };

  const remove = (ticker: string) => {
    onChange(holdings.filter(holding => holding.ticker !== ticker));
    setMessage(`Removed ${ticker}.`);
  };

  return (
    <div className="editor">
      <div className="editor__add">
        <TickerSearch
          inputRef={searchInput}
          onPick={resolve}
          disabled={full && !pick}
          disabledReason={full ? `This portfolio has the maximum of ${maxHoldings} holdings. Remove one to add another.` : undefined}
          label="Add a holding"
        />
        {pick && (
          <div className="pick" aria-live="polite">
            {pick.status === 'loading' && (
              <div className="pick__row">
                <Spinner />
                <span>
                  Looking up <span className="mono">{pick.ticker}</span>…
                </span>
                <button type="button" className="button button--quiet button--small" onClick={cancelPick}>
                  Cancel
                </button>
              </div>
            )}
            {pick.status === 'error' && (
              <Notice
                tone="error"
                title={`${pick.ticker} could not be found`}
                actions={
                  <>
                    <button type="button" className="button button--small" onClick={() => resolve(pick.ticker, pick.hint)}>
                      Try again
                    </button>
                    <button type="button" className="button button--quiet button--small" onClick={cancelPick}>
                      Choose another
                    </button>
                  </>
                }
              >
                {pick.error}
              </Notice>
            )}
            {pick.status === 'ready' && pick.asset && (
              <form
                className="pick__card"
                onSubmit={event => {
                  event.preventDefault();
                  add();
                }}
              >
                <div className="pick__head">
                  <span className="pick__ticker">{pick.asset.ticker}</span>
                  <span className="pick__name">{pick.asset.name}</span>
                  <button type="button" className="icon-button icon-button--small" aria-label="Cancel adding this security" onClick={cancelPick}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <p className="pick__facts">
                  {[pick.asset.exchange, pick.asset.currency, pick.asset.instrument === 'ETF' ? 'ETF' : pick.asset.instrument === 'MUTUALFUND' ? 'Fund' : 'Equity', pick.asset.sector]
                    .filter(Boolean)
                    .join(' · ')}
                  <br />
                  Last close {quotePrice(pick.asset.price, pick.asset.currency, pick.asset.currency_scale)} on {fmtDate(pick.asset.price_date)}
                </p>
                {pick.asset.warnings.length > 0 && <p className="pick__warn">{pick.asset.warnings.join(' ')}</p>}
                <div className="pick__entry">
                  <label className="field">
                    <span className="field__label">Quantity (shares or units)</span>
                    <input
                      ref={quantityField}
                      className={cx('input', 'input--num', quantityError && 'is-invalid')}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="e.g. 25 or 12.5"
                      value={quantityInput}
                      aria-invalid={quantityError ? true : undefined}
                      aria-describedby={quantityError ? `${id}-qty-error` : undefined}
                      onChange={event => {
                        setQuantityInput(event.target.value);
                        setQuantityError(null);
                      }}
                    />
                  </label>
                  <button type="submit" className="button button--primary">
                    <Plus size={14} aria-hidden="true" />
                    {holdings.some(holding => holding.ticker === pick.asset?.ticker) ? 'Add to existing' : 'Add holding'}
                  </button>
                </div>
                {quantityError && <FieldMessage id={`${id}-qty-error`}>{quantityError}</FieldMessage>}
              </form>
            )}
          </div>
        )}
        <p className="editor__message" aria-live="polite">
          {message}
        </p>
      </div>

      {holdings.length === 0 ? (
        <p className="editor__empty">No holdings yet. Search for a ticker or company above to add the first one.</p>
      ) : (
        <ScrollRegion label={caption} className="editor__scroll">
          <table className="ledger ledger--editor">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Security</th>
                <th scope="col" className="num editor__close">
                  Last close
                </th>
                <th scope="col" className="num">
                  Quantity
                </th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {holdings.map(holding => {
                const asset = assets[holding.ticker];
                const failure = failures.get(holding.ticker);
                const error = rowErrors[holding.ticker];
                const errorId = `${id}-row-${holding.ticker}`;
                return (
                  <tr key={holding.ticker} className={cx(error && 'is-invalid')}>
                    <th scope="row" className="editor__security">
                      <span className="mono editor__ticker">{holding.ticker}</span>
                      <span className="editor__name" title={asset ? `${asset.name} · ${asset.exchange}` : undefined}>
                        {asset ? (
                          <>
                            {asset.name}
                            <span className="editor__exchange"> · {asset.exchange}</span>
                          </>
                        ) : failure ? (
                          `Not found: ${failure}`
                        ) : loading === holding.ticker ? (
                          'Looking up…'
                        ) : (
                          'Details pending'
                        )}
                      </span>
                      {asset && <span className="editor__close-inline">Last close {quotePrice(asset.price, asset.currency, asset.currency_scale)}</span>}
                      {error && (
                        <FieldMessage id={errorId}>
                          {error}
                        </FieldMessage>
                      )}
                    </th>
                    <td className="num editor__close">{asset ? quotePrice(asset.price, asset.currency, asset.currency_scale) : '—'}</td>
                    <td className="num editor__qty">
                      <QuantityInput
                        value={holding.shares}
                        label={`Quantity of ${holding.ticker}`}
                        invalid={Boolean(error)}
                        describedBy={error ? errorId : undefined}
                        onChange={shares => onChange(holdings.map(item => (item.ticker === holding.ticker ? { ...item, shares } : item)))}
                      />
                    </td>
                    <td className="editor__remove">
                      <button type="button" className="icon-button icon-button--small" aria-label={`Remove ${holding.ticker}`} onClick={() => remove(holding.ticker)}>
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
      <p className="editor__count faint">
        {holdings.length} of {maxHoldings} holdings
      </p>
    </div>
  );
}
