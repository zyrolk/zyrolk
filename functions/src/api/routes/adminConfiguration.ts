import * as express from 'express';
import { hasAdminAccess } from '../middleware/adminAuth';

interface Dependencies {
  auth: { verifyIdToken(token: string, checkRevoked?: boolean): Promise<{ email?: string; [key: string]: unknown }> };
}

export function registerAdminConfigurationRoutes(app: express.Express, dependencies: Dependencies): void {
  app.get('/api/admin/payment-settings', async (req, res) => {
    const match = (req.header('Authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) { res.status(401).json({ error: 'Authentication required' }); return; }
    try {
      const token = await dependencies.auth.verifyIdToken(match[1], true);
      if (!hasAdminAccess(token)) {
        res.status(403).json({ error: 'Admin access required' }); return;
      }
      res.json({
        configured: false,
        paymentStatus: 'temporarily_disabled',
        mode: 'disabled',
        merchantId: '',
        merchantSecretConfigured: false,
        secretStorage: 'not_bound',
        message: 'PayHere is temporarily disabled. Cash on Delivery is the only available payment method.',
      });
    } catch {
      res.status(401).json({ error: 'Invalid or expired authentication token' });
    }
  });
}
