import type { Analysis, HoldingsNews, NewsItem, SectorBoard } from '../types';
import type { HeldTicker } from '../components/News';

/** For each news item id, the held tickers it was collected for (heaviest first). */
export function heldTickersByItem(news: HoldingsNews, holdings: Analysis['holdings']): Map<string, HeldTicker[]> {
  const weights = new Map(holdings.map(holding => [holding.ticker, holding.weight]));
  const map = new Map<string, HeldTicker[]>();
  for (const [ticker, ids] of Object.entries(news.by_ticker)) {
    const weight = weights.get(ticker);
    if (weight === undefined) continue;
    for (const id of ids) {
      const list = map.get(id) ?? [];
      if (!list.some(entry => entry.ticker === ticker)) list.push({ ticker, weight });
      map.set(id, list);
    }
  }
  for (const list of map.values()) list.sort((a, b) => b.weight - a.weight);
  return map;
}

export function newsForTicker(news: HoldingsNews, ticker: string): NewsItem[] {
  const ids = new Set(news.by_ticker[ticker] ?? []);
  return news.items.filter(item => ids.has(item.id));
}

/**
 * A short preview that leads with the newest headline of as many different holdings as fit, then fills with the
 * newest remaining items; the result keeps the original newest-first order.
 */
export function previewNews(items: NewsItem[], held: Map<string, HeldTicker[]> | null, limit: number): NewsItem[] {
  if (items.length <= limit) return items;
  const chosen = new Set<string>();
  const covered = new Set<string>();
  for (const item of items) {
    if (chosen.size >= limit) break;
    const tickers = held?.get(item.id) ?? [];
    if (tickers.some(entry => !covered.has(entry.ticker))) {
      chosen.add(item.id);
      for (const entry of tickers) covered.add(entry.ticker);
    }
  }
  for (const item of items) {
    if (chosen.size >= limit) break;
    chosen.add(item.id);
  }
  return items.filter(item => chosen.has(item.id));
}

// Provider labels (Yahoo Finance) that may still arrive for holdings, mapped onto the shared sector names.
const PROVIDER_SECTOR: Record<string, string> = {
  technology: 'Information Technology',
  'information technology': 'Information Technology',
  'financial services': 'Financials',
  financial: 'Financials',
  financials: 'Financials',
  healthcare: 'Health Care',
  'health care': 'Health Care',
  'consumer cyclical': 'Consumer Discretionary',
  'consumer discretionary': 'Consumer Discretionary',
  'consumer defensive': 'Consumer Staples',
  'consumer staples': 'Consumer Staples',
  'basic materials': 'Materials',
  materials: 'Materials',
  'communication services': 'Communication Services',
  energy: 'Energy',
  industrials: 'Industrials',
  'real estate': 'Real Estate',
  utilities: 'Utilities',
};

/** The shared sector name for a holding's sector label, or the label itself when it is not a sector (e.g. funds). */
export function canonicalSector(label: string): string {
  return PROVIDER_SECTOR[label.trim().replace(/\s+/g, ' ').toLowerCase()] ?? label;
}

/** Exposure per shared sector name; provider labels that name the same sector are combined. */
export function sectorExposures(analysis: Analysis | null | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of analysis?.concentration.sector_exposures ?? []) {
    const name = canonicalSector(entry.sector);
    map.set(name, (map.get(name) ?? 0) + entry.weight);
  }
  return map;
}

/** Sector briefs with held sectors first (by exposure), then the rest in board order. */
export function orderSectors(board: SectorBoard | null, exposures: Map<string, number>) {
  const sectors = board?.sectors ?? [];
  const held = sectors.filter(sector => (exposures.get(sector.name) ?? 0) > 0).sort((a, b) => (exposures.get(b.name) ?? 0) - (exposures.get(a.name) ?? 0));
  const rest = sectors.filter(sector => !((exposures.get(sector.name) ?? 0) > 0));
  return { held, rest, all: [...held, ...rest] };
}

/** The latest close date across the board's sector proxies. */
export function boardCloseDate(board: SectorBoard | null): string | null {
  let latest: string | null = null;
  for (const sector of board?.sectors ?? []) {
    for (const move of [sector.us, sector.global]) {
      if (move?.as_of && (!latest || move.as_of > latest)) latest = move.as_of;
    }
  }
  return latest;
}

/** Whether any sector proxy move has been collected (the board lists all sectors even before the first refresh). */
export function boardHasMoves(board: SectorBoard | null): boolean {
  return (board?.sectors ?? []).some(sector => Boolean(sector.us || sector.global));
}

/** Whether anything at all (proxy moves or headlines) has been collected for the board. */
export function boardHasContent(board: SectorBoard | null): boolean {
  return boardHasMoves(board) || (board?.sectors ?? []).some(sector => sector.headlines.length > 0);
}

const SHORT_SECTOR: Record<string, string> = {
  'Communication Services': 'Communication',
  'Consumer Discretionary': 'Discretionary',
  'Consumer Staples': 'Staples',
  'Information Technology': 'Technology',
  'Health Care': 'Health care',
  'Real Estate': 'Real estate',
};

/** Compact sector label for dense rows; the full name stays available to assistive technology. */
export const shortSector = (name: string) => SHORT_SECTOR[name] ?? name;
