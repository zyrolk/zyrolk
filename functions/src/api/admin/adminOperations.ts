import { Firestore } from 'firebase-admin/firestore';

const EMAIL_STATUSES = ['handed_off', 'delivering', 'delivered', 'retry_pending', 'failed'] as const;

type EmailStatus = typeof EMAIL_STATUSES[number];

const count = async (query: FirebaseFirestore.Query): Promise<number> => (
  (await query.count().get()).data().count
);

const timestampIso = (value: unknown): string | null => {
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
};

export interface AdminOperationsSummary {
  generatedAt: string;
  emailNotifications: Record<EmailStatus, number> & {
    inProgress: number;
    lastFailure: null | {
      id: string;
      kind: string;
      attemptCount: number;
      message: string;
      updatedAt: string | null;
    };
  };
  supplierAlerts: { active: number };
  coupons: { total: number; active: number };
  audit: { latestSupplierEventAt: string | null };
}

/**
 * A bounded, aggregation-backed projection for the Admin overview. It exposes
 * operational health without granting browser access to private outbox or
 * audit collections.
 */
export async function loadAdminOperationsSummary(
  db: Firestore,
  now = Date.now(),
): Promise<AdminOperationsSummary> {
  const outbox = db.collection('notification_outbox');
  const alerts = db.collection('supplier_operational_alerts');
  const coupons = db.collection('checkout_coupons');
  const audit = db.collection('supplier_approval_audit');
  const [
    handedOff,
    delivering,
    delivered,
    retryPending,
    failed,
    failedSnapshot,
    openAlerts,
    acknowledgedAlerts,
    couponTotal,
    activeCoupons,
    latestAudit,
  ] = await Promise.all([
    count(outbox.where('status', '==', 'handed_off')),
    count(outbox.where('status', '==', 'delivering')),
    count(outbox.where('status', '==', 'delivered')),
    count(outbox.where('status', '==', 'retry_pending')),
    count(outbox.where('status', '==', 'failed')),
    outbox.where('status', '==', 'failed').orderBy('updatedAt', 'desc').limit(1).get(),
    count(alerts.where('status', '==', 'open')),
    count(alerts.where('status', '==', 'acknowledged')),
    count(coupons),
    count(coupons.where('active', '==', true)),
    audit.orderBy('timestamp', 'desc').limit(1).get(),
  ]);
  const failureDocument = failedSnapshot.docs[0];
  const failure = failureDocument?.data() || {};
  const auditDocument = latestAudit.docs[0]?.data() || {};
  return {
    generatedAt: new Date(now).toISOString(),
    emailNotifications: {
      handed_off: handedOff,
      delivering,
      delivered,
      retry_pending: retryPending,
      failed,
      inProgress: handedOff + delivering,
      lastFailure: failureDocument ? {
        id: failureDocument.id,
        kind: String(failure.kind || 'email'),
        attemptCount: Math.max(0, Math.floor(Number(failure.attemptCount) || 0)),
        message: String(failure.lastError || 'Email delivery failed.').slice(0, 300),
        updatedAt: timestampIso(failure.updatedAt || failure.failedAt),
      } : null,
    },
    supplierAlerts: { active: openAlerts + acknowledgedAlerts },
    coupons: { total: couponTotal, active: activeCoupons },
    audit: { latestSupplierEventAt: timestampIso(auditDocument.timestamp) },
  };
}
