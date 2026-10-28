import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  Analysis,
  AnalysisRequest,
  AppConfig,
  Asset,
  Frequency,
  HistoryRange,
  HoldingInput,
  HoldingsNews,
  NewsStatus,
  PortfolioInput,
  SavedPortfolio,
  SectorBoard,
} from '../types';
import { api, ApiError, errorMessage, isAbort } from '../lib/api';
import { fmtWhen, sentence } from '../lib/format';
import {
  checkControls,
  checkPortfolio,
  copyPortfolio,
  copyRequest,
  emptyPortfolio,
  mergeHoldings,
  normalizeTicker,
  samePortfolio,
  uniqueName,
  weeklyAllowed,
} from '../lib/portfolio';

export type DraftSource = { kind: 'new' } | { kind: 'example'; index: number } | { kind: 'saved'; id: string; revision: number };

export interface Draft {
  portfolio: PortfolioInput;
  source: DraftSource;
}

export interface Controls {
  benchmark: string;
  range: HistoryRange;
  frequency: Frequency;
}

export interface Applied {
  id: number;
  request: AnalysisRequest;
  analysis: Analysis;
  hypothetical: boolean;
  appliedAt: number;
}

export interface Pending {
  id: number;
  request: AnalysisRequest;
  hypothetical: boolean;
  startedAt: number;
  refresh: boolean;
}

export interface AnalysisFailure {
  id: number;
  request: AnalysisRequest;
  hypothetical: boolean;
  message: string;
  at: number;
}

export interface HoldingsNewsState {
  appliedId: number;
  status: 'loading' | 'ready' | 'error';
  data: HoldingsNews | null;
  error: string | null;
}

export interface BoardState {
  data: SectorBoard | null;
  loading: boolean;
  loadError: string | null;
  status: NewsStatus | null;
  refreshing: boolean;
  note: string | null;
  refreshError: string | null;
}

export interface ImportNotice {
  count: number;
  mode: 'replace' | 'add';
  at: number;
}

export type Theme = 'dark' | 'light';

export interface ActionOutcome {
  ok: boolean;
  message: string;
  conflict?: boolean;
  missing?: boolean;
}

export interface LensContextValue {
  boot: 'loading' | 'ready' | 'error';
  bootError: string | null;
  config: AppConfig | null;
  examples: PortfolioInput[];
  examplesError: string | null;
  saved: SavedPortfolio[];
  savedError: string | null;
  draft: Draft;
  draftDirty: boolean;
  controls: Controls;
  applied: Applied | null;
  pending: Pending | null;
  failure: AnalysisFailure | null;
  holdingsNews: HoldingsNewsState | null;
  board: BoardState;
  assets: Record<string, Asset>;
  importNotice: ImportNotice | null;
  theme: Theme;
  announcement: string;

  retryBoot: () => void;
  setDraftPortfolio: (update: (portfolio: PortfolioInput) => PortfolioInput) => void;
  setControls: (update: Partial<Controls>) => void;
  apply: () => string[];
  refreshMarketData: () => void;
  retryAnalysis: () => void;
  cancelAnalysis: () => void;
  openSaved: (portfolio: SavedPortfolio, analyze: boolean) => void;
  openExample: (index: number, analyze: boolean) => void;
  startNew: () => void;
  save: (asCopy: boolean) => Promise<ActionOutcome>;
  remove: (portfolio: SavedPortfolio) => Promise<ActionOutcome>;
  reloadLibrary: () => Promise<SavedPortfolio[] | null>;
  reloadSavedVersion: (id: string) => Promise<ActionOutcome>;
  refreshNews: () => void;
  reloadBoard: () => void;
  rememberAssets: (assets: Asset[]) => void;
  importHoldings: (holdings: HoldingInput[], mode: 'replace' | 'add') => string | null;
  dismissImportNotice: () => void;
  toggleTheme: () => void;
  announce: (message: string) => void;
}

const LensContext = createContext<LensContextValue | null>(null);

export function useLens(): LensContextValue {
  const value = useContext(LensContext);
  if (!value) throw new Error('useLens must be used inside <LensProvider>.');
  return value;
}

function cleanPortfolio(portfolio: PortfolioInput): PortfolioInput {
  return {
    name: portfolio.name.trim(),
    base_currency: portfolio.base_currency,
    holdings: portfolio.holdings.map(holding => ({ ticker: normalizeTicker(holding.ticker), shares: holding.shares })),
  };
}

export function defaultControls(config: AppConfig | null): Controls {
  const ranges = config?.ranges ?? [];
  return {
    benchmark: config?.benchmarks[0]?.ticker ?? '',
    range: ranges.includes('1y') ? '1y' : (ranges[0] ?? '1y'),
    frequency: 'auto',
  };
}

function mostRecent(portfolios: SavedPortfolio[]): SavedPortfolio | null {
  if (!portfolios.length) return null;
  return [...portfolios].sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))[0];
}

const EMPTY_BOARD: BoardState = { data: null, loading: true, loadError: null, status: null, refreshing: false, note: null, refreshError: null };

function readTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function LensProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<'loading' | 'ready' | 'error'>('loading');
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [examples, setExamples] = useState<PortfolioInput[]>([]);
  const [examplesError, setExamplesError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedPortfolio[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ portfolio: emptyPortfolio('USD'), source: { kind: 'new' } });
  const [controls, setControlsState] = useState<Controls>(defaultControls(null));
  const [applied, setApplied] = useState<Applied | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<AnalysisFailure | null>(null);
  const [holdingsNews, setHoldingsNews] = useState<HoldingsNewsState | null>(null);
  const [board, setBoard] = useState<BoardState>(EMPTY_BOARD);
  const [assets, setAssets] = useState<Record<string, Asset>>({});
  const [importNotice, setImportNotice] = useState<ImportNotice | null>(null);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [announcement, setAnnouncement] = useState('');

  const sequence = useRef(0);
  const analysisController = useRef<AbortController | null>(null);
  const newsController = useRef<AbortController | null>(null);
  const pollTimer = useRef<number | undefined>(undefined);
  const announceTimer = useRef<number | undefined>(undefined);

  const announce = useCallback((message: string) => {
    window.clearTimeout(announceTimer.current);
    setAnnouncement('');
    announceTimer.current = window.setTimeout(() => setAnnouncement(message), 60);
  }, []);

  const rememberAssets = useCallback((list: Asset[]) => {
    if (!list.length) return;
    setAssets(previous => {
      const next = { ...previous };
      for (const asset of list) next[asset.ticker] = asset;
      return next;
    });
  }, []);

  const loadHoldingsNews = useCallback((appliedId: number, analysis: Analysis) => {
    newsController.current?.abort();
    const controller = new AbortController();
    newsController.current = controller;
    setHoldingsNews({ appliedId, status: 'loading', data: null, error: null });
    api
      .holdingsNews(analysis.holdings.map(holding => ({ ticker: holding.ticker, name: holding.name })), controller.signal)
      .then(data => {
        if (!controller.signal.aborted) setHoldingsNews({ appliedId, status: 'ready', data, error: null });
      })
      .catch(error => {
        if (!isAbort(error) && !controller.signal.aborted) setHoldingsNews({ appliedId, status: 'error', data: null, error: errorMessage(error) });
      });
  }, []);

  const runAnalysis = useCallback(
    (request: AnalysisRequest, hypothetical: boolean, refresh = false) => {
      analysisController.current?.abort();
      const controller = new AbortController();
      analysisController.current = controller;
      const id = ++sequence.current;
      const frozen = copyRequest({ ...request, portfolio: cleanPortfolio(request.portfolio) });
      setFailure(null);
      setPending({ id, request: frozen, hypothetical, startedAt: Date.now(), refresh });
      api
        .analyze(refresh ? { ...frozen, refresh: true } : frozen, controller.signal)
        .then(analysis => {
          if (id !== sequence.current) return;
          analysisController.current = null;
          setPending(null);
          setApplied({ id, request: frozen, analysis, hypothetical, appliedAt: Date.now() });
          rememberAssets(analysis.holdings);
          loadHoldingsNews(id, analysis);
          announce(`Analysis ready for ${frozen.portfolio.name}.`);
        })
        .catch(error => {
          if (id !== sequence.current || isAbort(error)) return;
          analysisController.current = null;
          setPending(null);
          const message = errorMessage(error);
          setFailure({ id, request: frozen, hypothetical, message, at: Date.now() });
          announce(`Analysis failed. ${message}`);
        });
    },
    [announce, loadHoldingsNews, rememberAssets],
  );

  const cancelAnalysis = useCallback(() => {
    sequence.current += 1;
    analysisController.current?.abort();
    analysisController.current = null;
    setPending(null);
    announce('Analysis cancelled. The previous results are unchanged.');
  }, [announce]);

  // ---- Sector news board ------------------------------------------------------

  const pollStatus = useCallback(
    function poll() {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = window.setTimeout(() => {
        api
          .newsStatus()
          .then(status => {
            setBoard(previous => ({ ...previous, status }));
            if (status.refreshing) {
              poll();
              return undefined;
            }
            return api.sectorNews().then(data => {
              setBoard(previous => ({ ...previous, data, status, refreshing: false, loadError: null }));
              announce(status.last_error ? `News refresh finished with an error: ${status.last_error}` : 'Sector news updated.');
            });
          })
          .catch(error => {
            setBoard(previous => ({ ...previous, refreshing: false, refreshError: errorMessage(error) }));
          });
      }, 5000);
    },
    [announce],
  );

  const reloadBoard = useCallback(() => {
    setBoard(previous => ({ ...previous, loading: true }));
    api
      .sectorNews()
      .then(data => {
        setBoard(previous => ({ ...previous, data, loading: false, loadError: null, refreshing: previous.refreshing || data.refreshing }));
        if (data.refreshing) pollStatus();
      })
      .catch(error => setBoard(previous => ({ ...previous, loading: false, loadError: errorMessage(error) })));
  }, [pollStatus]);

  const refreshNews = useCallback(() => {
    setBoard(previous => ({ ...previous, refreshing: true, note: null, refreshError: null }));
    api
      .refreshNews()
      .then(result => {
        const status: NewsStatus = {
          refreshed_at: result.refreshed_at,
          next_refresh_at: result.next_refresh_at,
          refreshing: result.refreshing,
          last_error: result.last_error,
        };
        if (result.status === 'skipped') {
          const note = result.next_allowed_at
            ? sentence(`Skipped — next refresh available at ${fmtWhen(result.next_allowed_at)}`)
            : 'Skipped — news was refreshed recently.';
          setBoard(previous => ({ ...previous, refreshing: false, status, note }));
          announce(note);
          return;
        }
        setBoard(previous => ({ ...previous, status }));
        announce('Refreshing sector news. This can take a minute.');
        pollStatus();
      })
      .catch(error => {
        setBoard(previous => ({ ...previous, refreshing: false, refreshError: errorMessage(error) }));
      });
  }, [announce, pollStatus]);

  useEffect(() => () => window.clearTimeout(pollTimer.current), []);

  // ---- Start-up ----------------------------------------------------------------

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setBoot('loading');
    setBootError(null);
    Promise.allSettled([api.config(signal), api.examples(signal), api.portfolios(signal), api.sectorNews(signal)]).then(
      ([configResult, examplesResult, savedResult, boardResult]) => {
        if (signal.aborted) return;
        if (boardResult.status === 'fulfilled') {
          const data = boardResult.value;
          setBoard({ ...EMPTY_BOARD, data, loading: false, refreshing: data.refreshing });
          if (data.refreshing) pollStatus();
        } else {
          setBoard({ ...EMPTY_BOARD, loading: false, loadError: errorMessage(boardResult.reason) });
        }
        if (configResult.status === 'rejected') {
          setBootError(errorMessage(configResult.reason));
          setBoot('error');
          return;
        }
        const appConfig = configResult.value;
        setConfig(appConfig);
        const exampleList = examplesResult.status === 'fulfilled' ? examplesResult.value.examples : [];
        setExamples(exampleList);
        setExamplesError(examplesResult.status === 'rejected' ? errorMessage(examplesResult.reason) : null);
        const savedList = savedResult.status === 'fulfilled' ? savedResult.value.portfolios : [];
        setSaved(savedList);
        setSavedError(savedResult.status === 'rejected' ? errorMessage(savedResult.reason) : null);

        const startControls = defaultControls(appConfig);
        setControlsState(startControls);
        const latest = mostRecent(savedList);
        if (latest) {
          const portfolio = copyPortfolio(latest);
          setDraft({ portfolio, source: { kind: 'saved', id: latest.id, revision: latest.revision } });
          if (startControls.benchmark) runAnalysis({ portfolio, ...startControls }, false);
        } else if (exampleList.length) {
          const portfolio = copyPortfolio(exampleList[0]);
          setDraft({ portfolio, source: { kind: 'example', index: 0 } });
          if (startControls.benchmark) runAnalysis({ portfolio, ...startControls }, true);
        } else {
          setDraft({ portfolio: emptyPortfolio(appConfig.base_currencies[0] ?? 'USD'), source: { kind: 'new' } });
        }
        setBoot('ready');
      },
    );
    return () => controller.abort();
  }, [bootAttempt, pollStatus, runAnalysis]);

  useEffect(
    () => () => {
      analysisController.current?.abort();
      newsController.current?.abort();
    },
    [],
  );

  const retryBoot = useCallback(() => setBootAttempt(value => value + 1), []);

  // ---- Draft and controls --------------------------------------------------------

  const setDraftPortfolio = useCallback((update: (portfolio: PortfolioInput) => PortfolioInput) => {
    setDraft(previous => ({ ...previous, portfolio: update(previous.portfolio) }));
  }, []);

  const setControls = useCallback((update: Partial<Controls>) => {
    setControlsState(previous => {
      const next = { ...previous, ...update };
      if (next.frequency === 'weekly' && !weeklyAllowed(next.range)) next.frequency = 'auto';
      return next;
    });
  }, []);

  const draftDirty = useMemo(() => {
    const source = draft.source;
    if (source.kind === 'saved') {
      const stored = saved.find(item => item.id === source.id);
      return !stored || !samePortfolio(stored, draft.portfolio);
    }
    if (source.kind === 'example') {
      const example = examples[source.index];
      return !example || !samePortfolio(example, draft.portfolio);
    }
    return draft.portfolio.holdings.length > 0;
  }, [draft, saved, examples]);

  /** Controls for an analysis started by switching portfolios: the selected controls when valid, else the applied ones. */
  const runnableControls = useCallback((): Controls => {
    if (!checkControls(controls, config).length) return controls;
    if (applied) return { benchmark: applied.request.benchmark, range: applied.request.range, frequency: applied.request.frequency };
    return defaultControls(config);
  }, [controls, config, applied]);

  const apply = useCallback((): string[] => {
    const problems = [...checkPortfolio(draft.portfolio, config).messages, ...checkControls(controls, config)];
    if (problems.length) return problems;
    runAnalysis({ portfolio: draft.portfolio, ...controls }, draft.source.kind === 'example');
    return [];
  }, [draft, controls, config, runAnalysis]);

  const refreshMarketData = useCallback(() => {
    if (applied) runAnalysis(applied.request, applied.hypothetical, true);
  }, [applied, runAnalysis]);

  const retryAnalysis = useCallback(() => {
    if (failure) runAnalysis(failure.request, failure.hypothetical);
  }, [failure, runAnalysis]);

  const openSaved = useCallback(
    (portfolio: SavedPortfolio, analyze: boolean) => {
      const copy = copyPortfolio(portfolio);
      setDraft({ portfolio: copy, source: { kind: 'saved', id: portfolio.id, revision: portfolio.revision } });
      if (analyze && checkPortfolio(copy, config).ok) {
        const next = runnableControls();
        setControlsState(next);
        runAnalysis({ portfolio: copy, ...next }, false);
      }
    },
    [config, runAnalysis, runnableControls],
  );

  const openExample = useCallback(
    (index: number, analyze: boolean) => {
      const example = examples[index];
      if (!example) return;
      const copy = copyPortfolio(example);
      setDraft({ portfolio: copy, source: { kind: 'example', index } });
      if (analyze && checkPortfolio(copy, config).ok) {
        const next = runnableControls();
        setControlsState(next);
        runAnalysis({ portfolio: copy, ...next }, true);
      }
    },
    [examples, config, runAnalysis, runnableControls],
  );

  const startNew = useCallback(() => {
    setDraft(previous => {
      const currencies = config?.base_currencies ?? [];
      const base = currencies.includes(previous.portfolio.base_currency) ? previous.portfolio.base_currency : (currencies[0] ?? 'USD');
      return { portfolio: emptyPortfolio(base), source: { kind: 'new' } };
    });
  }, [config]);

  // ---- Library -------------------------------------------------------------------

  const reloadLibrary = useCallback(async (): Promise<SavedPortfolio[] | null> => {
    try {
      const response = await api.portfolios();
      setSaved(response.portfolios);
      setSavedError(null);
      return response.portfolios;
    } catch (error) {
      setSavedError(errorMessage(error));
      return null;
    }
  }, []);

  const save = useCallback(
    async (asCopy: boolean): Promise<ActionOutcome> => {
      const check = checkPortfolio(draft.portfolio, config);
      if (!check.ok) return { ok: false, message: check.messages.join(' ') };
      const body = cleanPortfolio(draft.portfolio);
      const source = draft.source;
      try {
        let result: SavedPortfolio;
        if (source.kind === 'saved' && !asCopy) {
          result = await api.updatePortfolio(source.id, body, source.revision);
        } else {
          const name = asCopy ? uniqueName(body.name, saved.map(item => item.name)) : body.name;
          result = await api.createPortfolio({ ...body, name });
        }
        setSaved(previous => [result, ...previous.filter(item => item.id !== result.id)]);
        setDraft(previous => ({
          portfolio: samePortfolio(previous.portfolio, draft.portfolio) ? copyPortfolio(result) : previous.portfolio,
          source: { kind: 'saved', id: result.id, revision: result.revision },
        }));
        const message =
          source.kind === 'saved' && !asCopy ? `Saved “${result.name}” (revision ${result.revision}).` : `Saved “${result.name}” to this computer.`;
        announce(message);
        return { ok: true, message };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          return {
            ok: false,
            conflict: true,
            message:
              'This portfolio was changed in another window or tab since you opened it, so it was not overwritten. Reload the saved version, or keep your edits with “Save as copy”.',
          };
        }
        if (error instanceof ApiError && error.status === 404 && source.kind === 'saved') {
          return { ok: false, missing: true, message: 'This saved portfolio no longer exists on this computer. Use “Save as copy” to keep your draft.' };
        }
        return { ok: false, message: errorMessage(error) };
      }
    },
    [draft, config, saved, announce],
  );

  const remove = useCallback(
    async (portfolio: SavedPortfolio): Promise<ActionOutcome> => {
      try {
        await api.deletePortfolio(portfolio.id, portfolio.revision);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          return { ok: false, conflict: true, message: `“${portfolio.name}” was changed elsewhere, so it was not deleted. Reload the list and try again.` };
        }
        if (!(error instanceof ApiError && error.status === 404)) return { ok: false, message: errorMessage(error) };
      }
      setSaved(previous => previous.filter(item => item.id !== portfolio.id));
      setDraft(previous =>
        previous.source.kind === 'saved' && previous.source.id === portfolio.id ? { ...previous, source: { kind: 'new' } } : previous,
      );
      const message = `Deleted “${portfolio.name}”.`;
      announce(message);
      return { ok: true, message };
    },
    [announce],
  );

  const reloadSavedVersion = useCallback(
    async (id: string): Promise<ActionOutcome> => {
      const list = await reloadLibrary();
      if (!list) return { ok: false, message: 'The saved portfolios could not be reloaded. Try again.' };
      const latest = list.find(item => item.id === id);
      if (!latest) return { ok: false, missing: true, message: 'This portfolio no longer exists. Use “Save as copy” to keep your draft.' };
      openSaved(latest, false);
      return { ok: true, message: `Reloaded “${latest.name}” (revision ${latest.revision}).` };
    },
    [reloadLibrary, openSaved],
  );

  // ---- Imports -------------------------------------------------------------------

  const importHoldings = useCallback(
    (holdings: HoldingInput[], mode: 'replace' | 'add'): string | null => {
      const limit = config?.max_holdings ?? 20;
      const incoming = mergeHoldings(holdings);
      const next = mode === 'replace' ? incoming : mergeHoldings(draft.portfolio.holdings, incoming);
      if (!incoming.length) return 'Choose at least one row to import.';
      if (next.length > limit) {
        return `That would make ${next.length} holdings; a portfolio can hold at most ${limit}. Include fewer rows or replace the draft.`;
      }
      setDraft(previous => {
        const merged = mode === 'replace' ? incoming : mergeHoldings(previous.portfolio.holdings, incoming);
        if (mode === 'replace' && previous.source.kind === 'example') {
          return { portfolio: { name: 'Imported portfolio', base_currency: previous.portfolio.base_currency, holdings: merged }, source: { kind: 'new' } };
        }
        return { ...previous, portfolio: { ...previous.portfolio, holdings: merged } };
      });
      setImportNotice({ count: next.length, mode, at: Date.now() });
      return null;
    },
    [config, draft.portfolio.holdings],
  );

  const dismissImportNotice = useCallback(() => setImportNotice(null), []);

  const toggleTheme = useCallback(() => {
    setTheme(previous => {
      const next: Theme = previous === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      document.documentElement.style.colorScheme = next;
      try {
        window.localStorage.setItem('lens-theme', next);
      } catch {
        /* storage may be unavailable; the theme still applies for this visit */
      }
      return next;
    });
  }, []);

  const value = useMemo<LensContextValue>(
    () => ({
      boot,
      bootError,
      config,
      examples,
      examplesError,
      saved,
      savedError,
      draft,
      draftDirty,
      controls,
      applied,
      pending,
      failure,
      holdingsNews,
      board,
      assets,
      importNotice,
      theme,
      announcement,
      retryBoot,
      setDraftPortfolio,
      setControls,
      apply,
      refreshMarketData,
      retryAnalysis,
      cancelAnalysis,
      openSaved,
      openExample,
      startNew,
      save,
      remove,
      reloadLibrary,
      reloadSavedVersion,
      refreshNews,
      reloadBoard,
      rememberAssets,
      importHoldings,
      dismissImportNotice,
      toggleTheme,
      announce,
    }),
    [
      boot,
      bootError,
      config,
      examples,
      examplesError,
      saved,
      savedError,
      draft,
      draftDirty,
      controls,
      applied,
      pending,
      failure,
      holdingsNews,
      board,
      assets,
      importNotice,
      theme,
      announcement,
      retryBoot,
      setDraftPortfolio,
      setControls,
      apply,
      refreshMarketData,
      retryAnalysis,
      cancelAnalysis,
      openSaved,
      openExample,
      startNew,
      save,
      remove,
      reloadLibrary,
      reloadSavedVersion,
      refreshNews,
      reloadBoard,
      rememberAssets,
      importHoldings,
      dismissImportNotice,
      toggleTheme,
      announce,
    ],
  );

  return <LensContext.Provider value={value}>{children}</LensContext.Provider>;
}

/** Holdings news for the applied analysis only (never news from an older analysis). */
export function useAppliedNews(): HoldingsNewsState | null {
  const { applied, holdingsNews } = useLens();
  if (!applied || !holdingsNews || holdingsNews.appliedId !== applied.id) return null;
  return holdingsNews;
}
