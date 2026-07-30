import * as express from 'express';
import { Firestore } from 'firebase-admin/firestore';
import { hasAdminAccess } from '../middleware/adminAuth';
import { loadAdminOperationsSummary } from '../admin/adminOperations';
import { appLogger } from '../logging';

interface Dependencies {
  auth: { verifyIdToken(token: string, checkRevoked?: boolean): Promise<{ email?: string; [key: string]: unknown }> };
  db: Firestore;
}

async function requireAdmin(
  req: express.Request,
  res: express.Response,
  dependencies: Dependencies,
): Promise<boolean> {
  const match = (req.header('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!match) { res.status(401).json({ error: 'Authentication required' }); return false; }
  try {
    const token = await dependencies.auth.verifyIdToken(match[1], true);
    if (!hasAdminAccess(token)) { res.status(403).json({ error: 'Admin access required' }); return false; }
    return true;
  } catch {
    res.status(401).json({ error: 'Invalid or expired authentication token' });
    return false;
  }
}

export function registerAdminConfigurationRoutes(app: express.Express, dependencies: Dependencies): void {
  app.get('/api/admin/payment-settings', async (req, res) => {
    if (!await requireAdmin(req, res, dependencies)) return;
    res.json({
      configured: false,
      paymentStatus: 'temporarily_disabled',
      mode: 'disabled',
      merchantId: '',
      merchantSecretConfigured: false,
      secretStorage: 'not_bound',
      message: 'PayHere is temporarily disabled. Cash on Delivery is the only available payment method.',
    });
  });

  app.get('/api/admin/operations-summary', async (req, res) => {
    if (!await requireAdmin(req, res, dependencies)) return;
    try {
      res.json({ success: true, summary: await loadAdminOperationsSummary(dependencies.db) });
    } catch (error) {
      appLogger.error('Admin operations summary could not be loaded.', { error });
      res.status(503).json({ error: 'Operational status is temporarily unavailable.' });
    }
  });
}
