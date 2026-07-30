import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import AppErrorBoundary from './components/AppErrorBoundary.tsx';
import './index.css';
import './styles/storefrontL6.css';
import './styles/storefrontL7.css';
import './styles/storefrontHeader.css';
import { initializeStorefrontAppCheck } from './services/security/appCheck.ts';
import { initializeStorefrontMonitoring } from './services/observability/commerceAnalytics.ts';
import { reportClientIssue } from './services/observability/clientDiagnostics.ts';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root element is unavailable.');

void initializeStorefrontAppCheck().catch((error) => reportClientIssue('app-check-initialization-failed', error));
void initializeStorefrontMonitoring();

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
