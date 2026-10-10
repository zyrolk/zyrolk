import { auth } from '../firebase';
import { postSupplierApi } from './supplierHubApi';

export const LAUNCH1000_PILOT_MANIFEST_REVISION = 'launch1000-final800-visual-freeze-r1';

export const LAUNCH1000_PILOT_PRODUCT_IDS = [
  'dropex-adl0019',
  'dropex-aju0010',
  'dropex-aju0011',
  'dropex-aju0013',
  'dropex-aju0014',
  'dropex-aju0019',
  'dropex-aju0021',
  'dropex-aju0022',
  'dropex-aju0027',
  'dropex-ajuch-3338',
] as const;

export interface Launch1000PilotDryRunResult {
  productId: string;
  sku: string;
  outcome: string;
  reasonCodes: string[];
  expectedUpdatedAt: string | null;
  expectedFingerprint: string | null;
  intendedTaxonomy?: {
    categoryId: string;
    subcategoryId: string;
    proposalId: string | null;
  };
  deterministicSpecNormalization?: Record<string, string>;
  validationErrors?: Array<Record<string, unknown>>;
  projectionClasses?: string[];
}

export interface Launch1000PilotDryRunResponse {
  success: true;
  mode: 'dry_run';
  manifestRevision: string;
  results: Launch1000PilotDryRunResult[];
  counts: Record<string, number>;
}

type PrivilegedPost = (
  path: string,
  body: Record<string, unknown>,
) => Promise<Response>;

type AuthenticationCheck = () => boolean;

const responseError = (body: unknown): string => {
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return String((body as { error: string }).error);
  }
  return 'The Launch-1000 pilot dry run could not be completed.';
};

/**
 * Runs only the fixed, read-only Launch-1000 pilot request.
 * Authentication and App Check remain owned by postSupplierApi.
 */
export async function runLaunch1000PilotDryRun(
  post: PrivilegedPost = postSupplierApi,
  isAuthenticated: AuthenticationCheck = () => Boolean(auth.currentUser),
): Promise<Launch1000PilotDryRunResponse> {
  if (!isAuthenticated()) {
    throw new Error('Admin authentication is required. Please sign in again.');
  }

  const response = await post('/api/launch1000/products/dry-run', {
    manifestRevision: LAUNCH1000_PILOT_MANIFEST_REVISION,
    productIds: [...LAUNCH1000_PILOT_PRODUCT_IDS],
  });
  const body = await response.json().catch(() => null) as Partial<Launch1000PilotDryRunResponse> & { error?: unknown } | null;
  if (!response.ok || body?.success !== true || body.mode !== 'dry_run') {
    throw new Error(responseError(body));
  }
  return body as Launch1000PilotDryRunResponse;
}
