import { useEffect, useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { useLens } from './state/store';
import { PAGES, useHashRoute, type Page } from './lib/hooks';
import { Header } from './components/TopBar';
import { ApertureMark } from './components/Logo';
import { Notice } from './components/ui';
import { BriefingPage } from './pages/Briefing';
import { HoldingsPage } from './pages/Holdings';
import { RiskPage } from './pages/Risk';
import { ScenariosPage } from './pages/Scenarios';
import { ImportPage } from './pages/Import';
import { MethodPage } from './pages/Method';

function PageView({ page, sub }: { page: Page; sub: string | null }) {
  switch (page) {
    case 'holdings':
      return <HoldingsPage />;
    case 'risk':
      return <RiskPage />;
    case 'scenarios':
      return <ScenariosPage />;
    case 'import':
      return <ImportPage tab={sub} />;
    case 'method':
      return <MethodPage />;
    default:
      return <BriefingPage />;
  }
}

function BootScreen() {
  return (
    <div className="boot" role="status">
      <ApertureMark size={40} className="boot__mark" />
      <p className="boot__text">Opening LENS…</p>
    </div>
  );
}

function BootError() {
  const { bootError, retryBoot } = useLens();
  return (
    <div className="page">
      <div className="boot-error">
        <h1 className="page-head__title" tabIndex={-1}>
          LENS could not start
        </h1>
        <Notice
          tone="error"
          live
          title="The settings could not be loaded from the LENS service"
          actions={
            <button type="button" className="button button--primary" onClick={retryBoot}>
              <RotateCcw size={14} aria-hidden="true" />
              Try again
            </button>
          }
        >
          <p>{bootError}</p>
          <p className="faint">LENS runs on this computer. Check that the service is running, then try again. No sample data is shown in its place.</p>
        </Notice>
      </div>
    </div>
  );
}

export default function App() {
  const { boot, announcement } = useLens();
  const route = useHashRoute();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    const label = PAGES.find(item => item.id === route.page)?.label ?? 'Briefing';
    document.title = `${label} · LENS`;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    const frame = window.requestAnimationFrame(() => {
      const heading = main.current?.querySelector<HTMLElement>('h1');
      (heading ?? main.current)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [route.page]);

  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={event => {
          event.preventDefault();
          const heading = main.current?.querySelector<HTMLElement>('h1');
          (heading ?? main.current)?.focus();
        }}
      >
        Skip to content
      </a>
      <Header page={route.page} />
      <main id="main" ref={main} tabIndex={-1} className="main">
        {boot === 'loading' ? <BootScreen /> : boot === 'error' ? <BootError /> : <PageView page={route.page} sub={route.sub} />}
      </main>
      <footer className="footer">
        <div className="footer__inner">
          <span>LENS runs on this computer. Market data and news come from public Yahoo Finance endpoints and may be delayed or unavailable.</span>
          <span>Not investment advice.</span>
        </div>
      </footer>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </>
  );
}
