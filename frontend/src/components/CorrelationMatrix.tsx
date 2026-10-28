import type { CSSProperties } from 'react';
import type { Analysis } from '../types';
import { DASH, isNum, signedNum } from '../lib/format';
import { ScrollRegion, cx } from './ui';

type Pair = { a: string; b: string; value: number };

/** The strongest co-moving and offsetting pairs (upper triangle only, nulls skipped). */
function rankedPairs({ tickers, matrix }: Analysis['correlations'], limit = 3) {
  const pairs: Pair[] = [];
  for (let row = 0; row < tickers.length; row += 1) {
    for (let column = row + 1; column < tickers.length; column += 1) {
      const value = matrix[row]?.[column];
      if (isNum(value)) pairs.push({ a: tickers[row], b: tickers[column], value });
    }
  }
  return {
    together: pairs.filter(pair => pair.value > 0).sort((x, y) => y.value - x.value).slice(0, limit),
    opposite: pairs.filter(pair => pair.value < 0).sort((x, y) => x.value - y.value).slice(0, limit),
  };
}

function PairList({ title, pairs, empty }: { title: string; pairs: Pair[]; empty: string }) {
  return (
    <div className="corr-pairs__group">
      <h3 className="corr-pairs__title">{title}</h3>
      {pairs.length ? (
        <ol className="corr-pairs__list" role="list">
          {pairs.map(pair => (
            <li key={`${pair.a}|${pair.b}`} className="corr-pairs__item">
              <span className="mono">
                {pair.a} <span className="faint">·</span> {pair.b}
              </span>
              <span className="corr-pairs__value">{signedNum(pair.value, 2)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="faint">{empty}</p>
      )}
    </div>
  );
}

/** Correlation heatmap as a real table. Brass tint = move together, grey tint = move opposite; null → "—". */
export function CorrelationMatrix({ correlations, frequency }: { correlations: Analysis['correlations']; frequency: 'daily' | 'weekly' }) {
  const { tickers, matrix } = correlations;
  if (tickers.length < 2) return <p className="faint">Correlations need at least two holdings with overlapping history.</p>;
  const { together, opposite } = rankedPairs(correlations);
  return (
    <div className="corr-wrap">
      <ScrollRegion label="Correlation matrix">
        <table className="corr" style={{ '--corr-n': tickers.length } as CSSProperties}>
          <caption className="sr-only">
            Correlation of {frequency} returns between holdings, from −1 to +1. A dash means there was not enough overlapping data.
          </caption>
          <thead>
            <tr>
              <td className="corr__corner" />
              {tickers.map(ticker => (
                <th key={ticker} scope="col" className="corr__col">
                  {ticker}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tickers.map((rowTicker, row) => (
              <tr key={rowTicker}>
                <th scope="row" className="corr__row">
                  {rowTicker}
                </th>
                {tickers.map((columnTicker, column) => {
                  const value = matrix[row]?.[column] ?? null;
                  const diagonal = row === column;
                  const strength = isNum(value) ? Math.min(1, Math.abs(value)) : 0;
                  const background =
                    !isNum(value) || diagonal
                      ? undefined
                      : value >= 0
                        ? `color-mix(in srgb, var(--lx-brass) ${Math.round(strength * 45)}%, var(--lx-panel))`
                        : `color-mix(in srgb, var(--lx-ink-2) ${Math.round(strength * 34)}%, var(--lx-panel))`;
                  return (
                    <td
                      key={columnTicker}
                      className={cx('corr__cell', diagonal && 'is-diagonal', !isNum(value) && 'is-empty')}
                      style={background ? { background } : undefined}
                      title={diagonal ? `${rowTicker} with itself` : `${rowTicker} vs ${columnTicker}: ${isNum(value) ? signedNum(value, 2) : 'not enough overlapping data'}`}
                    >
                      {isNum(value) ? (diagonal ? '1' : signedNum(value, 2)) : DASH}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <ul className="corr__legend">
        <li>
          <span className="corr__key corr__key--pos" aria-hidden="true" />
          Tends to move together
        </li>
        <li>
          <span className="corr__key corr__key--neg" aria-hidden="true" />
          Tends to move opposite
        </li>
        <li className="faint">Stronger tint = stronger relationship</li>
        <li className="faint">— = not enough overlapping data</li>
      </ul>
      <div className="corr-pairs">
        <PairList title="Strongest together" pairs={together} empty="No pair moved together in this window." />
        <PairList title="Strongest offsets" pairs={opposite} empty="No pair moved in opposite directions in this window." />
      </div>
    </div>
  );
}
