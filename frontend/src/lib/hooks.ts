import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

// ---- Element size -------------------------------------------------------------

export interface Size {
  width: number;
  height: number;
}

export function useElementSize<T extends Element>(): [(node: T | null) => void, Size, T | null] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    if (!node) return undefined;
    const update = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize(previous => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, size, node];
}

// ---- Media queries --------------------------------------------------------------

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', callback);
      return () => media.removeEventListener('change', callback);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');

// ---- Time -------------------------------------------------------------------

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useElapsedSeconds(startedAt: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

// ---- Hash routing ---------------------------------------------------------------

export type Page = 'briefing' | 'holdings' | 'risk' | 'scenarios' | 'import' | 'method';
export const PAGES: { id: Page; label: string }[] = [
  { id: 'briefing', label: 'Briefing' },
  { id: 'holdings', label: 'Holdings' },
  { id: 'risk', label: 'Risk' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'import', label: 'Import' },
  { id: 'method', label: 'Method' },
];

export interface Route {
  page: Page;
  sub: string | null;
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const known = PAGES.some(page => page.id === parts[0]);
  return { page: known ? (parts[0] as Page) : 'briefing', sub: known ? (parts[1] ?? null) : null };
}

export const hrefFor = (page: Page, sub?: string | null) => `#/${page}${sub ? `/${sub}` : ''}`;

export function navigate(page: Page, sub?: string | null) {
  const target = hrefFor(page, sub);
  if (window.location.hash !== target) window.location.hash = target;
}

const subscribeHash = (callback: () => void) => {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
};

export function useHashRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  return useMemo(() => parseHash(hash), [hash]);
}

// ---- Sticky page state (survives navigation between pages) -----------------------

const stickyValues = new Map<string, unknown>();
const stickyListeners = new Map<string, Set<() => void>>();

export function getSticky<T>(key: string): T | undefined {
  return stickyValues.get(key) as T | undefined;
}

export function setSticky<T>(key: string, update: T | ((previous: T) => T)) {
  const previous = stickyValues.get(key) as T;
  const next = typeof update === 'function' ? (update as (value: T) => T)(previous) : update;
  if (Object.is(previous, next)) return;
  stickyValues.set(key, next);
  stickyListeners.get(key)?.forEach(listener => listener());
}

export function useSticky<T>(key: string, initial: () => T): [T, (update: T | ((previous: T) => T)) => void] {
  if (!stickyValues.has(key)) stickyValues.set(key, initial());
  const subscribe = useCallback(
    (callback: () => void) => {
      let listeners = stickyListeners.get(key);
      if (!listeners) {
        listeners = new Set();
        stickyListeners.set(key, listeners);
      }
      listeners.add(callback);
      return () => {
        listeners?.delete(callback);
      };
    },
    [key],
  );
  const value = useSyncExternalStore(subscribe, () => stickyValues.get(key) as T);
  const set = useCallback((update: T | ((previous: T) => T)) => setSticky<T>(key, update), [key]);
  return [value, set];
}

// ---- Outside click ------------------------------------------------------------------

export function useOutsideClick(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void) {
  const latest = useLatest(onOutside);
  useEffect(() => {
    if (!active) return undefined;
    const handle = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) latest.current();
    };
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [active, ref, latest]);
}
