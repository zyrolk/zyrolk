import { adminDb } from "../firebase";
import { buildSupplierTargetUrl, getApprovedSupplierHosts, validateSupplierRequestTarget } from "../security/supplierUrlProtection";
import { SupplierOutboundPolicy } from "../security/supplierOutboundRequest";
import { A2ZSupplierConnector } from "./a2z/A2ZSupplierConnector";
import { HttpSupplierConnector } from "./HttpSupplierConnector";
import { normalizeSupplierSourceConfig } from "./supplierSourceCompatibility";
import {
  SupplierConnector,
  SupplierConnectorType,
  SupplierSourceConfig,
} from "./types";

type SupplierConnectorFactory = (targetUrl: string, source: SupplierSourceConfig, approvedHosts: string[]) => SupplierConnector;

const normalizePriority = (value: unknown): number => {
  const priority = Number(value);
  return Number.isFinite(priority) ? Math.max(0, Math.min(Math.floor(priority), 10_000)) : 100;
};

/**
 * First-class server-side supplier registry. New connectors register a factory;
 * the sync worker never needs connector-specific branching.
 */
export class SupplierRegistry {
  private static readonly connectorFactories = new Map<SupplierConnectorType, SupplierConnectorFactory>();

  public static registerConnectorFactory(type: SupplierConnectorType, factory: SupplierConnectorFactory): void {
    const normalized = String(type).trim().toLowerCase();
    if (!normalized) throw new Error("Supplier connector type is required.");
    if (this.connectorFactories.has(normalized)) throw new Error(`Supplier connector type "${normalized}" is already registered.`);
    this.connectorFactories.set(normalized, factory);
  }

  public static supportedConnectorTypes(): string[] {
    return [...this.connectorFactories.keys()].sort();
  }

  public static toSupplierSourceConfig(id: string, data: FirebaseFirestore.DocumentData): SupplierSourceConfig {
    return normalizeSupplierSourceConfig(id, data);
  }

  /** Canonical additive source record for admin provisioning and future connectors. */
  public static createRegistryRecord(source: Pick<SupplierSourceConfig,
    "supplierId" | "name" | "connectorType" | "enabled" | "priority" | "currency" | "timezone" | "syncSchedule" | "authentication" | "capabilities" | "websiteUrl" | "endpoint"
  >, nowIso = new Date().toISOString()): Record<string, unknown> {
    return {
      supplierId: source.supplierId,
      supplierName: source.name,
      connectorType: source.connectorType,
      sourceStatus: source.enabled ? "active" : "inactive",
      enabled: source.enabled,
      priority: normalizePriority(source.priority),
      currency: source.currency || "LKR",
      timezone: source.timezone || "Asia/Colombo",
      syncSchedule: source.syncSchedule || "Off",
      authentication: source.authentication,
      capabilities: [...new Set(source.capabilities)],
      websiteUrl: source.websiteUrl,
      endpoint: source.endpoint,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  public static async loadEnabledConnectors(enabledSupplierIds: string[] = []): Promise<SupplierConnector[]> {
    const sourcesSnap = await adminDb.collection("supplierSources").get();
    return this.createConnectorsForSources(sourcesSnap.docs.map((sourceDoc) => ({ id: sourceDoc.id, data: sourceDoc.data() })), enabledSupplierIds);
  }

  /** Builds connectors from the scheduler's already-paginated source page. */
  public static async createConnectorsForSources(
    records: ReadonlyArray<{ id: string; data: FirebaseFirestore.DocumentData }>,
    enabledSupplierIds: string[] = [],
  ): Promise<SupplierConnector[]> {
    const approvedHosts = await getApprovedSupplierHosts();
    const connectors: SupplierConnector[] = [];
    for (const record of records) {
      const source = this.toSupplierSourceConfig(record.id, record.data);
      if (!source.enabled || !source.websiteUrl || (enabledSupplierIds.length > 0 && !enabledSupplierIds.includes(source.id))) continue;
      try {
        const validatedTarget = await validateSupplierRequestTarget(source.websiteUrl, source.endpoint, approvedHosts);
        connectors.push(this.createConnector(validatedTarget.targetUrl, source, approvedHosts));
      } catch {
        // The scheduler persists this source's independently classified failure.
      }
    }
    return connectors.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  }

  public static async createConnectorForTarget(
    websiteUrl: string,
    endpoint = "",
    options: Partial<SupplierSourceConfig> = {},
  ): Promise<SupplierConnector> {
    const approvedHosts = await getApprovedSupplierHosts();
    const validatedTarget = await validateSupplierRequestTarget(websiteUrl, endpoint, approvedHosts);
    const source = this.toSupplierSourceConfig(options.id || "request-supplier", {
      supplierId: options.supplierId || options.id || "request-supplier",
      supplierName: options.name || "Requested Supplier",
      connectorType: options.connectorType,
      enabled: options.enabled !== false,
      priority: options.priority ?? 100,
      currency: options.currency || "LKR",
      timezone: options.timezone || "Asia/Colombo",
      syncSchedule: options.syncSchedule || "Off",
      authentication: options.authentication || { mode: "none" },
      capabilities: options.capabilities || ["catalog.fetch", "connection.test"],
      websiteUrl,
      endpoint,
      ...(options.raw || {}),
    });
    return this.createConnector(validatedTarget.targetUrl, source, approvedHosts);
  }

  /** Builds a connector from an exact registry/source document without URL-based inference. */
  public static async createConnectorForSourceRecord(
    id: string,
    data: FirebaseFirestore.DocumentData,
    options: { allowProposedHost?: boolean } = {},
  ): Promise<SupplierConnector> {
    const source = this.toSupplierSourceConfig(id, data);
    if (!source.enabled) throw new Error("Supplier source is disabled.");
    if (!source.websiteUrl) throw new Error("Supplier source website URL is required.");
    const approvedHosts = await getApprovedSupplierHosts();
    if (options.allowProposedHost) {
      // The caller is an authenticated admin submitting the same validated
      // source contract accepted by source creation. Add only this exact
      // destination host; DNS/IP/redirect SSRF checks remain fully enforced.
      const proposedHostname = new URL(buildSupplierTargetUrl(source.websiteUrl, source.endpoint)).hostname;
      approvedHosts.push(proposedHostname);
    }
    const validatedTarget = await validateSupplierRequestTarget(source.websiteUrl, source.endpoint, approvedHosts);
    return this.createConnector(validatedTarget.targetUrl, source, approvedHosts);
  }

  private static createConnector(targetUrl: string, source: SupplierSourceConfig, approvedHosts: string[]): SupplierConnector {
    const factory = this.connectorFactories.get(source.connectorType);
    if (!factory) throw new Error(`Supplier connector type "${source.connectorType}" is not registered.`);
    return factory(targetUrl, source, approvedHosts);
  }
}

const createHttpConnector: SupplierConnectorFactory = (targetUrl, source, approvedHosts) => new HttpSupplierConnector(targetUrl, {
  id: source.id,
  name: source.name,
  connectorType: source.connectorType,
  enabled: source.enabled,
  priority: source.priority,
  capabilities: source.capabilities,
  dataPath: typeof source.raw?.config?.apiDataPath === "string" ? source.raw.config.apiDataPath : "",
  outboundPolicy: { approvedHosts, connector: "http", sourceId: source.id } satisfies SupplierOutboundPolicy,
});

SupplierRegistry.registerConnectorFactory("http", createHttpConnector);
SupplierRegistry.registerConnectorFactory("rest", createHttpConnector);
SupplierRegistry.registerConnectorFactory("a2z", (targetUrl, source, approvedHosts) => new A2ZSupplierConnector(targetUrl, {
  id: source.id,
  name: source.name,
  connectorType: source.connectorType,
  enabled: source.enabled,
  priority: source.priority,
  capabilities: source.capabilities,
  outboundPolicy: { approvedHosts, connector: "a2z", sourceId: source.id } satisfies SupplierOutboundPolicy,
}));
