import type { ReactNode } from 'react';
import { useLens } from '../state/store';
import { useReducedMotion } from '../lib/hooks';
import { rangeLabel } from '../lib/format';
import { PageHeader } from '../components/page';
import { KeyValue, Panel } from '../components/ui';

const SECTIONS = [
  { id: 'data', title: 'Data sources' },
  { id: 'currencies', title: 'Exchanges and currencies' },
  { id: 'frequency', title: 'Daily or weekly returns' },
  { id: 'formulas', title: 'Formulas' },
  { id: 'simulation', title: 'Historical simulation' },
  { id: 'news', title: 'News' },
  { id: 'screenshot', title: 'Screenshot import' },
  { id: 'storage', title: 'Saved portfolios' },
  { id: 'advice', title: 'Not investment advice' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const title = SECTIONS.find(section => section.id === id)?.title ?? id;
  const number = SECTIONS.findIndex(section => section.id === id) + 1;
  return (
    <section className="method__section" aria-labelledby={`method-${id}`}>
      <h2 className="method__heading" id={`method-${id}`} tabIndex={-1}>
        <span className="method__number" aria-hidden="true">
          {String(number).padStart(2, '0')}
        </span>
        {title}
      </h2>
      <div className="method__body">{children}</div>
    </section>
  );
}

function Formula({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="formula">
      <dt className="formula__label">{label}</dt>
      <dd className="formula__expr">
        <code>{children}</code>
      </dd>
    </div>
  );
}

export function MethodPage() {
  const { config } = useLens();
  const reduced = useReducedMotion();
  const jump = (id: SectionId) => {
    const heading = document.getElementById(`method-${id}`);
    if (!heading) return;
    heading.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    heading.focus({ preventScroll: true });
  };
  const hours = config?.news_refresh_hours ?? 6;

  return (
    <div className="page method">
      <PageHeader title="Method" meta="How LENS prices holdings, converts currencies, measures risk and collects news." />
      <nav className="method__toc" aria-label="Method sections">
        <ul role="list">
          {SECTIONS.map((section, index) => (
            <li key={section.id}>
              <button type="button" className="method__toc-link" onClick={() => jump(section.id)}>
                <span className="method__toc-n" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {section.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="method__layout">
        <article className="method__article">
          <Section id="data">
            <p>
              Prices, dividends, splits, exchange rates and security search come from Yahoo Finance’s public web endpoints. They are unofficial, can be delayed, incomplete or revised, and may be
              unavailable at times. When a request fails, LENS says so; it never substitutes estimated or sample data. Requests to these endpoints contain security symbols and search text;
              share counts and portfolio names stay on this computer.
            </p>
            <p>
              Figures use <strong>completed daily closes</strong> only. The “latest session” for a holding is its most recent completed close compared with the close before it, so holdings on
              different exchanges can show different session dates. Data is cached on this computer; the refresh button on the Risk page fetches it again.
            </p>
          </Section>

          <Section id="currencies">
            <p>
              Each security is priced in the currency its exchange quotes. Some exchanges quote in minor units — London in pence (GBp), Johannesburg in cents (ZAc), Tel Aviv in agorot (ILA). These
              prices are shown as quoted (for example “117.85 GBp”) and multiplied by 0.01 to reach the ISO currency before any conversion.
            </p>
            <p>
              Historical returns convert each price with the exchange-rate close from the same date. If that rate is missing, the observation is left out rather than filled with a rate from
              another day. Current values use the latest completed exchange-rate close, so a valuation can mix closing times across markets. The rates used are listed under Risk → Assumptions
              and data.
            </p>
            <p>Each rate comes from one of three routes:</p>
            <ul className="bullet-list">
              <li>
                <strong>Direct</strong> — a quoted pair such as <code>GBPUSD=X</code>.
              </li>
              <li>
                <strong>Inverse</strong> — the opposite pair, inverted (1 ÷ <code>USDGBP=X</code>).
              </li>
              <li>
                <strong>Triangulated</strong> — through USD when no pair exists, for example CAD → USD → EUR.
              </li>
            </ul>
          </Section>

          <Section id="frequency">
            <p>
              Markets close at different times: Tokyo closes before London, which closes before New York. On daily data, news that moves all three appears on different dates, which makes
              international holdings look less related than they are and understates portfolio risk.
            </p>
            <p>
              <strong>Auto</strong> compares the time zones of the holdings’ exchanges and the benchmark. When they are 3 or more hours apart and the range is at least 1 year, it uses weekly
              returns, each built from a security’s last close of the week; otherwise it uses daily returns. The reason is shown under the controls. Weekly returns cannot be chosen with a
              6-month range. Value at risk and expected shortfall follow the frequency: a 1-day horizon for daily returns, 1-week for weekly.
            </p>
          </Section>

          <Section id="formulas">
            <p>All returns use dividend- and split-adjusted closes converted to the base currency.</p>
            <dl className="formulas">
              <Formula label="Holding return">
                r<sub>i,t</sub> = P<sub>i,t</sub> ÷ P<sub>i,t−1</sub> − 1
              </Formula>
              <Formula label="Portfolio return">
                r<sub>p,t</sub> = Σ<sub>i</sub> w<sub>i</sub> r<sub>i,t</sub>
              </Formula>
              <Formula label="Annual volatility">
                σ<sub>p</sub> = √(w<sup>T</sup>Σw) × √N
              </Formula>
              <Formula label="Beta">
                β = cov(r<sub>p</sub>, r<sub>b</sub>) ÷ var(r<sub>b</sub>)
              </Formula>
              <Formula label="Correlation">
                ρ = cov(r<sub>p</sub>, r<sub>b</sub>) ÷ (σ<sub>p</sub> σ<sub>b</sub>)
              </Formula>
              <Formula label="Max drawdown">
                MDD = min<sub>t</sub> (I<sub>t</sub> ÷ max<sub>s≤t</sub> I<sub>s</sub> − 1)
              </Formula>
              <Formula label="Concentration (HHI)">
                HHI = Σ<sub>i</sub> w<sub>i</sub><sup>2</sup>
              </Formula>
              <Formula label="Effective positions">1 ÷ HHI</Formula>
              <Formula label="Risk contribution">
                RC<sub>i</sub> = w<sub>i</sub> (Σw)<sub>i</sub> ÷ w<sup>T</sup>Σw
              </Formula>
              <Formula label="Historical VaR 95">
                VaR = −q<sub>5%</sub>(r<sub>p</sub>)
              </Formula>
              <Formula label="Expected shortfall 95">
                ES = −mean(r<sub>p</sub> | r<sub>p</sub> ≤ q<sub>5%</sub>)
              </Formula>
            </dl>
            <p className="method__where">
              P is an adjusted close in the base currency, w the current weights, Σ the covariance matrix of holding returns, b the benchmark, I the portfolio index (100 at the start of the
              window), q<sub>5%</sub> the 5th percentile, and N the periods per year: 252 for daily returns, 52 for weekly.
            </p>
            <p>
              Amounts for VaR and ES apply those fractions to the current total value. Risk contributions add up to 100%; a negative contribution means the holding moved against the rest of
              the portfolio in this window — a historical offset, not a guarantee of protection.
            </p>
          </Section>

          <Section id="simulation">
            <p>
              Risk figures are a <strong>constant-weight historical simulation</strong>: today’s weights are applied to past returns as if the portfolio had been held, and rebalanced to those
              weights, throughout the window. They are not your actual past performance and do not include trading costs, taxes or cash.
            </p>
            <p>Past volatility and correlations change, short windows are noisy, and VaR is not a worst case: losses beyond it happen, by construction, in about 1 period in 20.</p>
          </Section>

          <Section id="news">
            <p>
              Headlines are collected from Yahoo Finance news search for each applied holding and for 11 sectors, each tracked through a US Select Sector SPDR ETF and an iShares Global sector ETF.
              Sector news refreshes automatically about every {hours} hours; the Refresh button asks for an earlier update and may be skipped if one ran recently.
            </p>
            <p>
              LENS lists headlines newest first with their publisher and time. It does not score sentiment, summarise or rank stories, and every link opens the original publisher. Coverage can be
              incomplete or late, and some publishers require a subscription.
            </p>
          </Section>

          <Section id="screenshot">
            <p>
              Screenshots are read with text recognition that runs on this computer. The image is not stored and not uploaded anywhere. Detected names and symbols are looked up through the
              security search to suggest listings, and where a price and value are visible, quantity × price is checked against the value.
            </p>
            <p>
              Every row needs your review: suggestions are never assumed, rows without a security or quantity cannot be used, and the result only changes the draft. Nothing is analyzed or saved
              until you choose to.
            </p>
          </Section>

          <Section id="storage">
            <p>
              Saved portfolios are stored on this computer by the local LENS service. Each save records a revision number; if the portfolio was changed in another window since you opened it, LENS
              does not overwrite it and offers to reload it or save a copy.
            </p>
          </Section>

          <Section id="advice">
            <p>
              LENS describes historical behaviour of the holdings you enter. It is not investment, tax or legal advice, makes no recommendations, and executes no trades. Check important figures with
              your broker or another source before acting on them.
            </p>
          </Section>
        </article>

        <aside className="method__aside" aria-label="Current settings">
          <Panel title="Current settings" meta="From the local LENS service">
            {config ? (
              <KeyValue
                className="facts--compact"
                items={[
                  { label: 'Base currencies', value: config.base_currencies.join(', ') },
                  { label: 'Ranges', value: config.ranges.map(rangeLabel).join(' · ') },
                  { label: 'Benchmarks', value: config.benchmarks.map(benchmark => benchmark.ticker).join(', ') },
                  { label: 'Maximum holdings', value: config.max_holdings },
                  { label: 'Sector news refresh', value: `About every ${config.news_refresh_hours} h` },
                ]}
              />
            ) : (
              <p className="faint">Settings are not available.</p>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
