import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowRight, CircleStop, ClipboardPaste, FilePlus2, ImageUp, Play, RotateCcw, Save, CopyPlus, ShieldCheck, Trash2, X } from 'lucide-react';
import type { HoldingInput, SavedPortfolio, ScreenshotCandidate, ScreenshotImport as ScreenshotResult, ScreenshotRow } from '../types';
import { useLens, type ActionOutcome } from '../state/store';
import { api, ApiError, errorMessage, isAbort } from '../lib/api';
import { navigate, setSticky, useElapsedSeconds, useElementSize, useNow, useSticky } from '../lib/hooks';
import { fmtDate, fmtTime, isNum, num, percent, plural, quantity, quoteNumber, relative, sentence } from '../lib/format';
import { NAME_LIMIT, checkPortfolio, parseQuantity, quantityProblem, quantityText, roundShares } from '../lib/portfolio';
import { PageHeader } from '../components/page';
import { Badge, ConfirmDialog, FieldMessage, KeyValue, Notice, Panel, ScrollRegion, Spinner, Tabs, Tip, cx, panelId, tabId } from '../components/ui';
import { TickerSearch } from '../components/TickerSearch';
import { HoldingsEditor } from '../components/HoldingsEditor';

type ImportTab = 'screenshot' | 'manual';

export function ImportPage({ tab }: { tab: string | null }) {
  const active: ImportTab = tab === 'manual' ? 'manual' : 'screenshot';
  return (
    <div className="page import">
      <PageHeader title="Import" meta="Bring holdings in from a screenshot or enter them by hand. Nothing is analyzed or saved until you choose to." />
      <Tabs<ImportTab>
        label="Import method"
        idBase="import"
        className="import__tabs"
        value={active}
        onChange={next => navigate('import', next)}
        items={[
          { id: 'screenshot', label: 'Screenshot' },
          { id: 'manual', label: 'Manual' },
        ]}
      />
      <div role="tabpanel" id={panelId('import', active)} aria-labelledby={tabId('import', active)} className="import__panel">
        {active === 'screenshot' ? <ScreenshotTab /> : <ManualTab />}
      </div>
    </div>
  );
}

// =============================================================================================
// Screenshot
// =============================================================================================

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
/** Non-standard labels some systems give the accepted formats. */
const TYPE_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
  ['image/x-ms-bmp', 'image/bmp'],
  ['image/x-bmp', 'image/bmp'],
]);
/** Used only when a dropped or picked file arrives without a type. */
const EXTENSION_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['jpe', 'image/jpeg'],
  ['jfif', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['dib', 'image/bmp'],
  ['gif', 'image/gif'],
]);
const MAX_BYTES = 8 * 1024 * 1024;
const SEARCH_OPTION = '__search__';
const SHOT_KEY = 'import-screenshot';
const PRIVACY = 'Processed on this computer — the image is not stored or uploaded anywhere.';

interface RowChoice {
  include: boolean;
  ticker: string | null;
  quantityText: string;
  extra: ScreenshotCandidate[];
}

interface ShotError {
  title: string;
  message: string;
  /** Whether sending the same image again can help (connection or service trouble, not a rejected image). */
  retry: boolean;
}

interface ShotState {
  file: File | null;
  status: 'idle' | 'reading' | 'ready' | 'error' | 'cancelled';
  startedAt: number | null;
  result: ScreenshotResult | null;
  error: ShotError | null;
  choices: Record<string, RowChoice>;
  selected: string | null;
  mode: 'replace' | 'add';
  applyError: string | null;
}

const EMPTY_SHOT: ShotState = {
  file: null,
  status: 'idle',
  startedAt: null,
  result: null,
  error: null,
  choices: {},
  selected: null,
  mode: 'replace',
  applyError: null,
};

let shotController: AbortController | null = null;
let shotSequence = 0;

function rowQuantity(choice: RowChoice): number {
  return parseQuantity(choice.quantityText);
}

function rowBlocker(choice: RowChoice): string | null {
  if (!choice.ticker) return 'Choose a security to include this row.';
  const problem = quantityProblem(rowQuantity(choice), choice.quantityText);
  if (problem) return choice.quantityText.trim() ? problem : 'Enter a quantity to include this row.';
  return null;
}

function initialChoice(row: ScreenshotRow): RowChoice {
  const choice: RowChoice = {
    include: false,
    ticker: row.selected_ticker,
    quantityText: isNum(row.quantity) ? quantityText(row.quantity) : '',
    extra: [],
  };
  choice.include = rowBlocker(choice) === null && row.check.status !== 'inconsistent';
  return choice;
}

function screenshotError(error: unknown): ShotError {
  if (error instanceof ApiError) {
    const said = error.fromService ? sentence(error.message) : null;
    switch (error.status) {
      case 413:
        return { title: 'The image is too large', message: said ?? 'Screenshots must be 8 MB or smaller.', retry: false };
      case 415:
        return { title: 'This file type is not supported', message: said ?? 'Use a PNG, JPEG, WebP, BMP or GIF image.', retry: false };
      case 422:
        return { title: 'The screenshot could not be read', message: said ?? 'The file is not a readable PNG, JPEG, WebP, BMP or GIF image.', retry: false };
      case 503:
        return { title: 'Screenshot reading is unavailable right now', message: said ?? 'The text-recognition engine on this computer is not available.', retry: true };
    }
  }
  return { title: 'The screenshot could not be read', message: errorMessage(error), retry: true };
}

function readScreenshot(file: File) {
  shotController?.abort();
  const controller = new AbortController();
  shotController = controller;
  const id = ++shotSequence;
  setSticky<ShotState>(SHOT_KEY, previous => ({
    ...EMPTY_SHOT,
    mode: previous.mode,
    file,
    status: 'reading',
    startedAt: Date.now(),
  }));
  api
    .importScreenshot(file, controller.signal)
    .then(result => {
      if (id !== shotSequence) return;
      shotController = null;
      const choices = Object.fromEntries(result.rows.map(row => [row.id, initialChoice(row)]));
      setSticky<ShotState>(SHOT_KEY, previous => ({ ...previous, status: 'ready', startedAt: null, result, choices, selected: result.rows[0]?.id ?? null }));
    })
    .catch(error => {
      if (id !== shotSequence || isAbort(error)) return;
      shotController = null;
      setSticky<ShotState>(SHOT_KEY, previous => ({ ...previous, status: 'error', startedAt: null, error: screenshotError(error) }));
    });
}

function cancelReading() {
  shotSequence += 1;
  shotController?.abort();
  shotController = null;
  setSticky<ShotState>(SHOT_KEY, previous => ({ ...previous, status: 'cancelled', startedAt: null }));
}

function clearScreenshot() {
  shotSequence += 1;
  shotController?.abort();
  shotController = null;
  setSticky<ShotState>(SHOT_KEY, previous => ({ ...EMPTY_SHOT, mode: previous.mode }));
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${num(bytes, 0)} B`;
  if (bytes < 1024 * 1024) return `${num(bytes / 1024, 0)} KB`;
  return `${num(bytes / (1024 * 1024), 1)} MB`;
}

/** The accepted image type a file is uploaded as, or null when it is not a PNG, JPEG, WebP, BMP or GIF. */
function imageType(file: File): string | null {
  const declared = file.type.trim().toLowerCase();
  if (ACCEPTED.includes(declared)) return declared;
  const alias = TYPE_ALIASES.get(declared);
  if (alias) return alias;
  if (declared && declared !== 'application/octet-stream') return null;
  const ending = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return (ending && EXTENSION_TYPES.get(ending)) || null;
}

/** The file ready to upload (labelled with its accepted image type), or why it cannot be used. */
function prepareFile(file: File): { file: File } | { problem: string } {
  const type = imageType(file);
  if (!type) return { problem: `“${file.name || 'This file'}” is not a supported image. Use PNG, JPEG, WebP, BMP or GIF.` };
  if (file.size === 0) return { problem: 'This file is empty.' };
  if (file.size > MAX_BYTES) {
    const megabytes = file.size / (1024 * 1024);
    const amount = megabytes >= 8.05 ? `${num(megabytes, 1)} MB, which is over` : 'just over';
    return { problem: `This image is ${amount} the 8 MB limit. Crop or resize it, then try again.` };
  }
  return { file: type === file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified }) };
}

function extension(type: string): string {
  return type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
}

function ScreenshotTab() {
  const [state] = useSticky<ShotState>(SHOT_KEY, () => EMPTY_SHOT);
  const [reject, setReject] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const accept = useCallback((candidate: File) => {
    const prepared = prepareFile(candidate);
    if ('problem' in prepared) {
      setReject(prepared.problem);
      return;
    }
    setReject(null);
    readScreenshot(prepared.file);
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (!blob) continue;
          event.preventDefault();
          accept(blob.name ? blob : new File([blob], `pasted.${extension(blob.type)}`, { type: blob.type }));
          return;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [accept]);

  const pasteFromClipboard = async () => {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      setReject('This browser does not let the page read images from the clipboard. Press Ctrl+V (⌘V on a Mac) to paste instead.');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(entry => entry.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          accept(new File([blob], `clipboard.${extension(type)}`, { type }));
          return;
        }
      }
      setReject('The clipboard does not contain an image. Copy a screenshot first, then try again.');
    } catch {
      setReject('The browser blocked clipboard access. Press Ctrl+V (⌘V on a Mac) to paste instead.');
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) accept(file);
  };

  const picker = (
    <input
      ref={fileInput}
      type="file"
      accept={ACCEPTED.join(',')}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) accept(file);
      }}
    />
  );

  const sourceButtons = (
    <>
      <button type="button" className="button button--primary" onClick={() => fileInput.current?.click()}>
        <ImageUp size={14} aria-hidden="true" />
        {state.file ? 'Choose another image' : 'Choose image'}
      </button>
      <button type="button" className="button" onClick={pasteFromClipboard}>
        <ClipboardPaste size={14} aria-hidden="true" />
        Paste from clipboard
      </button>
    </>
  );

  const rejectNotice = reject && (
    <Notice tone="error" title="That image was not used" live onDismiss={() => setReject(null)}>
      {reject}
    </Notice>
  );

  if (!state.file) {
    return (
      <div className="shot">
        {picker}
        {rejectNotice}
        <section
          className={cx('dropzone', dragging && 'is-dragging')}
          aria-label="Screenshot drop zone"
          onDragEnter={event => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={event => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <ImageUp size={28} aria-hidden="true" className="dropzone__icon" />
          <h2 className="dropzone__title">Drop a screenshot of your holdings</h2>
          <p className="dropzone__text">Or paste it with Ctrl+V (⌘V on a Mac). PNG, JPEG, WebP, BMP or GIF, up to 8 MB.</p>
          <div className="dropzone__actions">{sourceButtons}</div>
          <p className="dropzone__privacy">{PRIVACY}</p>
        </section>
        <ul className="shot-tips" role="list">
          <li>
            <span className="shot-tips__n">1</span>Crop to the positions table: ticker or name, quantity, and if possible price and value.
          </li>
          <li>
            <span className="shot-tips__n">2</span>Review every row. Suggestions are matched against listed securities, never assumed.
          </li>
          <li>
            <span className="shot-tips__n">3</span>Use the rows you confirm as the draft, then apply the analysis yourself.
          </li>
        </ul>
      </div>
    );
  }

  return (
    <div
      className="shot"
      onDragOver={event => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={onDrop}
    >
      {picker}
      {rejectNotice}
      <div className="shot-layout">
        <ShotImage state={state} sourceButtons={sourceButtons} />
        <div className="shot-side">
          <ShotStatus state={state} />
          {state.status === 'ready' && state.result && <ShotSummary result={state.result} />}
        </div>
      </div>
      {state.status === 'ready' && state.result && <ShotReview state={state} result={state.result} />}
    </div>
  );
}

function ShotImage({ state, sourceButtons }: { state: ShotState; sourceButtons: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const [imageRef, size] = useElementSize<HTMLImageElement>();
  const file = state.file;

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return undefined;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  const result = state.status === 'ready' ? state.result : null;
  const scale = result && brokenUrl !== url && result.image.width > 0 && size.width > 0 ? size.width / result.image.width : 0;
  const select = (id: string) => {
    setSticky<ShotState>(SHOT_KEY, previous => ({ ...previous, selected: id }));
    document.getElementById(`shot-row-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  return (
    <Panel
      className="shot-image"
      title="Screenshot"
      meta={file ? `${file.name || 'Pasted image'} · ${fileSize(file.size)}${result ? ` · ${result.image.width} × ${result.image.height} px` : ''}` : undefined}
      actions={
        <button type="button" className="icon-button" onClick={clearScreenshot} aria-label="Remove this screenshot and start over" title="Remove this screenshot">
          <X size={16} aria-hidden="true" />
        </button>
      }
    >
      <div className="shot-image__stage">
        {url && brokenUrl !== url && (
          <img ref={imageRef} src={url} alt="The screenshot being imported" className="shot-image__img" onError={() => setBrokenUrl(url)} />
        )}
        {url && brokenUrl === url && <p className="shot-image__broken">This browser cannot display a preview of this file.</p>}
        {result && scale > 0 && (
          <div className="shot-image__overlay" aria-hidden="true">
            {result.rows.map(row => {
              const choice = state.choices[row.id];
              const review = !choice || rowBlocker(choice) !== null || row.check.status !== 'consistent';
              return (
                <button
                  key={row.id}
                  type="button"
                  tabIndex={-1}
                  className={cx('shot-box', review ? 'shot-box--review' : 'shot-box--ok', state.selected === row.id && 'is-selected', choice && !choice.include && 'is-excluded')}
                  style={{ left: row.box.x * scale, top: row.box.y * scale, width: Math.max(4, row.box.width * scale), height: Math.max(4, row.box.height * scale) }}
                  onClick={() => select(row.id)}
                  title={row.line_text}
                />
              );
            })}
          </div>
        )}
      </div>
      <div className="shot-image__actions">{sourceButtons}</div>
      {result && (
        <p className="shot-legend">
          <span className="shot-legend__key shot-legend__key--selected" aria-hidden="true" /> Selected row
          <span className="shot-legend__key shot-legend__key--ok" aria-hidden="true" /> Consistent
          <span className="shot-legend__key shot-legend__key--review" aria-hidden="true" /> Needs review
        </p>
      )}
    </Panel>
  );
}

function ShotStatus({ state }: { state: ShotState }) {
  const elapsed = useElapsedSeconds(state.status === 'reading' ? state.startedAt : null);
  return (
    <div aria-live="polite">
      {state.status === 'reading' && (
        <div className="waiting waiting--inline">
          <div className="waiting__bar" aria-hidden="true" />
          <p className="waiting__title">
            <Spinner /> Reading the screenshot… <span aria-hidden="true">{elapsed > 0 ? `${elapsed} s` : ''}</span>
          </p>
          <p className="waiting__text">Text recognition and security matching usually take 5–20 seconds. {PRIVACY}</p>
          <div className="waiting__actions">
            <button type="button" className="button" onClick={cancelReading}>
              <CircleStop size={14} aria-hidden="true" />
              Cancel
            </button>
          </div>
        </div>
      )}
      {state.status === 'error' && state.error && (
        <Notice
          tone="error"
          title={state.error.title}
          actions={
            state.error.retry &&
            state.file && (
              <button type="button" className="button" onClick={() => state.file && readScreenshot(state.file)}>
                <RotateCcw size={14} aria-hidden="true" />
                Try again
              </button>
            )
          }
        >
          {state.error.message}
          {!state.error.retry && ' Choose another image to continue.'}
        </Notice>
      )}
      {state.status === 'cancelled' && (
        <Notice
          tone="info"
          title="Reading cancelled"
          actions={
            state.file && (
              <button type="button" className="button" onClick={() => state.file && readScreenshot(state.file)}>
                <Play size={14} aria-hidden="true" />
                Read this image
              </button>
            )
          }
        >
          Nothing was imported.
        </Notice>
      )}
    </div>
  );
}

const QUANTITY_SOURCE: Record<ScreenshotRow['quantity_source'], string> = {
  column: 'From the quantity column',
  value_check: 'Fits price × quantity ≈ value on this line',
  derived_from_value: 'Derived from value ÷ price — check it',
  single_number: 'Only number on the line — check it',
  none: 'No quantity found',
};

function candidateLabel(candidate: ScreenshotCandidate): string {
  return [candidate.ticker, candidate.exchange, candidate.currency, isNum(candidate.price) ? quoteNumber(candidate.price, candidate.currency) : null].filter(Boolean).join(' · ');
}

interface SearchState {
  rowId: string;
  status: 'searching' | 'resolving' | 'error';
  ticker: string | null;
  error: string | null;
}

function ShotSummary({ result }: { result: ScreenshotResult }) {
  return (
    <Panel className="shot-summary" title="What was found" meta={`${plural(result.rows.length, 'row')} recognised · read at ${fmtTime(result.processed_at)}`}>
      <KeyValue
        className="facts--compact shot-facts"
        items={[
          { label: 'Engine', value: result.engine },
          { label: 'Column headers', value: result.header_detected ? 'Detected' : 'Not detected — quantities inferred from each line' },
          { label: 'Currency', value: result.currency_hint ? `Amounts appear to be in ${result.currency_hint}` : 'No currency detected' },
        ]}
      />
      <p className="shot-facts__privacy">
        <ShieldCheck size={14} aria-hidden="true" />
        {PRIVACY}
      </p>
      {result.warnings.length > 0 && (
        <Notice tone="warn" title="Check these before using the rows">
          <ul className="plain-list" role="list">
            {result.warnings.map(warning => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
    </Panel>
  );
}

function ShotReview({ state, result }: { state: ShotState; result: ScreenshotResult }) {
  const { draft, importHoldings, rememberAssets, config } = useLens();
  const [search, setSearch] = useState<SearchState | null>(null);
  const lookup = useRef<AbortController | null>(null);
  const ids = useId();

  useEffect(() => () => lookup.current?.abort(), []);

  const update = (rowId: string, patch: Partial<RowChoice>) =>
    setSticky<ShotState>(SHOT_KEY, previous => {
      const current = previous.choices[rowId];
      if (!current) return previous;
      const next = { ...current, ...patch };
      if (!('include' in patch) && rowBlocker(current) !== null && rowBlocker(next) === null) next.include = true;
      return { ...previous, applyError: null, choices: { ...previous.choices, [rowId]: next } };
    });

  const resolveSearch = (rowId: string, ticker: string) => {
    lookup.current?.abort();
    const controller = new AbortController();
    lookup.current = controller;
    setSearch({ rowId, status: 'resolving', ticker, error: null });
    api
      .asset(ticker, controller.signal)
      .then(asset => {
        if (controller.signal.aborted) return;
        rememberAssets([asset]);
        const candidate: ScreenshotCandidate = {
          ticker: asset.ticker,
          name: asset.name,
          exchange: asset.exchange,
          currency: asset.currency,
          instrument: asset.instrument,
          price: asset.price,
          price_date: asset.price_date,
        };
        setSticky<ShotState>(SHOT_KEY, previous => {
          const current = previous.choices[rowId];
          if (!current) return previous;
          const extra = current.extra.some(item => item.ticker === candidate.ticker) ? current.extra : [...current.extra, candidate];
          const next: RowChoice = { ...current, extra, ticker: candidate.ticker };
          if (rowBlocker(current) !== null && rowBlocker(next) === null) next.include = true;
          return { ...previous, applyError: null, choices: { ...previous.choices, [rowId]: next } };
        });
        setSearch(null);
      })
      .catch(error => {
        if (isAbort(error) || controller.signal.aborted) return;
        setSearch({ rowId, status: 'error', ticker, error: errorMessage(error) });
      });
  };

  // Rows that will be used, combined by ticker.
  const combined = useMemo(() => {
    const totals = new Map<string, { shares: number; rows: number[] }>();
    result.rows.forEach((row, index) => {
      const choice = state.choices[row.id];
      if (!choice || !choice.include || rowBlocker(choice) !== null || !choice.ticker) return;
      const entry = totals.get(choice.ticker) ?? { shares: 0, rows: [] };
      entry.shares = roundShares(entry.shares + rowQuantity(choice));
      entry.rows.push(index + 1);
      totals.set(choice.ticker, entry);
    });
    return totals;
  }, [result.rows, state.choices]);

  const holdings: HoldingInput[] = [...combined.entries()].map(([ticker, entry]) => ({ ticker, shares: entry.shares }));
  const includedRows = [...combined.values()].reduce((sum, entry) => sum + entry.rows.length, 0);
  const merges = [...combined.values()].filter(entry => entry.rows.length > 1).length;
  const limit = config?.max_holdings ?? 20;

  const use = () => {
    const error = importHoldings(holdings, state.mode);
    if (error) {
      setSticky<ShotState>(SHOT_KEY, previous => ({ ...previous, applyError: error }));
      return;
    }
    navigate('risk');
  };

  return (
    <>
      {result.rows.length === 0 ? (
        <Notice tone="info" title="No holdings rows were recognised">
          Try a tighter crop that shows the ticker or name and the quantity for each position, or enter the holdings on the Manual tab.
        </Notice>
      ) : (
        <Panel className="shot-table" title="Review rows" meta="Rows start unticked when the security, quantity or consistency check needs your attention." flush>
          <ScrollRegion label="Screenshot review rows" className="review__scroll">
            <table className="ledger ledger--review">
              <caption className="sr-only">Rows read from the screenshot. Choose the security and quantity for each row you want to use.</caption>
              <thead>
                <tr>
                  <th scope="col" className="review__include">
                    Use
                  </th>
                  <th scope="col">Detected text</th>
                  <th scope="col">Security</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Check</th>
                  <th scope="col" className="num">
                    Confidence
                  </th>
                  <th scope="col">Issues</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, index) => {
                  const choice = state.choices[row.id] ?? initialChoice(row);
                  const blocker = rowBlocker(choice);
                  const quantityIssue = choice.quantityText.trim() ? quantityProblem(rowQuantity(choice), choice.quantityText) : null;
                  const options = [...row.candidates, ...choice.extra.filter(extra => !row.candidates.some(candidate => candidate.ticker === extra.ticker))];
                  const orphan = choice.ticker && !options.some(option => option.ticker === choice.ticker) ? choice.ticker : null;
                  const merged = choice.ticker ? combined.get(choice.ticker) : undefined;
                  const searching = search?.rowId === row.id ? search : null;
                  const rowLabel = `row ${index + 1}`;
                  const blockerId = `${ids}-${row.id}-blocker`;
                  const qtyId = `${ids}-${row.id}-qty`;
                  return (
                    <tr
                      key={row.id}
                      id={`shot-row-${row.id}`}
                      className={cx(state.selected === row.id && 'is-selected', blocker && 'is-blocked')}
                      onClick={() => setSticky<ShotState>(SHOT_KEY, previous => (previous.selected === row.id ? previous : { ...previous, selected: row.id }))}
                      onFocusCapture={() => setSticky<ShotState>(SHOT_KEY, previous => (previous.selected === row.id ? previous : { ...previous, selected: row.id }))}
                    >
                      <td className="review__include">
                        <label className="review__check">
                          <input
                            type="checkbox"
                            className="checkbox"
                            checked={choice.include && !blocker}
                            disabled={Boolean(blocker)}
                            aria-label={`Use ${rowLabel}`}
                            aria-describedby={blocker ? blockerId : undefined}
                            onChange={event => update(row.id, { include: event.target.checked })}
                          />
                        </label>
                      </td>
                      <td className="review__text">
                        <span className="review__index">{index + 1}</span>
                        <span className="review__line" title={row.line_text}>
                          {row.line_text}
                        </span>
                        {(isNum(row.screenshot_price) || isNum(row.screenshot_value)) && (
                          <span className="review__figures">
                            {isNum(row.screenshot_price) && <>Price {num(row.screenshot_price, 4, 2)}</>}
                            {isNum(row.screenshot_price) && isNum(row.screenshot_value) && ' · '}
                            {isNum(row.screenshot_value) && <>Value {num(row.screenshot_value, 2)}</>}
                          </span>
                        )}
                        {blocker && (
                          <FieldMessage id={blockerId} tone="hint">
                            {blocker}
                          </FieldMessage>
                        )}
                      </td>
                      <td className="review__security" data-label="Security">
                        <select
                          className={cx('input select', !choice.ticker && 'is-invalid')}
                          aria-label={`Security for ${rowLabel}`}
                          value={choice.ticker ?? ''}
                          onChange={event => {
                            const value = event.target.value;
                            if (value === SEARCH_OPTION) {
                              setSearch({ rowId: row.id, status: 'searching', ticker: null, error: null });
                              return;
                            }
                            update(row.id, { ticker: value || null });
                          }}
                        >
                          <option value="">{options.length ? 'Choose a security…' : 'No match — search…'}</option>
                          {options.map(option => (
                            <option key={option.ticker} value={option.ticker}>
                              {candidateLabel(option)}
                            </option>
                          ))}
                          {orphan && <option value={orphan}>{orphan}</option>}
                          <option value={SEARCH_OPTION}>Search another…</option>
                        </select>
                        {choice.ticker && (
                          <span className="review__name">{options.find(option => option.ticker === choice.ticker)?.name ?? row.detected_name ?? ''}</span>
                        )}
                        {searching && (
                          <div className="review__search">
                            {searching.status === 'resolving' ? (
                              <p className="loading-line">
                                <Spinner /> Looking up <span className="mono">{searching.ticker}</span>…
                              </p>
                            ) : (
                              <TickerSearch
                                label={`Search for the security in ${rowLabel}`}
                                hideLabel
                                autoFocus
                                placeholder="Ticker or company"
                                onPick={ticker => resolveSearch(row.id, ticker)}
                              />
                            )}
                            {searching.status === 'error' && <FieldMessage>{`${searching.ticker ?? 'That ticker'} could not be used: ${searching.error}`}</FieldMessage>}
                            <button
                              type="button"
                              className="button button--quiet button--small"
                              onClick={() => {
                                lookup.current?.abort();
                                setSearch(null);
                              }}
                            >
                              Cancel search
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="review__qty" data-label="Quantity">
                        <input
                          id={qtyId}
                          className={cx('input input--num', (quantityIssue || !choice.quantityText.trim()) && 'is-invalid')}
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          aria-label={`Quantity for ${rowLabel}`}
                          aria-invalid={quantityIssue ? true : undefined}
                          value={choice.quantityText}
                          onChange={event => update(row.id, { quantityText: event.target.value })}
                        />
                        <span className="review__hint">{QUANTITY_SOURCE[row.quantity_source]}</span>
                        {quantityIssue && <FieldMessage>{quantityIssue}</FieldMessage>}
                        {merged && merged.rows.length > 1 && choice.include && !blocker && (
                          <span className="review__merge">
                            Combined with row {merged.rows.filter(entry => entry !== index + 1).join(', ')}: {quantity(merged.shares)} in total
                          </span>
                        )}
                      </td>
                      <td className="review__verdict" data-label="Check">
                        <CheckBadge row={row} choice={choice} />
                      </td>
                      <td className={cx('num review__confidence', row.confidence < 0.6 && 'review__low')} data-label="Confidence">
                        {percent(row.confidence, 0)}
                      </td>
                      <td className="review__issues" data-label="Issues">
                        {row.issues.length ? (
                          <ul className="plain-list" role="list">
                            {row.issues.map(issue => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="faint">None</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollRegion>
          {result.ignored_lines.length > 0 && (
            <details className="ignored">
              <summary>{plural(result.ignored_lines.length, 'line')} ignored (headers, totals or text without holdings)</summary>
              <ul className="ignored__list" role="list">
                {result.ignored_lines.map((line, index) => (
                  <li key={index} className="mono">
                    {line.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Panel>
      )}

      {result.rows.length > 0 && (
        <section className="shot-use" aria-labelledby={`${ids}-use`}>
          <h2 className="section-title" id={`${ids}-use`}>
            Use the confirmed rows
          </h2>
          <p className="shot-use__summary">
            {holdings.length ? (
              <>
                {plural(holdings.length, 'holding')} from {plural(includedRows, 'row')}
                {merges > 0 && ` (${plural(merges, 'ticker')} combined from duplicate rows)`}:{' '}
                <span className="shot-use__list">
                  {holdings.map(holding => (
                    <span key={holding.ticker} className="chip">
                      <span className="chip__ticker">{holding.ticker}</span>
                      <span className="chip__detail">{quantity(holding.shares)}</span>
                    </span>
                  ))}
                </span>
              </>
            ) : (
              'No rows are ticked yet.'
            )}
          </p>
          <fieldset className="choice">
            <legend className="field__label">Into the draft “{draft.portfolio.name || 'Untitled portfolio'}”</legend>
            <label className="choice__option">
              <input
                type="radio"
                name={`${ids}-mode`}
                checked={state.mode === 'replace'}
                onChange={() => setSticky<ShotState>(SHOT_KEY, previous => ({ ...previous, mode: 'replace', applyError: null }))}
              />
              <span>
                <span className="choice__title">Replace current draft</span>
                <span className="choice__text">The draft’s {plural(draft.portfolio.holdings.length, 'holding')} are replaced by these.</span>
              </span>
            </label>
            <label className="choice__option">
              <input
                type="radio"
                name={`${ids}-mode`}
                checked={state.mode === 'add'}
                onChange={() => setSticky<ShotState>(SHOT_KEY, previous => ({ ...previous, mode: 'add', applyError: null }))}
              />
              <span>
                <span className="choice__title">Add to current draft</span>
                <span className="choice__text">Matching tickers are merged by summing shares (maximum {limit} holdings).</span>
              </span>
            </label>
          </fieldset>
          {state.applyError && (
            <Notice tone="error" live>
              {state.applyError}
            </Notice>
          )}
          <div className="action-row">
            <button type="button" className="button button--primary" disabled={!holdings.length} onClick={use}>
              Use {plural(holdings.length, 'holding')}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
            <p className="action-row__note faint">Sets the draft only. Nothing is saved or analyzed until you apply it on the Risk page.</p>
          </div>
        </section>
      )}
    </>
  );
}

function CheckBadge({ row, choice }: { row: ScreenshotRow; choice: RowChoice }) {
  const changed = choice.ticker !== row.selected_ticker || !Object.is(rowQuantity(choice), isNum(row.quantity) ? roundShares(row.quantity) : Number.NaN);
  if (changed && row.check.status !== 'unverified') {
    const text = 'The screenshot check applied to the suggested security and quantity. Your edit has not been re-checked.';
    return (
      <>
        <Tip text={text} align="start">
          {describedBy => (
            <span className="tip__target" tabIndex={0} aria-describedby={describedBy}>
              <Badge tone="neutral">Edited</Badge>
            </span>
          )}
        </Tip>
        {/* Touch screens have no hover, so phones show the explanation inline (the tooltip already describes it to assistive tech). */}
        <span className="review__check-detail" aria-hidden="true">
          {text}
        </span>
      </>
    );
  }
  const tone = row.check.status === 'consistent' ? 'up' : row.check.status === 'inconsistent' ? 'down' : 'neutral';
  const label = row.check.status === 'consistent' ? 'Consistent' : row.check.status === 'inconsistent' ? 'Inconsistent' : 'Unverified';
  return (
    <>
      <Tip text={row.check.detail || label} align="start">
        {describedBy => (
          <span className="tip__target" tabIndex={0} aria-describedby={describedBy}>
            <Badge tone={tone}>{label}</Badge>
          </span>
        )}
      </Tip>
      {row.check.detail && (
        <span className="review__check-detail" aria-hidden="true">
          {row.check.detail}
        </span>
      )}
    </>
  );
}

// =============================================================================================
// Manual
// =============================================================================================

type OpenRequest = { kind: 'saved'; portfolio: SavedPortfolio } | { kind: 'example'; index: number } | { kind: 'new' };

function ManualTab() {
  const lens = useLens();
  const { draft, draftDirty, config, saved, savedError, examples, examplesError, setDraftPortfolio, save, remove, reloadLibrary, reloadSavedVersion, apply, openSaved, openExample, startNew } =
    lens;
  const ids = useId();
  const now = useNow(60_000);
  const check = checkPortfolio(draft.portfolio, config);
  const [showProblems, setShowProblems] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [busy, setBusy] = useState<'save' | 'copy' | 'reload' | null>(null);
  const [opening, setOpening] = useState<OpenRequest | null>(null);
  const [deleting, setDeleting] = useState<SavedPortfolio | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const source = draft.source;
  const sorted = useMemo(() => [...saved].sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0)), [saved]);
  const savedSource = source.kind === 'saved' ? saved.find(item => item.id === source.id) : undefined;

  const runSave = async (asCopy: boolean) => {
    setBusy(asCopy ? 'copy' : 'save');
    setOutcome(null);
    const result = await save(asCopy);
    setBusy(null);
    setOutcome(result);
    if (!result.ok && !result.conflict && !result.missing) setShowProblems(true);
  };

  const analyze = () => {
    const problems = apply();
    if (problems.length) {
      setShowProblems(true);
      setOutcome({ ok: false, message: problems.join(' ') });
      return;
    }
    navigate('risk');
  };

  const doOpen = (request: OpenRequest) => {
    setOutcome(null);
    setShowProblems(false);
    if (request.kind === 'saved') openSaved(request.portfolio, false);
    else if (request.kind === 'example') openExample(request.index, false);
    else startNew();
  };

  const requestOpen = (request: OpenRequest) => {
    if (draftDirty) setOpening(request);
    else doOpen(request);
  };

  const sourceLine =
    source.kind === 'saved' ? (
      <>
        Saved portfolio · revision {source.revision}
        {savedSource ? ` · updated ${relative(savedSource.updated_at, now)}` : ''}
        {draftDirty ? (
          <Badge tone="warn">Unsaved changes</Badge>
        ) : (
          <Badge tone="neutral">No unsaved changes</Badge>
        )}
      </>
    ) : source.kind === 'example' ? (
      <>
        <Badge tone="warn">Example — not your holdings</Badge> Saving creates your own copy on this computer.
      </>
    ) : (
      <>New portfolio · not saved yet</>
    );

  return (
    <div className="grid manual">
      <Panel className="col-8 col-wide-md" title="Draft portfolio" meta={sourceLine}>
        <div className="manual__fields">
          <div className="field manual__name">
            <label className="field__label" htmlFor={`${ids}-name`}>
              Name
            </label>
            <input
              id={`${ids}-name`}
              className={cx('input', showProblems && !draft.portfolio.name.trim() && 'is-invalid')}
              value={draft.portfolio.name}
              maxLength={NAME_LIMIT}
              autoComplete="off"
              onChange={event => {
                const name = event.target.value;
                setDraftPortfolio(portfolio => ({ ...portfolio, name }));
              }}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-base`}>
              Base currency
            </label>
            <select
              id={`${ids}-base`}
              className="input select"
              value={draft.portfolio.base_currency}
              onChange={event => {
                const base = event.target.value;
                setDraftPortfolio(portfolio => ({ ...portfolio, base_currency: base }));
              }}
            >
              {(config?.base_currencies ?? [draft.portfolio.base_currency]).map(currency => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </div>
        </div>
        <HoldingsEditor
          holdings={draft.portfolio.holdings}
          onChange={holdings => setDraftPortfolio(portfolio => ({ ...portfolio, holdings }))}
          rowErrors={check.rowErrors}
          maxHoldings={config?.max_holdings ?? 20}
          caption="Draft holdings"
        />
        {showProblems && check.messages.length > 0 && (
          <Notice tone="error" title="Before saving or analyzing" live>
            <ul className="plain-list" role="list">
              {check.messages.map(message => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Notice>
        )}
        {outcome && !(showProblems && !outcome.ok && !outcome.conflict && !outcome.missing && check.messages.length > 0) && (
          <Notice
            tone={outcome.ok ? 'success' : 'error'}
            live={!outcome.ok}
            onDismiss={() => setOutcome(null)}
            actions={
              outcome.conflict || outcome.missing ? (
                <>
                  {outcome.conflict && source.kind === 'saved' && (
                    <button type="button" className="button" onClick={() => setConfirmReload(true)} disabled={busy !== null}>
                      <RotateCcw size={14} aria-hidden="true" />
                      Reload saved version
                    </button>
                  )}
                  <button type="button" className="button" onClick={() => runSave(true)} disabled={busy !== null}>
                    <CopyPlus size={14} aria-hidden="true" />
                    Save as copy
                  </button>
                </>
              ) : undefined
            }
          >
            {outcome.message}
          </Notice>
        )}
        <div className="action-row action-row--split">
          <div className="row">
            <button
              type="button"
              className="button"
              onClick={() => runSave(false)}
              disabled={busy !== null || (source.kind === 'saved' && !draftDirty)}
              title={source.kind === 'saved' && !draftDirty ? 'No changes to save' : undefined}
            >
              {busy === 'save' ? <Spinner /> : <Save size={14} aria-hidden="true" />}
              {source.kind === 'saved' ? 'Save' : 'Save to this computer'}
            </button>
            {source.kind === 'saved' && (
              <button type="button" className="button" onClick={() => runSave(true)} disabled={busy !== null}>
                {busy === 'copy' ? <Spinner /> : <CopyPlus size={14} aria-hidden="true" />}
                Save as copy
              </button>
            )}
          </div>
          <button type="button" className="button button--primary" onClick={analyze}>
            <Play size={14} aria-hidden="true" />
            Analyze
          </button>
        </div>
      </Panel>

      <Panel
        className="col-4 col-wide-md library"
        title="Library"
        meta="Saved on this computer"
        actions={
          <button type="button" className="button button--small" onClick={() => requestOpen({ kind: 'new' })}>
            <FilePlus2 size={14} aria-hidden="true" />
            New portfolio
          </button>
        }
      >
        <h3 className="section-title">Your portfolios</h3>
        {savedError && (
          <Notice
            tone="error"
            title="Saved portfolios could not be loaded"
            actions={
              <button type="button" className="button button--small" onClick={() => void reloadLibrary()}>
                <RotateCcw size={14} aria-hidden="true" />
                Try again
              </button>
            }
          >
            {savedError}
          </Notice>
        )}
        {!savedError && sorted.length === 0 && <p className="faint library__empty">Nothing saved yet. Saved portfolios stay on this computer.</p>}
        {sorted.length > 0 && (
          <ul className="library__list" role="list">
            {sorted.map(portfolio => {
              const current = source.kind === 'saved' && source.id === portfolio.id;
              return (
                <li key={portfolio.id} className={cx('library__item', current && 'is-current')}>
                  <div className="library__text">
                    <p className="library__name">
                      {portfolio.name}
                      {current && <span className="sr-only"> (open in the editor)</span>}
                    </p>
                    <p className="library__meta">
                      {plural(portfolio.holdings.length, 'holding')} · {portfolio.base_currency} · updated {relative(portfolio.updated_at, now)}
                    </p>
                  </div>
                  <div className="library__actions">
                    <button
                      type="button"
                      className="button button--small"
                      onClick={() => requestOpen({ kind: 'saved', portfolio })}
                      disabled={current && !draftDirty}
                      title={current ? (draftDirty ? 'Discard edits and reopen the saved version' : 'Already open in the editor') : undefined}
                    >
                      {current ? 'Revert' : 'Open'}
                    </button>
                    <button
                      type="button"
                      className="icon-button icon-button--small"
                      aria-label={`Delete ${portfolio.name}`}
                      title="Delete"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleting(portfolio);
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <h3 className="section-title section-title--spaced">Examples</h3>
        {examplesError && <Notice tone="error" title="Examples could not be loaded">{examplesError}</Notice>}
        {!examplesError && examples.length === 0 && <p className="faint">No examples are available.</p>}
        {examples.length > 0 && (
          <ul className="library__list" role="list">
            {examples.map((example, index) => {
              const current = source.kind === 'example' && source.index === index;
              return (
                <li key={`${example.name}-${index}`} className={cx('library__item', current && 'is-current')}>
                  <div className="library__text">
                    <p className="library__name">{example.name}</p>
                    <p className="library__meta">
                      Example — not your holdings · {plural(example.holdings.length, 'holding')} · {example.base_currency}
                    </p>
                  </div>
                  <div className="library__actions">
                    <button type="button" className="button button--small" onClick={() => requestOpen({ kind: 'example', index })} disabled={current && !draftDirty}>
                      Open
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <ConfirmDialog
        open={opening !== null}
        title="Replace the draft?"
        confirmLabel="Replace draft"
        onCancel={() => setOpening(null)}
        onConfirm={() => {
          if (opening) doOpen(opening);
          setOpening(null);
        }}
      >
        <p>The draft has changes that are not saved. Opening another portfolio replaces them. The applied analysis is not affected.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmReload}
        title="Reload the saved version?"
        confirmLabel="Reload and discard my edits"
        danger
        busy={busy === 'reload'}
        onCancel={() => setConfirmReload(false)}
        onConfirm={async () => {
          if (source.kind !== 'saved') return;
          setBusy('reload');
          const result = await reloadSavedVersion(source.id);
          setBusy(null);
          setConfirmReload(false);
          setOutcome(result);
        }}
      >
        <p>This replaces your draft with the version saved most recently, including changes made in another window. Your current edits are discarded.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `Delete “${deleting.name}”?` : 'Delete portfolio?'}
        confirmLabel="Delete"
        danger
        busy={deleteBusy}
        error={deleteError}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          setDeleteBusy(true);
          setDeleteError(null);
          const result = await remove(deleting);
          setDeleteBusy(false);
          if (result.ok) {
            setDeleting(null);
            setOutcome(result);
          } else {
            setDeleteError(result.message);
            if (result.conflict) void reloadLibrary();
          }
        }}
      >
        <p>
          It is removed from this computer{deleting ? ` (revision ${deleting.revision}, updated ${fmtDate(deleting.updated_at)})` : ''}. The applied analysis and the draft stay as they are.
        </p>
      </ConfirmDialog>
    </div>
  );
}
