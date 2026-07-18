import { app } from '../../firebase';

let initialization: Promise<unknown> | null = null;

const siteKey = (): string => String((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_FIREBASE_APP_CHECK_SITE_KEY || '').trim();

async function getAppCheckInstance() {
  const key = siteKey();
  if (!key || typeof window === 'undefined') return null;
  if (!initialization) {
    initialization = import('firebase/app-check').then(({ ReCaptchaEnterpriseProvider, initializeAppCheck }) => (
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(key),
        isTokenAutoRefreshEnabled: true,
      })
    ));
  }
  return initialization;
}

export async function getAppCheckRequestHeaders(): Promise<Record<string, string>> {
  try {
    const instance = await getAppCheckInstance();
    if (!instance) return {};
    const { getToken } = await import('firebase/app-check');
    const result = await getToken(instance as Parameters<typeof getToken>[0], false);
    return result.token ? { 'X-Firebase-AppCheck': result.token } : {};
  } catch {
    return {};
  }
}

export async function initializeStorefrontAppCheck(): Promise<void> {
  await getAppCheckInstance();
}
