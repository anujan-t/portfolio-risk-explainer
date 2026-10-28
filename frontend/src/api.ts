import type { Analysis, AnalysisRequest, Asset, PortfolioInput, SavedPortfolio, ScenarioResponse, SearchResult, HistoryRange } from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new Error('The local service could not be reached. Check that the Portfolio Risk Explainer is running, then try again. No substitute prices have been used.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.detail;
    const text = typeof detail === 'string' ? detail
      : Array.isArray(detail) ? detail.map((item: { loc?: string[]; msg?: string }) =>
        `${item.loc?.filter(part => part !== 'body').join(' › ') || 'Request'}: ${item.msg || 'Invalid value'}`).join('; ')
      : `The request failed (${response.status}). Please try again.`;
    throw new ApiError(response.status === 409 && path.startsWith('/portfolios/') ? `${text} Reload the saved portfolio before making further changes; your draft has not been overwritten.` : text, response.status);
  }
  return body as T;
}

export const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
export const api = {
  examples: () => request<{ examples: PortfolioInput[] }>('/examples'),
  portfolios: () => request<{ portfolios: SavedPortfolio[] }>('/portfolios'),
  search: (query: string, signal: AbortSignal) => request<{ results: SearchResult[] }>(`/assets/search?q=${encodeURIComponent(query)}`, { signal }),
  asset: (ticker: string, signal?: AbortSignal) => request<Asset>(`/assets/${encodeURIComponent(ticker)}`, { signal }),
  analyze: (body: AnalysisRequest, signal: AbortSignal) => request<Analysis>('/analyze', { method: 'POST', body: JSON.stringify(body), signal }),
  save: (body: PortfolioInput, current?: SavedPortfolio | null) => request<SavedPortfolio>(current ? `/portfolios/${encodeURIComponent(current.id)}` : '/portfolios', {
    method: current ? 'PUT' : 'POST',
    body: JSON.stringify(current ? { ...body, revision: current.revision } : body),
  }),
  remove: (portfolio: SavedPortfolio) => request<{ deleted: boolean }>(`/portfolios/${encodeURIComponent(portfolio.id)}?revision=${portfolio.revision}`, { method: 'DELETE' }),
  scenario: (baseline: PortfolioInput, scenario: PortfolioInput, benchmark: string, range: HistoryRange, signal: AbortSignal) =>
    request<ScenarioResponse>('/scenario', { method: 'POST', body: JSON.stringify({ baseline, scenario, benchmark, range }), signal }),
};

export const portfolioCopy = (value: PortfolioInput): PortfolioInput => ({
  name: value.name, base_currency: value.base_currency, holdings: value.holdings.map(holding => ({ ...holding })),
});
export function validatePortfolio(value: PortfolioInput): string | null {
  if (!value.name.trim() || value.name.trim().length > 80) return 'Give this portfolio a name of 1–80 characters.';
  if (!value.holdings.length || value.holdings.length > 20) return 'Add between 1 and 20 distinct holdings.';
  if (value.holdings.some(h => !Number.isFinite(h.shares) || h.shares <= 0 || h.shares > 1e9)) return 'Each share quantity must be greater than zero and at most 1 billion. Fractional shares are welcome.';
  if (new Set(value.holdings.map(h => h.ticker)).size !== value.holdings.length) return 'Each ticker must appear only once. Edit its existing share quantity instead.';
  if (value.holdings.some(h => !validTicker(h.ticker))) return 'Use a valid ticker of at most 20 characters.';
  return null;
}
export const validTicker = (value: string) => /^[A-Z0-9][A-Z0-9.\-^=]{0,19}$/.test(value);
