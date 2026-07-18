type ClientDiagnosticLevel = 'warning' | 'error';
let productionReportCount = 0;

const isDevelopmentRuntime = (): boolean => {
  if (typeof process !== 'undefined' && process.env.NODE_ENV) return process.env.NODE_ENV !== 'production';
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
};

const normalizeError = (error: unknown): Record<string, string> => {
  if (!error || typeof error !== 'object') {
    return { message: typeof error === 'string' ? error : 'Unknown client error' };
  }

  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.message === 'string' ? { message: candidate.message } : {}),
  };
};

export function reportClientIssue(context: string, error: unknown, level: ClientDiagnosticLevel = 'error'): void {
  const details = normalizeError(error);
  if (!isDevelopmentRuntime()) {
    if (productionReportCount >= 5 || typeof window === 'undefined') return;
    productionReportCount += 1;
    void import('./commerceAnalytics').then(({ trackCommerceEvent }) => trackCommerceEvent('exception', {
      description: context.slice(0, 100),
      fatal: level === 'error',
    })).catch(() => undefined);
    void import('../security/appCheck').then(async ({ getAppCheckRequestHeaders }) => {
      const appCheckHeaders = await getAppCheckRequestHeaders();
      return fetch('/api/monitoring/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...appCheckHeaders },
        body: JSON.stringify({ context: context.slice(0, 100), name: details.name || 'Error', code: details.code || '' }),
        keepalive: true,
      });
    }).catch(() => undefined);
    return;
  }

  if (level === 'warning') {
    console.warn(`[${context}]`, details);
    return;
  }

  console.error(`[${context}]`, details);
}
