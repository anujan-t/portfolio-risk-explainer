export type Currency = 'USD' | 'CAD';
export type HistoryRange = '6mo' | '1y' | '2y' | '5y';
export interface HoldingInput { ticker: string; shares: number }
export interface PortfolioInput {
  name: string;
  base_currency: Currency;
  holdings: HoldingInput[];
}
export interface SavedPortfolio extends PortfolioInput {
  id: string;
  revision: number;
  updated_at: string;
}
export interface Asset {
  ticker: string;
  name: string;
  exchange: string;
  currency: Currency;
  instrument: 'EQUITY' | 'ETF';
  sector: string | null;
  price: number;
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
export interface ValuedHolding extends Asset {
  shares: number;
  fx_rate: number;
  fx_date: string;
  price_base: number;
  market_value: number;
  weight: number;
  annual_volatility: number;
  beta: number | null;
  risk_contribution: number | null;
}
export interface Concentration {
  positions: number;
  hhi: number;
  effective_positions: number;
  largest_position: string;
  largest_weight: number;
  top_3_weight: number;
  sector_exposures: { sector: string; weight: number }[];
  currency_exposures: { currency: string; weight: number }[];
  unknown_sector_weight: number;
  fund_weight: number;
}
export interface RiskMetrics {
  annual_volatility: number;
  daily_volatility: number;
  beta: number | null;
  benchmark_volatility: number;
  benchmark_correlation: number | null;
  max_drawdown: number;
  historical_return: number;
  benchmark_return: number;
  historical_var_95: number;
  historical_es_95: number;
  worst_day: number;
  best_day: number;
  var_amount: number;
  es_amount: number;
}
export interface Explanation {
  title: string;
  text: string;
  severity: 'info' | 'warning';
  metric: string;
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
    start_date: string;
    end_date: string;
    observations: number;
    candidate_observations: number;
    dropped_observations: number;
    priced_weight: number;
    return_method: string;
  };
  series: { date: string; portfolio: number; benchmark: number; drawdown: number; daily_return: number }[];
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
