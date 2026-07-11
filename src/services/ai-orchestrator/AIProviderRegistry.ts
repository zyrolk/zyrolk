import { AIProviderError, type AIProvider } from './contracts/AIProvider';

export class AIProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();

  register(provider: AIProvider): void {
    const id = provider.id.trim();
    if (!id) throw new AIProviderError('INVALID_REQUEST', 'Provider ID is required.');
    if (this.providers.has(id)) throw new AIProviderError('PROVIDER_ALREADY_REGISTERED', `Provider "${id}" is already registered.`);
    this.providers.set(id, provider);
  }

  unregister(providerId: string): boolean { return this.providers.delete(providerId); }
  listProviders(): readonly AIProvider[] { return Object.freeze([...this.providers.values()]); }
  getProvider(providerId: string): AIProvider | undefined { return this.providers.get(providerId); }
}
