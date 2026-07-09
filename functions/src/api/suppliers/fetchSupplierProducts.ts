import { SupplierRegistry } from "./SupplierRegistry";
export { getA2ZCredentials } from "./credentials";

export async function fetchSupplierProductsFromTarget(
  websiteUrl: string,
  endpoint = "",
): Promise<{ products: any[]; targetUrl: string }> {
  const connector = await SupplierRegistry.createConnectorForTarget(websiteUrl, endpoint);
  return connector.fetchProducts();
}
