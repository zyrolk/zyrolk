import { SupplierRegistry } from "./SupplierRegistry";
import { getSupplierProductLimit } from "../../scheduled/supplierSyncSettings";
export { getA2ZCredentials } from "./credentials";

export async function fetchSupplierProductsFromTarget(
  websiteUrl: string,
  endpoint = "",
  productLimit?: unknown,
): Promise<{ products: any[]; targetUrl: string; requestedProductLimit: number }> {
  const connector = await SupplierRegistry.createConnectorForTarget(websiteUrl, endpoint);
  const result = await connector.fetchProducts();
  return {
    ...result,
    requestedProductLimit: getSupplierProductLimit(
      productLimit === undefined || productLimit === null ? "All" : String(productLimit),
      250,
    ),
  };
}
