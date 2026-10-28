// API contract shared by the LENS frontend and the Python service.
// Fractions are always 0..1 fractions (0.052 = 5.2%), never percentages.

export type HistoryRange = '6mo' | '1y' | '2y' | '5y' | '10y' | 'max';
export type Frequency = 'auto' | 'daily' | 'weekly';
export type Instrument = 'EQUITY' | 'ETF' | 'MUTUALFUND';

export interface HoldingInput { ticker: string; shares: number }
export interface PortfolioInput {
  name: string;
  base_currency: string; // ISO code from AppConfig.base_currencies
  holdings: HoldingInput[];
}
export interface SavedPortfolio extends PortfolioInput {
  id: string;
  revision: number;
  updated_at: string;
}

export interface AppConfig {
  base_currencies: string[];
  ranges: HistoryRange[];
  frequencies: Frequency[];
  benchmarks: { ticker: string; name: string; region: string }[];
  max_holdings: number;
  news_refresh_hours: number;
}

export interface Asset {
  ticker: string;
  name: string;
  exchange: string;
  exchange_timezone: string;
  currency: string; // as quoted by the provider, e.g. "GBp" (pence)
  currency_iso: string; // ISO unit, e.g. "GBP"
  currency_scale: number; // quote × scale = ISO units (0.01 for GBp, ZAc, ILA)
  instrument: Instrument;
  sector: string | null; // one of SectorBrief.name values, or null when unknown / fund
  price: number; // latest completed close, in `currency`
  price_date: string;
  fetched_at: string;
  source: string;
  warnings: string[];
}

export interface SearchResult {
  ticker: string;
  name: string;
  exchange: string;
  instrument: string;
  sector: string | null;
}

export interface AssetHistory {
  ticker: string;
  name: string;
  currency: string;
  currency_iso: string;
  currency_scale: number;
  range: HistoryRange;
  points: { date: string; close: number; adjusted_close: number }[];
  dividends: { date: string; amount: number }[]; // amount in `currency`
  splits: { date: string; numerator: number; denominator: number }[];
  fetched_at: string;
  source: string;
  warnings: string[];
}

export interface Session {
  date: string; // latest completed session for this holding
  previous_date: string;
  return_local: number; // dividend-adjusted, local currency
  return_base: number | null; // includes FX move; null if same-date FX unavailable
  change_base: number | null; // base-currency value change over the session
}

export interface ValuedHolding extends Asset {
  shares: number;
  fx_rate: number; // 1 ISO unit of currency_iso = fx_rate base units
  fx_date: string;
  price_base: number; // price × currency_scale × fx_rate
  market_value: number; // base currency
  weight: number;
  annual_volatility: number;
  beta: number | null;
  risk_contribution: number | null; // may be negative (historical offset)
  session: Session | null;
  period_returns: { m1: number | null; y1: number | null }; // local-currency total returns
}

export interface Exposure { label: string; weight: number }

export interface Concentration {
  positions: number;
  hhi: number;
  effective_positions: number;
  largest_position: string;
  largest_weight: number;
  top_3_weight: number;
  sector_exposures: { sector: string; weight: number }[]; // includes "Funds (no look-through)" and "Unknown"
  currency_exposures: { currency: string; weight: number }[]; // ISO currencies
  exchange_exposures: Exposure[];
  unknown_sector_weight: number;
  fund_weight: number;
}

export interface RiskMetrics {
  annual_volatility: number;
  period_volatility: number; // per observation period (day or week)
  beta: number | null;
  benchmark_volatility: number;
  benchmark_correlation: number | null;
  max_drawdown: number; // <= 0
  historical_return: number;
  benchmark_return: number;
  historical_var_95: number; // one-period loss threshold, >= 0
  historical_es_95: number; // >= historical_var_95
  worst_period: number;
  best_period: number;
  var_amount: number;
  es_amount: number;
}

export interface Explanation { title: string; text: string; severity: 'info' | 'warning'; metric: string }

export interface FxConversion {
  currency: string; // ISO source currency
  base: string;
  rate: number;
  date: string;
  method: 'direct' | 'inverse' | 'triangulated';
  pairs: string[];
}

export interface Analysis {
  portfolio: PortfolioInput;
  total_value: number;
  holdings: ValuedHolding[];
  concentration: Concentration;
  risk: RiskMetrics;
  benchmark: { ticker: string; name: string; currency: string };
  coverage: {
    requested_range: HistoryRange;
    frequency: 'daily' | 'weekly';
    requested_frequency: Frequency;
    frequency_reason: string;
    periods_per_year: number;
    horizon: 'day' | 'week';
    start_date: string;
    end_date: string;
    observations: number;
    min_observations: number;
    candidate_observations: number;
    dropped_observations: number;
    priced_weight: number;
    return_method: string;
  };
  session: {
    change_base: number | null; // sum of holding session changes
    return_base: number | null;
    covered_weight: number; // weight of holdings with a usable session
    latest_date: string | null;
  };
  fx: FxConversion[];
  series: { date: string; portfolio: number; benchmark: number; drawdown: number; period_return: number }[];
  correlations: { tickers: string[]; matrix: (number | null)[][] };
  explanations: Explanation[];
  explanation_method: string;
  warnings: string[];
  assumptions: string[];
  generated_at: string;
  market_fetched_at: string;
  source: string;
}

export interface AnalysisRequest {
  portfolio: PortfolioInput;
  benchmark: string;
  range: HistoryRange;
  frequency: Frequency;
  refresh?: boolean;
}

export interface ScenarioResponse {
  baseline: Analysis;
  scenario: Analysis;
  delta: {
    total_value: number;
    annual_volatility: number;
    beta: number | null;
    max_drawdown: number;
    effective_positions: number;
  };
}

// ---- News -------------------------------------------------------------
export interface NewsItem {
  id: string;
  title: string;
  publisher: string;
  url: string; // always http(s)
  published_at: string; // ISO-8601 UTC
  tickers: string[]; // provider-supplied related tickers
  sectors: string[]; // SectorBrief ids this item was collected for
  source: string;
}

export interface SectorMove {
  proxy: string; // ETF used as a sector proxy
  proxy_name: string;
  currency: string;
  as_of: string | null; // latest completed close date
  d1: number | null;
  w1: number | null;
  m1: number | null;
  ytd: number | null;
}

export interface SectorBrief {
  id: string; // e.g. "information_technology"
  name: string; // e.g. "Information Technology" — same names as holding sectors
  us: SectorMove | null; // US Select Sector SPDR proxy
  global: SectorMove | null; // iShares Global sector proxy
  headlines: NewsItem[]; // newest first
}

export interface SectorBoard {
  sectors: SectorBrief[];
  refreshed_at: string | null;
  next_refresh_at: string | null;
  refreshing: boolean;
  last_error: string | null;
  source: string;
}

export interface HoldingsNews {
  items: NewsItem[]; // newest first, deduplicated
  by_ticker: Record<string, string[]>; // ticker -> NewsItem ids
  refreshed_at: string;
  source: string;
  warnings: string[];
}

export interface NewsStatus {
  refreshed_at: string | null;
  next_refresh_at: string | null;
  refreshing: boolean;
  last_error: string | null;
}

// ---- Screenshot import --------------------------------------------------
export interface ScreenshotBox { x: number; y: number; width: number; height: number } // original-image pixels

export interface ScreenshotCandidate {
  ticker: string;
  name: string;
  exchange: string;
  currency: string;
  instrument: string;
  price: number | null; // latest completed close in `currency`, null when not resolved
  price_date: string | null;
}

export interface ScreenshotRow {
  id: string;
  line_text: string;
  box: ScreenshotBox;
  detected_symbol: string | null;
  detected_name: string | null;
  candidates: ScreenshotCandidate[]; // ranked; empty when unresolved
  selected_ticker: string | null; // suggestion only — the user confirms
  quantity: number | null;
  quantity_source: 'column' | 'value_check' | 'derived_from_value' | 'single_number' | 'none';
  screenshot_price: number | null;
  screenshot_value: number | null;
  check: { status: 'consistent' | 'inconsistent' | 'unverified'; detail: string };
  confidence: number; // 0..1, lowest OCR confidence among tokens used
  issues: string[];
}

export interface ScreenshotImport {
  image: { width: number; height: number };
  engine: string;
  rows: ScreenshotRow[];
  ignored_lines: { text: string; box: ScreenshotBox }[];
  currency_hint: string | null;
  header_detected: boolean;
  warnings: string[];
  processed_at: string;
}
