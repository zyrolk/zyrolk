import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import AppErrorBoundary from './components/AppErrorBoundary.tsx';
import './index.css';
import { initializeStorefrontAppCheck } from './services/security/appCheck.ts';
import { initializeStorefrontMonitoring } from './services/observability/commerceAnalytics.ts';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root element is unavailable.');

void initializeStorefrontAppCheck();
void initializeStorefrontMonitoring();

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
