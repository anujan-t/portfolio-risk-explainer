import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LensProvider } from './state/store';
import App from './App';
import '@fontsource/source-serif-4/latin-400.css';
import '@fontsource/source-serif-4/latin-400-italic.css';
import '@fontsource/source-serif-4/latin-600.css';
import '@fontsource/source-serif-4/latin-700.css';
import '@fontsource/source-sans-3/latin-400.css';
import '@fontsource/source-sans-3/latin-500.css';
import '@fontsource/source-sans-3/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/ui.css';
import './styles/ledger.css';
import './styles/charts.css';
import './styles/pages.css';

const root = document.getElementById('root');
if (!root) throw new Error('The #root element is missing from index.html.');

createRoot(root).render(
  <StrictMode>
    <LensProvider>
      <App />
    </LensProvider>
  </StrictMode>,
);
