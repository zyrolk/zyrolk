export interface AIProviderStatus {
  readonly state: 'not-configured';
  readonly label: 'Not configured';
}

export const NOT_CONFIGURED_PROVIDER_STATUS: AIProviderStatus = Object.freeze({
  state: 'not-configured',
  label: 'Not configured',
});
