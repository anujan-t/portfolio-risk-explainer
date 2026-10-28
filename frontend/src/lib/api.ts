import type {
  Analysis,
  AnalysisRequest,
  AppConfig,
  Asset,
  AssetHistory,
  Frequency,
  HistoryRange,
  HoldingsNews,
  NewsStatus,
  PortfolioInput,
  SavedPortfolio,
  ScenarioResponse,
  ScreenshotImport,
  SearchResult,
  SectorBoard,
} from '../types';

export class ApiError extends Error {
  readonly status: number;
  /** True when the message is the service's own `detail` text rather than a generic description of the status. */
  readonly fromService: boolean;
  constructor(message: string, status: number, fromService = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fromService = fromService;
  }
}

export interface NewsRefreshResult extends NewsStatus {
  status: 'started' | 'skipped' | 'running';
  next_allowed_at: string | null;
}

export interface ScenarioRequest {
  baseline: PortfolioInput;
  scenario: PortfolioInput;
  benchmark: string;
  range: HistoryRange;
  frequency: Frequency;
  refresh?: boolean;
}

export function isAbort(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

function humanLocation(loc: unknown[]): string {
  return loc
    .filter(part => part !== 'body' && part !== 'query' && part !== 'path')
    .map(part => (typeof part === 'number' ? `#${part + 1}` : String(part).replaceAll('_', ' ')))
    .join(' › ');
}

function statusFallback(status: number): string {
  switch (status) {
    case 400: return 'The request was not accepted (400).';
    case 404: return 'The requested item was not found (404).';
    case 409: return 'This item was changed elsewhere (409).';
    case 413: return 'The file is too large for the service to accept (413).';
    case 422: return 'The request contained values the service could not accept (422).';
    case 429: return 'Too many requests. Wait a moment and try again (429).';
    case 502: return 'The market-data provider could not be reached (502).';
    case 503: return 'The service is temporarily unavailable (503).';
    case 504: return 'The service took too long to respond (504).';
    default: return status >= 500 ? `The LENS service hit an internal error (${status}).` : `The request failed (${status}).`;
  }
}

export function describeDetail(detail: unknown, status: number): string {
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail.length) {
    const parts = detail.map(item => {
      if (item && typeof item === 'object') {
        const record = item as { loc?: unknown; msg?: unknown };
        const where = Array.isArray(record.loc) ? humanLocation(record.loc) : '';
        const what = typeof record.msg === 'string' && record.msg ? record.msg : 'Invalid value';
        return where ? `${where}: ${what}` : what;
      }
      return String(item);
    });
    return parts.join(' · ');
  }
  if (detail && typeof detail === 'object' && 'message' in detail && typeof (detail as { message: unknown }).message === 'string') {
    return (detail as { message: string }).message;
  }
  return statusFallback(status);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  json?: unknown;
  /** A raw request body sent with its own content type (for example image bytes). */
  raw?: { body: Blob; type: string };
  signal?: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.raw) {
    headers['Content-Type'] = options.raw.type;
    body = options.raw.body;
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: options.method ?? 'GET', headers, body, signal: options.signal, cache: 'no-store' });
  } catch (error) {
    if (isAbort(error) || options.signal?.aborted) throw abortError();
    throw new ApiError('The LENS service on this computer could not be reached. Check that it is running, then try again.', 0);
  }
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    if (isAbort(error) || options.signal?.aborted) throw abortError();
    throw new ApiError('The response from the LENS service was interrupted. Please try again.', response.status);
  }
  if (options.signal?.aborted) throw abortError();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const detail = data && typeof data === 'object' && 'detail' in data ? (data as { detail: unknown }).detail : undefined;
    const message = describeDetail(detail, response.status);
    throw new ApiError(message, response.status, message !== statusFallback(response.status));
  }
  if (data === null || typeof data !== 'object') {
    throw new ApiError('The LENS service returned a response that could not be read.', response.status);
  }
  return data as T;
}

const segment = (value: string) => encodeURIComponent(value);

export const api = {
  config: (signal?: AbortSignal) => request<AppConfig>('/config', { signal }),
  examples: (signal?: AbortSignal) => request<{ examples: PortfolioInput[] }>('/examples', { signal }),
  portfolios: (signal?: AbortSignal) => request<{ portfolios: SavedPortfolio[] }>('/portfolios', { signal }),
  createPortfolio: (portfolio: PortfolioInput) => request<SavedPortfolio>('/portfolios', { method: 'POST', json: portfolio }),
  updatePortfolio: (id: string, portfolio: PortfolioInput, revision: number) =>
    request<SavedPortfolio>(`/portfolios/${segment(id)}`, { method: 'PUT', json: { ...portfolio, revision } }),
  deletePortfolio: (id: string, revision: number) =>
    request<{ deleted: boolean }>(`/portfolios/${segment(id)}?revision=${encodeURIComponent(String(revision))}`, { method: 'DELETE' }),
  search: (query: string, signal?: AbortSignal) => request<{ results: SearchResult[] }>(`/assets/search?q=${encodeURIComponent(query)}`, { signal }),
  asset: (ticker: string, signal?: AbortSignal) => request<Asset>(`/assets/${segment(ticker)}`, { signal }),
  history: (ticker: string, range: HistoryRange, signal?: AbortSignal) =>
    request<AssetHistory>(`/assets/${segment(ticker)}/history?range=${encodeURIComponent(range)}`, { signal }),
  analyze: (body: AnalysisRequest, signal?: AbortSignal) => request<Analysis>('/analyze', { method: 'POST', json: body, signal }),
  scenario: (body: ScenarioRequest, signal?: AbortSignal) => request<ScenarioResponse>('/scenario', { method: 'POST', json: body, signal }),
  sectorNews: (signal?: AbortSignal) => request<SectorBoard>('/news/sectors', { signal }),
  holdingsNews: (holdings: { ticker: string; name: string }[], signal?: AbortSignal) =>
    request<HoldingsNews>('/news/holdings', { method: 'POST', json: { holdings, refresh: false }, signal }),
  refreshNews: () => request<NewsRefreshResult>('/news/refresh', { method: 'POST' }),
  newsStatus: (signal?: AbortSignal) => request<NewsStatus>('/news/status', { signal }),
  /**
   * The image bytes are the whole request body, labelled with the image's own type (PNG, JPEG, WebP,
   * BMP or GIF; callers normalise the type first). No form wrapper and no file name are sent.
   */
  importScreenshot: (image: Blob, signal?: AbortSignal) =>
    request<ScreenshotImport>('/import/screenshot', { method: 'POST', raw: { body: image, type: image.type }, signal }),
};

/** Only http(s) URLs may be rendered as links. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
