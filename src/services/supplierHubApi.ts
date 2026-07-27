import { auth } from '../firebase';
import { getAppCheckRequestHeaders } from './security/appCheck';

export type SupplierApiMethod = 'GET' | 'POST' | 'PATCH';

export async function getSupplierApiHeaders(forceRefresh = false): Promise<Record<string, string>> {
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) throw new Error('Admin authentication is required. Please sign in again.');

  const [token, appCheckHeaders] = await Promise.all([
    user.getIdToken(forceRefresh),
    getAppCheckRequestHeaders(forceRefresh),
  ]);
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...appCheckHeaders,
  };
}

export async function requestSupplierApi(
  path: string,
  method: SupplierApiMethod,
  body?: Record<string, unknown>,
): Promise<Response> {
  const request = async (forceRefresh: boolean) => fetch(path, {
    method,
    headers: await getSupplierApiHeaders(forceRefresh),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let response = await request(false);
  if (response.status === 401) response = await request(true);
  return response;
}

export const getSupplierApi = (path: string): Promise<Response> => requestSupplierApi(path, 'GET');
export const postSupplierApi = (path: string, body: Record<string, unknown>): Promise<Response> => requestSupplierApi(path, 'POST', body);
export const patchSupplierApi = (path: string, body: Record<string, unknown>): Promise<Response> => requestSupplierApi(path, 'PATCH', body);
