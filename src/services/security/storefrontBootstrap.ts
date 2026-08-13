export class AppCheckBootstrapError extends Error {
  constructor(cause: unknown) {
    super('Firebase App Check bootstrap failed.', { cause });
    this.name = 'AppCheckBootstrapError';
  }
}

export async function loadProtectedStorefront<T>(
  initializeAppCheck: () => Promise<void>,
  loadApplication: () => Promise<T>,
): Promise<T> {
  try {
    await initializeAppCheck();
  } catch (error) {
    throw new AppCheckBootstrapError(error);
  }
  return loadApplication();
}
