import type { CSSProperties } from 'react';
import type { Analysis } from '../types';
import { DASH, isNum, signedNum } from '../lib/format';
import { ScrollRegion, cx } from './ui';

type Pair = { a: string; b: string; value: number };

/** Binned diverging scale: oxblood for negative, paper near zero, navy for positive. Strong bins switch to light text. */
const STEPS = [
  { below: 0.2, mix: 6 },
  { below: 0.4, mix: 20 },
  { below: 0.6, mix: 38 },
  { below: 0.8, mix: 78 },
  { below: Infinity, mix: 92 },
];

function tint(value: number) {
  const step = STEPS.find(item => Math.abs(value) < item.below) ?? STEPS[STEPS.length - 1];
  const hue = value < 0 ? 'var(--lx-down)' : 'var(--lx-accent)';
  return { background: `color-mix(in srgb, ${hue} ${step.mix}%, var(--lx-canvas))`, strong: step.mix >= 50 };
}

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
              <span>
                <span className="mono">{pair.a}</span> and <span className="mono">{pair.b}</span>
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

/** Correlation heatmap as a real table: navy for positive, oxblood for negative, "n/a" where data is missing. */
export function CorrelationMatrix({ correlations, frequency }: { correlations: Analysis['correlations']; frequency: 'daily' | 'weekly' }) {
  const { tickers, matrix } = correlations;
  if (tickers.length < 2) return <p className="faint">Correlations need at least two holdings with overlapping price history.</p>;
  const { together, opposite } = rankedPairs(correlations);
  return (
    <div className="corr-wrap">
      <ScrollRegion label="Correlation matrix">
        <table className="corr" style={{ '--corr-n': tickers.length } as CSSProperties}>
          <caption className="sr-only">
            Correlation of {frequency} returns between holdings, from −1 to +1. n/a means there was not enough overlapping data.
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
                  const shade = isNum(value) && !diagonal ? tint(value) : null;
                  return (
                    <td
                      key={columnTicker}
                      className={cx('corr__cell', diagonal && 'is-diagonal', !isNum(value) && 'is-empty', shade?.strong && 'is-strong')}
                      style={shade ? { background: shade.background } : undefined}
                      title={diagonal ? `${rowTicker} with itself` : `${rowTicker} and ${columnTicker}: ${isNum(value) ? signedNum(value, 2) : 'not enough overlapping data'}`}
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
      <div className="corr__legend">
        <span className="corr__scale" aria-hidden="true">
          <span className="corr__scale-label">−1</span>
          {[-0.9, -0.5, 0, 0.5, 0.9].map(value => (
            <span key={value} className="corr__key" style={{ background: tint(value).background }} />
          ))}
          <span className="corr__scale-label">+1</span>
        </span>
        <p className="corr__legend-text">
          Navy cells: returns tended to move together. Oxblood cells: they tended to move in opposite directions. Darker cells show a stronger
          relationship; n/a means there was not enough overlapping data.
        </p>
      </div>
      <div className="corr-pairs">
        <PairList title="Highest correlations" pairs={together} empty="No pair had a positive correlation in this window." />
        <PairList title="Negative correlations" pairs={opposite} empty="No pair had a negative correlation in this window." />
      </div>
    </div>
  );
}
