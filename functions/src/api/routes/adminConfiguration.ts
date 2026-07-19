import * as express from 'express';
import { loadPayHereConfig } from '../payments/payhereLogic';

interface Dependencies {
  auth: { verifyIdToken(token: string): Promise<{ email?: string }> };
  adminEmail: string;
}

const maskMerchantId = (value: string): string => value.length <= 4 ? '****' : `${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;

export function registerAdminConfigurationRoutes(app: express.Express, dependencies: Dependencies): void {
  app.get('/api/admin/payment-settings', async (req, res) => {
    const match = (req.header('Authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) { res.status(401).json({ error: 'Authentication required' }); return; }
    try {
      const token = await dependencies.auth.verifyIdToken(match[1]);
      if ((token.email || '').toLowerCase() !== dependencies.adminEmail.toLowerCase()) {
        res.status(403).json({ error: 'Admin access required' }); return;
      }
      const merchantId = String(process.env.PAYHERE_MERCHANT_ID || '').trim();
      const merchantSecret = String(process.env.PAYHERE_MERCHANT_SECRET || '').trim();
      try {
        const config = loadPayHereConfig(process.env, merchantSecret);
        res.json({
          configured: Boolean(config),
          paymentStatus: config ? 'ready' : 'disabled',
          mode: config?.mode || (process.env.PAYHERE_MODE || 'sandbox'),
          merchantId: merchantId ? maskMerchantId(merchantId) : '',
          merchantSecretConfigured: Boolean(merchantSecret),
          secretStorage: 'Firebase Secret Manager',
        });
      } catch (error) {
        res.status(200).json({
          configured: false,
          paymentStatus: 'incomplete',
          mode: process.env.PAYHERE_MODE || 'sandbox',
          merchantId: merchantId ? maskMerchantId(merchantId) : '',
          merchantSecretConfigured: Boolean(merchantSecret),
          secretStorage: 'Firebase Secret Manager',
          message: error instanceof Error ? error.message : 'PayHere configuration is incomplete',
        });
      }
    } catch {
      res.status(401).json({ error: 'Invalid or expired authentication token' });
    }
  });
}
