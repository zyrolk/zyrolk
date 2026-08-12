import { auth } from '../../firebase';
import type { Product } from '../../types';
import { getAppCheckRequestHeaders } from '../security/appCheck';

const PRODUCT_DRAFT_FIELDS = [
  'id', 'sku', 'name', 'description', 'shortDescription', 'price', 'originalPrice',
  'imageUrl', 'imageUrls', 'category', 'subcategory', 'brand', 'model', 'barcode',
  'productType', 'tags', 'keyFeatures', 'whatsIncluded', 'stock', 'specs', 'isNew',
  'isFeatured', 'isBestSeller', 'isActive', 'supplierId', 'supplierItemCode', 'costPrice',
  'marketPrice',
] as const;

export interface AdminProductMutationResponse {
  success: true;
  productId: string;
  sku: string;
  idempotent?: boolean;
  archived?: boolean;
}

export const projectAdminProductDraft = (product: Readonly<Partial<Product>>): Record<string, unknown> =>
  Object.fromEntries(PRODUCT_DRAFT_FIELDS
    .filter((field) => product[field] !== undefined)
    .map((field) => [field, product[field]]));

const requestAdminProductApi = async (
  path: string,
  method: 'POST' | 'PATCH',
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<AdminProductMutationResponse> => {
  const request = async (forceRefresh: boolean): Promise<Response> => {
    await auth.authStateReady();
    const user = auth.currentUser;
    if (!user) throw new Error('Admin authentication is required. Please sign in again.');
    const [token, appCheckHeaders] = await Promise.all([
      user.getIdToken(forceRefresh),
      getAppCheckRequestHeaders(forceRefresh),
    ]);
    return fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...appCheckHeaders,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  };

  let response = await request(false);
  if (response.status === 401) response = await request(true);
  const payload = await response.json().catch(() => ({})) as Partial<AdminProductMutationResponse> & { error?: unknown };
  if (!response.ok || payload.success !== true || !payload.productId) {
    throw new Error(typeof payload.error === 'string' && payload.error.trim()
      ? payload.error.trim().slice(0, 300)
      : 'Product operation failed. Please try again.');
  }
  return payload as AdminProductMutationResponse;
};

export const createAdminProduct = (
  draft: Readonly<Partial<Product>>,
  idempotencyKey: string,
): Promise<AdminProductMutationResponse> => requestAdminProductApi(
  '/api/admin/products',
  'POST',
  { draft: projectAdminProductDraft(draft) },
  idempotencyKey,
);

export const updateAdminProduct = (
  productId: string,
  draft: Readonly<Partial<Product>>,
): Promise<AdminProductMutationResponse> => requestAdminProductApi(
  `/api/admin/products/${encodeURIComponent(productId)}`,
  'PATCH',
  { draft: projectAdminProductDraft(draft) },
);

export const archiveAdminProduct = (productId: string): Promise<AdminProductMutationResponse> =>
  requestAdminProductApi(`/api/admin/products/${encodeURIComponent(productId)}/archive`, 'POST');
