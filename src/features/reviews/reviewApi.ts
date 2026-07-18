import { User } from 'firebase/auth';

interface ApiResult { success?: boolean; error?: string; [key: string]: unknown }

export async function callReviewApi(user: User, path: 'eligibility' | 'reviews' | 'questions', body: Record<string, unknown>): Promise<ApiResult> {
  const token = await user.getIdToken();
  const response = await fetch(`/api/review-system/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as ApiResult;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'The request could not be completed');
  return payload;
}
