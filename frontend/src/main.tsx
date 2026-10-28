import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LensProvider } from './state/store';
import App from './App';
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
