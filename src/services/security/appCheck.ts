import { app, appCheckSiteKey } from '../../firebaseApp';

let initialization: Promise<unknown> | null = null;
let bootstrapVerification: Promise<void> | null = null;

export const isExactLocalAppCheckBypassHost = (value: string): boolean => {
  const hostname = value.trim().toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
};

const isExactLocalDevelopmentHost = (): boolean => (
  typeof window !== 'undefined' && isExactLocalAppCheckBypassHost(window.location.hostname)
);

async function getAppCheckInstance() {
  if (typeof window === 'undefined' || isExactLocalDevelopmentHost()) return null;
  if (!appCheckSiteKey) {
    throw new Error('Firebase App Check is not configured for this production build.');
  }
  if (!initialization) {
    initialization = import('firebase/app-check').then(({ ReCaptchaEnterpriseProvider, initializeAppCheck }) => (
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
        isTokenAutoRefreshEnabled: true,
      })
    ));
  }
  return initialization;
}

export async function getAppCheckRequestHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const instance = await getAppCheckInstance();
  if (!instance) return {};
  const { getToken } = await import('firebase/app-check');
  const result = await getToken(instance as Parameters<typeof getToken>[0], forceRefresh);
  if (!result.token) throw new Error('Firebase App Check did not issue a request token.');
  return { 'X-Firebase-AppCheck': result.token };
}

export async function initializeStorefrontAppCheck(): Promise<void> {
  if (!bootstrapVerification) {
    bootstrapVerification = (async () => {
      const instance = await getAppCheckInstance();
      if (!instance) return;
      const { getToken } = await import('firebase/app-check');
      const result = await getToken(instance as Parameters<typeof getToken>[0], false);
      if (!result.token) throw new Error('Firebase App Check did not issue a bootstrap token.');
    })();
  }
  await bootstrapVerification;
}
