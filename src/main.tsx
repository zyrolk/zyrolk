import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import './index.css';
import './styles/storefrontL6.css';
import './styles/storefrontL7.css';
import './styles/storefrontHeader.css';
import { initializeStorefrontAppCheck } from './services/security/appCheck.ts';
import { AppCheckBootstrapError, loadProtectedStorefront } from './services/security/storefrontBootstrap.ts';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Application root element is unavailable.');
const root = createRoot(rootElement);

root.render(
  <main className="zy-app-failure" aria-live="polite">
    <div className="zy-app-failure__card">
      <h1>Securing Zyro.lk</h1>
      <p>Verifying this browser before loading the store.</p>
    </div>
  </main>,
);

void loadProtectedStorefront(initializeStorefrontAppCheck, async () => {
  const [
    { default: App },
    { default: AppErrorBoundary },
    { initializeStorefrontMonitoring },
  ] = await Promise.all([
    import('./App.tsx'),
    import('./components/AppErrorBoundary.tsx'),
    import('./services/observability/commerceAnalytics.ts'),
  ]);

  void initializeStorefrontMonitoring();
  root.render(
    <StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </StrictMode>,
  );
}).catch((error: unknown) => {
  const appCheckFailed = error instanceof AppCheckBootstrapError;
  root.render(
    <main className="zy-app-failure" role="alert" aria-labelledby="bootstrap-failure-title">
      <div className="zy-app-failure__card">
        <h1 id="bootstrap-failure-title">
          {appCheckFailed ? 'Browser verification failed' : 'Zyro.lk could not load'}
        </h1>
        <p>
          {appCheckFailed
            ? 'Zyro.lk could not securely start. Check your connection and try again.'
            : 'The application could not start. Check your connection and try again.'}
        </p>
        <button type="button" onClick={() => window.location.reload()}>Try again</button>
      </div>
    </main>,
  );
});
