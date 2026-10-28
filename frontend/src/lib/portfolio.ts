import type { AnalysisRequest, AppConfig, Frequency, HistoryRange, HoldingInput, PortfolioInput } from '../types';

export const TICKER_PATTERN = /^[A-Z0-9^][A-Z0-9.\-^=]{0,19}$/;
export const MAX_SHARES = 1e9;
export const NAME_LIMIT = 80;

export const normalizeTicker = (value: string) => value.trim().toUpperCase();
export const validTicker = (value: string) => TICKER_PATTERN.test(value);
export const validShares = (value: number) => Number.isFinite(value) && value > 0 && value <= MAX_SHARES;

export function copyPortfolio(portfolio: PortfolioInput): PortfolioInput {
  return {
    name: portfolio.name,
    base_currency: portfolio.base_currency,
    holdings: portfolio.holdings.map(holding => ({ ticker: holding.ticker, shares: holding.shares })),
  };
}

export function copyRequest(request: AnalysisRequest): AnalysisRequest {
  return { portfolio: copyPortfolio(request.portfolio), benchmark: request.benchmark, range: request.range, frequency: request.frequency };
}

function holdingKey(holdings: HoldingInput[]): string {
  return holdings
    .map(holding => `${holding.ticker}=${Number.isFinite(holding.shares) ? holding.shares : 'NaN'}`)
    .sort()
    .join('|');
}

export function samePortfolio(a: PortfolioInput, b: PortfolioInput): boolean {
  return a.name.trim() === b.name.trim() && a.base_currency === b.base_currency && holdingKey(a.holdings) === holdingKey(b.holdings);
}

export function sameHoldings(a: HoldingInput[], b: HoldingInput[]): boolean {
  return holdingKey(a) === holdingKey(b);
}

/** Merge holdings by ticker, summing share quantities and keeping first-seen order. */
export function mergeHoldings(...lists: HoldingInput[][]): HoldingInput[] {
  const order: string[] = [];
  const totals = new Map<string, number>();
  for (const list of lists) {
    for (const holding of list) {
      const ticker = normalizeTicker(holding.ticker);
      if (!totals.has(ticker)) order.push(ticker);
      totals.set(ticker, (totals.get(ticker) ?? 0) + holding.shares);
    }
  }
  return order.map(ticker => ({ ticker, shares: roundShares(totals.get(ticker) ?? 0) }));
}

/** Avoid floating-point noise such as 0.30000000000000004 when summing fractional shares. */
export function roundShares(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/** Parse a typed quantity. Accepts "12", "12.5", "1,250" and "1,250.75"; anything else is NaN. */
export function parseQuantity(text: string): number {
  const cleaned = text.trim().replace(/[\s_\u00a0\u202f]/g, '');
  if (!cleaned) return Number.NaN;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) return Number(cleaned.replace(/,/g, ''));
  if (/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) return Number(cleaned);
  return Number.NaN;
}

export function quantityText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(roundShares(value));
}

export function quantityProblem(value: number, text?: string): string | null {
  if (text !== undefined && !text.trim()) return 'Enter a quantity.';
  if (!Number.isFinite(value)) return 'Use a number such as 12 or 12.5.';
  if (value <= 0) return 'Quantity must be greater than zero.';
  if (value > MAX_SHARES) return 'Quantity must be at most 1,000,000,000.';
  return null;
}

export interface PortfolioCheck {
  ok: boolean;
  messages: string[];
  rowErrors: Record<string, string>;
}

export function checkPortfolio(portfolio: PortfolioInput, config: AppConfig | null): PortfolioCheck {
  const messages: string[] = [];
  const rowErrors: Record<string, string> = {};
  const name = portfolio.name.trim();
  if (!name) messages.push('Give the portfolio a name.');
  else if (name.length > NAME_LIMIT) messages.push(`Keep the name to ${NAME_LIMIT} characters or fewer.`);
  else if (/[\u0000-\u001f\u007f]/.test(name)) messages.push('The name contains control characters.');
  if (config && !config.base_currencies.includes(portfolio.base_currency)) {
    messages.push(`Choose a base currency from the supported list (${config.base_currencies.join(', ')}).`);
  }
  const limit = config?.max_holdings ?? 20;
  if (portfolio.holdings.length === 0) messages.push('Add at least one holding.');
  if (portfolio.holdings.length > limit) messages.push(`A portfolio can hold at most ${limit} securities; remove ${portfolio.holdings.length - limit}.`);
  const seen = new Set<string>();
  for (const holding of portfolio.holdings) {
    if (!validTicker(holding.ticker)) rowErrors[holding.ticker] = 'This ticker format is not supported.';
    else if (seen.has(holding.ticker)) rowErrors[holding.ticker] = 'This ticker appears more than once.';
    else {
      const problem = quantityProblem(holding.shares);
      if (problem) rowErrors[holding.ticker] = problem;
    }
    seen.add(holding.ticker);
  }
  const rowProblemCount = Object.keys(rowErrors).length;
  if (rowProblemCount) messages.push(`Fix ${rowProblemCount === 1 ? 'the highlighted holding' : `${rowProblemCount} highlighted holdings`}.`);
  return { ok: messages.length === 0, messages, rowErrors };
}

export interface ControlsInput {
  benchmark: string;
  range: HistoryRange;
  frequency: Frequency;
}

export function weeklyAllowed(range: HistoryRange): boolean {
  return range !== '6mo';
}

export function checkControls(controls: ControlsInput, config: AppConfig | null): string[] {
  const messages: string[] = [];
  if (!controls.benchmark) messages.push('Choose a benchmark.');
  else if (!validTicker(controls.benchmark)) messages.push('Enter a valid benchmark ticker (letters, digits, “.”, “-”, “^” or “=”).');
  if (config && !config.ranges.includes(controls.range)) messages.push('Choose a supported history range.');
  if (controls.frequency === 'weekly' && !weeklyAllowed(controls.range)) messages.push('Weekly returns need a range of 1 year or longer.');
  return messages;
}

export function emptyPortfolio(baseCurrency: string): PortfolioInput {
  return { name: 'Untitled portfolio', base_currency: baseCurrency, holdings: [] };
}

export function uniqueName(name: string, taken: string[]): string {
  const base = name.trim() || 'Untitled portfolio';
  const names = new Set(taken.map(item => item.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base.slice(0, NAME_LIMIT);
  for (let index = 1; index < 100; index += 1) {
    const suffix = index === 1 ? ' (copy)' : ` (copy ${index})`;
    const candidate = `${base.slice(0, NAME_LIMIT - suffix.length)}${suffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return base.slice(0, NAME_LIMIT);
}
