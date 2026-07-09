import { adminDb } from "../firebase";
import { getApprovedSupplierHosts, validateSupplierRequestTarget } from "../security/supplierUrlProtection";
import { A2ZSupplierConnector } from "./a2z/A2ZSupplierConnector";
import { HttpSupplierConnector } from "./HttpSupplierConnector";
import { SupplierConnector, SupplierSourceConfig } from "./types";

export class SupplierRegistry {
  public static async loadEnabledConnectors(enabledSupplierIds: string[] = []): Promise<SupplierConnector[]> {
    const sourcesSnap = await adminDb.collection("supplierSources").get();
    const approvedHosts = await getApprovedSupplierHosts();
    const connectors: SupplierConnector[] = [];

    for (const sourceDoc of sourcesSnap.docs) {
      const data = sourceDoc.data();
      const source = this.mapSource(sourceDoc.id, data);

      if (!source.enabled || !source.websiteUrl || (enabledSupplierIds.length > 0 && !enabledSupplierIds.includes(source.id))) {
        continue;
      }

      const validatedTarget = await validateSupplierRequestTarget(source.websiteUrl, source.endpoint, approvedHosts);
      connectors.push(this.createConnector(validatedTarget.targetUrl, source));
    }

    return connectors.sort((a, b) => a.priority - b.priority);
  }

  public static async createConnectorForTarget(
    websiteUrl: string,
    endpoint = "",
    options: Partial<SupplierSourceConfig> = {},
  ): Promise<SupplierConnector> {
    const validatedTarget = await validateSupplierRequestTarget(
      websiteUrl,
      endpoint,
      await getApprovedSupplierHosts(),
    );

    return this.createConnector(validatedTarget.targetUrl, {
      id: options.id || "request-supplier",
      name: options.name || "Requested Supplier",
      enabled: options.enabled !== false,
      priority: options.priority || 100,
      websiteUrl,
      endpoint,
      raw: options.raw || {},
    });
  }

  private static mapSource(id: string, data: FirebaseFirestore.DocumentData): SupplierSourceConfig {
    const type = data.supplierType || data.type || "website";
    const sourceStatus = data.sourceStatus || "active";
    const priority = Number(data.priority || data.settings?.priority || 100);

    return {
      id,
      name: data.supplierName || data.name || id,
      enabled: sourceStatus === "active" && String(type).toLowerCase() === "website",
      priority: Number.isFinite(priority) ? priority : 100,
      websiteUrl: data.websiteUrl || data.config?.targetUrl || "",
      endpoint: data.endpoint || data.config?.apiEndpoint || "",
      raw: data,
    };
  }

  private static createConnector(targetUrl: string, source: SupplierSourceConfig): SupplierConnector {
    const isA2Z = targetUrl.toLowerCase().includes("a2z") ||
      source.name.toLowerCase().includes("a2z") ||
      source.id.toLowerCase().includes("a2z");

    const options = {
      id: source.id,
      name: source.name,
      enabled: source.enabled,
      priority: source.priority,
    };

    if (isA2Z) {
      return new A2ZSupplierConnector(targetUrl, options);
    }

    return new HttpSupplierConnector(targetUrl, options);
  }
}
