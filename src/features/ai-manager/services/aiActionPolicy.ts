export const AI_MANAGER_ACTION_POLICY = Object.freeze({
  mode: 'read-only' as const,
  canGenerateRecommendations: false,
  canExecuteActions: false,
  requiresAdminApproval: true,
  protectedWorkflows: Object.freeze([
    'products',
    'pricing',
    'inventory',
    'orders',
    'supplier-approval',
    'marketing',
  ] as const),
});
