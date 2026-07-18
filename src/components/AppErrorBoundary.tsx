import { Component, ErrorInfo, ReactNode } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { reportClientIssue } from '../services/observability/clientDiagnostics';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export default class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  declare readonly props: Readonly<AppErrorBoundaryProps>;
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientIssue('app-render-failure', { name: error.name, message: error.message, componentStack: info.componentStack });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="zy-app-failure" aria-labelledby="app-failure-title">
        <span className="zy-app-failure__icon" aria-hidden="true"><ShieldAlert /></span>
        <p className="zy-section-eyebrow">Storefront recovery</p>
        <h1 id="app-failure-title">Zyro.lk needs a quick refresh.</h1>
        <p>Refresh the page to reconnect safely. Items saved by your browser will be restored automatically.</p>
        <button type="button" onClick={() => window.location.reload()}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh storefront
        </button>
      </main>
    );
  }
}
