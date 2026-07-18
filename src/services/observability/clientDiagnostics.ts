type ClientDiagnosticLevel = 'warning' | 'error';

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
  if (!isDevelopmentRuntime()) return;

  const details = normalizeError(error);
  if (level === 'warning') {
    console.warn(`[${context}]`, details);
    return;
  }

  console.error(`[${context}]`, details);
}
