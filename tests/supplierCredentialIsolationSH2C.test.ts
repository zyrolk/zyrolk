import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  A2Z_CREDENTIAL_PROFILE_MAP_PREFIX,
  normalizeA2ZCredentialReference,
  resolveA2ZCredentialProfile,
} from '../functions/src/api/suppliers/a2zCredentialProfiles';
import {
  projectSupplierSourceForAdmin,
  sanitizeSupplierSource,
} from '../functions/src/api/suppliers/supplierAdminConfiguration';

const profileSecret = (profiles: Record<string, unknown>): string => (
  `${A2Z_CREDENTIAL_PROFILE_MAP_PREFIX}${JSON.stringify(profiles)}`
);

test('SH-2C two A2Z sources can resolve isolated credentials for the same connector type', () => {
  const runtimeSecrets = {
    username: profileSecret({
      'supplier-a': { value: 'user-a', allowedHosts: ['a.example.com'] },
      'supplier-b': { value: 'user-b', allowedHosts: ['b.example.com'] },
    }),
    password: profileSecret({
      'supplier-a': { value: 'password-a', allowedHosts: ['a.example.com'] },
      'supplier-b': { value: 'password-b', allowedHosts: ['b.example.com'] },
    }),
  };

  assert.deepEqual(resolveA2ZCredentialProfile(runtimeSecrets, 'supplier-a', 'https://a.example.com/catalog'), {
    username: 'user-a', password: 'password-a', profileId: 'supplier-a',
  });
  assert.deepEqual(resolveA2ZCredentialProfile(runtimeSecrets, 'supplier-b', 'https://b.example.com/catalog'), {
    username: 'user-b', password: 'password-b', profileId: 'supplier-b',
  });
});

test('SH-2C legacy global A2Z secrets remain available only to their server-authorized host', () => {
  const secrets = { username: 'legacy-user', password: 'legacy-password' };
  assert.deepEqual(resolveA2ZCredentialProfile(
    secrets,
    'firebase-functions:a2z-global',
    'https://a2zdropshipping.lk/catalog',
  ), { username: 'legacy-user', password: 'legacy-password', profileId: 'a2z-global' });
  assert.throws(
    () => resolveA2ZCredentialProfile(secrets, 'a2z-global', 'https://attacker.example/catalog'),
    /not authorized for this supplier host/,
  );
  for (const legacyReference of ['A2Z_A2Z_MAIN', 'A2Z_REFERENCED_SUPPLIER']) {
    assert.deepEqual(resolveA2ZCredentialProfile(
      secrets,
      legacyReference,
      'https://a2zdropshipping.lk/catalog',
    ), { username: 'legacy-user', password: 'legacy-password', profileId: 'a2z-global' });
  }
  assert.throws(
    () => resolveA2ZCredentialProfile(secrets, 'a2z-global', 'http://a2zdropshipping.lk/catalog'),
    /must use HTTPS/,
  );
});

test('SH-2C profile allowlisting rejects secret-name injection and unknown profiles', () => {
  assert.throws(
    () => normalizeA2ZCredentialReference('projects/example/secrets/A2Z_PASSWORD/versions/latest'),
    /reference is not allowed/,
  );
  const secrets = {
    username: profileSecret({ allowed: { value: 'user', allowedHosts: ['supplier.example.com'] } }),
    password: profileSecret({ allowed: { value: 'password', allowedHosts: ['supplier.example.com'] } }),
  };
  assert.throws(
    () => resolveA2ZCredentialProfile(secrets, 'missing', 'https://supplier.example.com'),
    /not configured in Firebase Secret Manager/,
  );
});

test('SH-2C incomplete and host-unbound credential profiles fail closed without leaking values', () => {
  const password = 'very-secret-password';
  for (const resolve of [
    () => resolveA2ZCredentialProfile({
      username: profileSecret({ supplier: 'user' }),
      password,
    }, 'supplier', 'https://supplier.example.com'),
    () => resolveA2ZCredentialProfile({
      username: profileSecret({ supplier: 'user' }),
      password: profileSecret({ supplier: password }),
    }, 'supplier', 'https://supplier.example.com'),
  ]) {
    assert.throws(resolve, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.equal(message.includes(password), false);
      assert.equal(message.includes('user'), false);
      return true;
    });
  }
});

test('SH-2C source validation stores only a safe A2Z profile identifier', () => {
  const source = sanitizeSupplierSource({
    supplierName: 'Independent A2Z Supplier',
    supplierType: 'a2z',
    connectorType: 'a2z',
    websiteUrl: 'https://supplier.example.com',
    authentication: { mode: 'secret_manager', credentialProfile: 'supplier-a' },
  });
  assert.deepEqual(source.authentication, { mode: 'secret_manager', credentialProfile: 'supplier-a' });
  assert.doesNotMatch(JSON.stringify(source), /user-a|password-a/);
});

test('SH-2C new A2Z sources require one independent profile while legacy sources keep the global fallback', () => {
  const base = {
    supplierName: 'A2Z Supplier',
    supplierType: 'a2z',
    connectorType: 'a2z',
    websiteUrl: 'https://a2zdropshipping.lk',
  };
  assert.throws(() => sanitizeSupplierSource({
    ...base,
    authentication: { mode: 'secret_manager', credentialProfile: 'a2z-global' },
  }), /independent server-configured credential profile/);
  assert.throws(() => sanitizeSupplierSource({
    ...base,
    authentication: { mode: 'none' },
  }), /server-managed credential profile/);
  assert.throws(() => sanitizeSupplierSource({
    ...base,
    authentication: {
      mode: 'secret_manager',
      secretRef: 'supplier-a',
      credentialProfile: 'projects\/example\/secrets\/raw',
    },
  }), /exactly one credential profile reference/);
  const projected = projectSupplierSourceForAdmin({
    ...base,
    authentication: {
      mode: 'secret_manager',
      secretRef: 'supplier-a',
      credentialProfile: 'projects/example/secrets/raw',
    },
  }, 'source-a');
  assert.deepEqual(projected.authentication, {
    mode: 'secret_manager', credentialProfile: 'supplier-a',
  });
  assert.equal(JSON.stringify(projected).includes('projects/example/secrets/raw'), false);
  assert.throws(() => sanitizeSupplierSource({
    ...base,
    websiteUrl: 'http://a2zdropshipping.lk',
    authentication: { mode: 'secret_manager', credentialProfile: 'supplier-a' },
  }), /must use HTTPS/);

  const legacyExisting = {
    ...base,
    supplierId: 'legacy-a2z',
    authentication: { mode: 'secret_manager', secretRef: 'A2Z_A2Z_MAIN' },
  };
  const legacy = sanitizeSupplierSource(legacyExisting, { existingSource: legacyExisting });
  assert.deepEqual(legacy.authentication, {
    mode: 'secret_manager', credentialProfile: 'a2z-global',
  });
});

test('SH-2C Test Connection and catalog sync share one credential resolver path', () => {
  const connector = readFileSync('functions/src/api/suppliers/a2z/A2ZSupplierConnector.ts', 'utf8');
  const registry = readFileSync('functions/src/api/suppliers/SupplierRegistry.ts', 'utf8');
  const sync = readFileSync('functions/src/scheduled/supplierSync.ts', 'utf8');

  assert.match(connector, /private resolveCredentials\(\)/);
  assert.equal((connector.match(/await this\.resolveCredentials\(\)/g) || []).length, 2);
  assert.match(connector, /testConnection\(\)[\s\S]*?this\.fetchProducts\(\)/);
  assert.match(registry, /credentialReference: source\.authentication\.secretRef[\s\S]*?source\.authentication\.credentialProfile/);
  assert.match(sync, /authentication: source\.authentication/);
});

test('SH-2C credential values and hashes are absent from serialized jobs, diagnostics, and API projections', () => {
  const credentialResolver = readFileSync('functions/src/api/suppliers/credentials.ts', 'utf8');
  const connectorService = readFileSync('functions/src/api/suppliers/a2z/A2ZConnectorService.ts', 'utf8');
  const diagnostics = readFileSync('functions/src/api/suppliers/a2z/diagnostics.ts', 'utf8');
  const queueWorker = readFileSync('functions/src/scheduled/supplierQueueWorker.ts', 'utf8');

  assert.doesNotMatch(credentialResolver, /passwordSha256|usernameSha256/);
  assert.doesNotMatch(connectorService, /Authentication rejected by A2Z\. Message/);
  assert.doesNotMatch(connectorService, /debugLog\(JSON\.stringify\(fingerprintA2ZCredentials/);
  assert.match(diagnostics, /redacted supplier response body/);
  assert.doesNotMatch(queueWorker, /A2Z_SECRETS/);
});
