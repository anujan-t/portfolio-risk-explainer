import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Moon, Plus, Sun } from 'lucide-react';
import { useLens } from '../state/store';
import { PAGES, hrefFor, navigate, useNow, useOutsideClick, type Page } from '../lib/hooks';
import { fmtWhen, plural, relative } from '../lib/format';
import { samePortfolio } from '../lib/portfolio';
import { Logo } from './Logo';
import { ConfirmDialog, Tip, cx } from './ui';
import { TickerTape } from './TickerTape';

export function Header({ page }: { page: Page }) {
  const { pending } = useLens();
  const nav = useRef<HTMLElement>(null);

  // On narrow screens the nav is a horizontal scroller; keep the current page's link fully visible.
  useEffect(() => {
    const scroller = nav.current;
    const active = scroller?.querySelector<HTMLElement>('.topnav__link.is-active');
    if (!scroller || !active || scroller.scrollWidth <= scroller.clientWidth) return;
    const box = scroller.getBoundingClientRect();
    const link = active.getBoundingClientRect();
    if (link.left < box.left + 8) scroller.scrollLeft -= box.left + 8 - link.left;
    else if (link.right > box.right - 8) scroller.scrollLeft += link.right - (box.right - 8);
  }, [page]);

  return (
    <header className="masthead">
      <div className="topbar">
        <div className="topbar__inner">
          <a className="topbar__brand" href={hrefFor('briefing')} aria-label="LENS — go to Briefing">
            <Logo />
          </a>
          <nav className="topnav" aria-label="Primary" ref={nav}>
            <ul role="list" className="topnav__list">
              {PAGES.map(item => (
                <li key={item.id}>
                  <a className={cx('topnav__link', item.id === page && 'is-active')} href={hrefFor(item.id)} aria-current={item.id === page ? 'page' : undefined}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="topbar__tools">
            <PortfolioSwitcher />
            <NewsFreshness />
            <ThemeToggle />
          </div>
        </div>
      </div>
      <TickerTape />
      {pending && <div className="progress-line" role="progressbar" aria-label="Analysis in progress" aria-valuetext="Analysis in progress" />}
    </header>
  );
}

// ---- Portfolio switcher -------------------------------------------------------------------

interface MenuEntry {
  key: string;
  label: string;
  detail: string;
  checked: boolean;
  run: () => void;
  role: 'menuitemradio' | 'menuitem';
}

function PortfolioSwitcher() {
  const { draft, saved, examples, draftDirty, applied, openSaved, openExample, startNew, savedError, examplesError } = useLens();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ label: string; run: () => void } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useOutsideClick(wrapper, open, () => setOpen(false));

  const savedEntries = useMemo<MenuEntry[]>(
    () =>
      [...saved]
        .sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
        .map(portfolio => ({
          key: `saved:${portfolio.id}`,
          label: portfolio.name,
          detail: `${plural(portfolio.holdings.length, 'holding')} · ${portfolio.base_currency} · saved ${relative(portfolio.updated_at)}`,
          checked: draft.source.kind === 'saved' && draft.source.id === portfolio.id,
          run: () => openSaved(portfolio, true),
          role: 'menuitemradio' as const,
        })),
    [saved, draft.source, openSaved],
  );
  const exampleEntries = useMemo<MenuEntry[]>(
    () =>
      examples.map((example, index) => ({
        key: `example:${index}`,
        label: example.name,
        detail: `Example — not your holdings · ${plural(example.holdings.length, 'holding')} · ${example.base_currency}`,
        checked: draft.source.kind === 'example' && draft.source.index === index,
        run: () => openExample(index, true),
        role: 'menuitemradio' as const,
      })),
    [examples, draft.source, openExample],
  );
  const newEntry: MenuEntry = {
    key: 'new',
    label: 'New portfolio',
    detail: 'Start an empty draft in Import',
    checked: false,
    run: () => {
      startNew();
      navigate('import', 'manual');
    },
    role: 'menuitem',
  };
  const entries = [...savedEntries, ...exampleEntries, newEntry];

  const focusItem = (index: number) => {
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item]');
    if (!items?.length) return;
    items[(index + items.length) % items.length]?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const checkedIndex = entries.findIndex(entry => entry.checked);
    window.requestAnimationFrame(() => focusItem(checkedIndex >= 0 ? checkedIndex : 0));
    // Focus only when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (entry: MenuEntry) => {
    setOpen(false);
    button.current?.focus();
    const alreadyApplied = entry.checked && !draftDirty && applied && samePortfolio(applied.request.portfolio, draft.portfolio);
    if (alreadyApplied) return;
    if (draftDirty && entry.key !== 'new') {
      setConfirm({ label: entry.label, run: entry.run });
      return;
    }
    if (draftDirty && entry.key === 'new') {
      setConfirm({ label: 'a new portfolio', run: entry.run });
      return;
    }
    entry.run();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusItem(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(items.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const name = draft.portfolio.name.trim() || 'Untitled portfolio';
  const unapplied = !applied || !samePortfolio(applied.request.portfolio, draft.portfolio);
  const sourceNote = draft.source.kind === 'example' ? 'Example' : draft.source.kind === 'new' ? 'Draft' : null;

  const renderEntry = (entry: MenuEntry) => (
    <button
      key={entry.key}
      type="button"
      role={entry.role}
      aria-checked={entry.role === 'menuitemradio' ? entry.checked : undefined}
      data-menu-item=""
      tabIndex={-1}
      className={cx('menu__item', entry.checked && 'is-checked')}
      onClick={() => choose(entry)}
    >
      <span className="menu__check" aria-hidden="true">
        {entry.checked ? <Check size={14} /> : entry.key === 'new' ? <Plus size={14} /> : null}
      </span>
      <span className="menu__text">
        <span className="menu__label">{entry.label}</span>
        <span className="menu__detail">{entry.detail}</span>
      </span>
    </button>
  );

  return (
    <div className="switcher" ref={wrapper}>
      <button
        ref={button}
        type="button"
        className="switcher__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Portfolio: ${name}, base currency ${draft.portfolio.base_currency}${sourceNote ? `, ${sourceNote.toLowerCase()}` : ''}${unapplied ? ', not analyzed yet' : ''}. Switch portfolio`}
        onClick={() => setOpen(value => !value)}
      >
        {unapplied && <span className="switcher__pending" aria-hidden="true" title="This draft has not been analyzed yet" />}
        <span className="switcher__name">{name}</span>
        {sourceNote && <span className="switcher__tag">{sourceNote}</span>}
        <span className="switcher__ccy">{draft.portfolio.base_currency}</span>
        <ChevronDown size={14} aria-hidden="true" className="switcher__chevron" />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Switch portfolio" ref={menu} onKeyDown={onMenuKey}>
          <div role="group" aria-label="Saved on this computer" className="menu__group">
            <p className="menu__heading" aria-hidden="true">
              Saved on this computer
            </p>
            {savedEntries.length ? savedEntries.map(renderEntry) : <p className="menu__empty">{savedError ? `Saved portfolios could not be loaded: ${savedError}` : 'No saved portfolios yet.'}</p>}
          </div>
          <div role="group" aria-label="Examples, not your holdings" className="menu__group">
            <p className="menu__heading" aria-hidden="true">
              Examples — not your holdings
            </p>
            {exampleEntries.length ? exampleEntries.map(renderEntry) : <p className="menu__empty">{examplesError ? `Examples could not be loaded: ${examplesError}` : 'No examples available.'}</p>}
          </div>
          <div className="menu__group menu__group--end">{renderEntry(newEntry)}</div>
        </div>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title="Discard unsaved changes?"
        confirmLabel="Discard and open"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const action = confirm;
          setConfirm(null);
          action?.run();
        }}
      >
        <p>
          “{name}” has changes that are not saved. Opening {confirm?.label === 'a new portfolio' ? 'a new portfolio' : `“${confirm?.label ?? ''}”`} replaces them in the
          editor. Saved portfolios on this computer are not affected.
        </p>
      </ConfirmDialog>
    </div>
  );
}

// ---- News freshness ------------------------------------------------------------------------

function NewsFreshness() {
  const { board, config } = useLens();
  const now = useNow(60_000);
  const data = board.data;
  const status = board.status;
  const refreshedAt = status?.refreshed_at ?? data?.refreshed_at ?? null;
  const nextAt = status?.next_refresh_at ?? data?.next_refresh_at ?? null;
  const lastError = status?.last_error ?? data?.last_error ?? null;
  const refreshing = board.refreshing || Boolean(status?.refreshing ?? data?.refreshing);

  let tone: 'fresh' | 'stale' | 'error' | 'none' | 'busy';
  let text: string;
  if (board.loading && !data) {
    tone = 'none';
    text = 'Loading news status…';
  } else if (board.loadError && !data) {
    tone = 'error';
    text = `News is unavailable right now: ${board.loadError}`;
  } else if (refreshing) {
    tone = 'busy';
    text = 'Refreshing sector news…';
  } else if (!refreshedAt) {
    tone = lastError ? 'error' : 'none';
    text = lastError ? `News has not loaded yet: ${lastError}` : 'News has not been collected yet.';
  } else {
    const age = now - (Date.parse(refreshedAt) || now);
    const limit = (config?.news_refresh_hours ?? 6) * 3_600_000 * 1.5;
    tone = lastError ? 'error' : age > limit ? 'stale' : 'fresh';
    text = `News updated ${relative(refreshedAt, now)} (${fmtWhen(refreshedAt)})`;
    if (nextAt) text += ` · next refresh ${fmtWhen(nextAt)}`;
    if (lastError) text += ` · last refresh failed: ${lastError}`;
  }

  return (
    <Tip text={text} align="end" placement="below">
      {id => (
        <button
          type="button"
          className={cx('freshness', `freshness--${tone}`)}
          aria-describedby={id}
          aria-label="News freshness. Opens the sector desk."
          onClick={() => {
            navigate('briefing');
            window.setTimeout(() => document.getElementById('sector-desk')?.scrollIntoView({ block: 'start' }), 80);
          }}
        >
          <span className="freshness__dot" aria-hidden="true" />
          <span className="freshness__label">News</span>
        </button>
      )}
    </Tip>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useLens();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <Tip text={`Switch to ${next} theme`} align="end" placement="below">
      {id => (
        <button type="button" className="icon-button" onClick={toggleTheme} aria-label={`Switch to ${next} theme`} aria-describedby={id}>
          {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
        </button>
      )}
    </Tip>
  );
}
