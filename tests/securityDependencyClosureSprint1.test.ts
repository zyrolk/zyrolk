import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CONTACT_RATE_LIMIT_MAX_REQUESTS,
  CONTACT_RATE_LIMIT_WINDOW_MS,
  ContactInquiryError,
  contactRateLimitDocumentId,
  nextContactRateLimitState,
  validateContactInquiry,
} from '../functions/src/api/contact/contactInquiries';
import {
  hasAdminAccess as hasServerAdminAccess,
  hasSupplierHubAdminAccess,
} from '../functions/src/api/security/adminAuthorization';
import { hasAdminAccess as hasClientAdminAccess } from '../src/services/security/adminAuthorization';

const contactPage = readFileSync('src/components/ContactPage.tsx', 'utf8');
const contactRoute = readFileSync('functions/src/api/routes/contact.ts', 'utf8');
const functionsApp = readFileSync('functions/src/api/app.ts', 'utf8');
const reviewRoute = readFileSync('functions/src/api/routes/reviewSystem.ts', 'utf8');
const reviewUi = readFileSync('src/features/reviews/ProductReviewsAndQuestions.tsx', 'utf8');
const storefrontApp = readFileSync('src/App.tsx', 'utf8');
const localServer = readFileSync('server.ts', 'utf8');
const firestoreRules = readFileSync('firestore.rules', 'utf8');
const storageRules = readFileSync('storage.rules', 'utf8');

test('contact inquiry input is normalized and invalid or oversized input is rejected', () => {
  assert.deepEqual(validateContactInquiry({
    name: '  Test\u0000 Customer ',
    phone: ' +94 77 123 4567 ',
    email: ' TEST@Example.COM ',
    message: ' First line\r\nSecond line ',
  }), {
    name: 'Test Customer',
    phone: '+94 77 123 4567',
    email: 'test@example.com',
    message: 'First line\nSecond line',
  });
  assert.throws(() => validateContactInquiry({ name: '', phone: '0771234567', message: 'Help' }), ContactInquiryError);
  assert.throws(() => validateContactInquiry({ name: 'Test', phone: '123', message: 'Help' }), ContactInquiryError);
  assert.throws(() => validateContactInquiry({ name: 'Test', phone: '0771234567', email: 'invalid', message: 'Help' }), ContactInquiryError);
  assert.throws(() => validateContactInquiry({ name: 'Test', phone: '0771234567', message: 'x'.repeat(2001) }), ContactInquiryError);
});

test('contact inquiry rate limiting is bounded, windowed, and keyed without storing raw identities', () => {
  const now = Date.parse('2026-07-30T00:00:00.000Z');
  let state = nextContactRateLimitState(null, now);
  assert.equal(state.count, 1);
  for (let count = 2; count <= CONTACT_RATE_LIMIT_MAX_REQUESTS; count += 1) {
    state = nextContactRateLimitState(state, now + count);
    assert.equal(state.count, count);
  }
  assert.throws(
    () => nextContactRateLimitState(state, now + 100),
    (error: unknown) => error instanceof ContactInquiryError && error.statusCode === 429,
  );
  assert.equal(nextContactRateLimitState(state, now + CONTACT_RATE_LIMIT_WINDOW_MS).count, 1);

  const first = contactRateLimitDocumentId('phone', '94771234567');
  assert.equal(first, contactRateLimitDocumentId('phone', '94771234567'));
  assert.notEqual(first, contactRateLimitDocumentId('network', '94771234567'));
  assert.doesNotMatch(first, /94771234567/);
});

test('contact submissions use the App Check protected Functions route and browser writes are denied', () => {
  assert.match(contactPage, /fetchJson<\{ success: true; inquiryId: string \}>/);
  assert.match(contactPage, /'\/api\/contact-inquiries'/);
  assert.doesNotMatch(contactPage, /addDoc\(collection\(db, ["']contact_inquiries["']/);
  assert.match(contactRoute, /app\.post\("\/api\/contact-inquiries"/);
  assert.match(contactRoute, /runTransaction/);
  assert.match(contactRoute, /contactRateLimitDocumentId\("network"/);
  assert.match(contactRoute, /contactRateLimitDocumentId\("phone"/);
  assert.ok(functionsApp.indexOf('adminAppCheck.verifyToken(token)') < functionsApp.indexOf('registerContactRoutes(app'));

  const inquiryRule = firestoreRules.slice(
    firestoreRules.indexOf('match /contact_inquiries/{inquiryId}'),
    firestoreRules.indexOf('match /contact_inquiry_limits/{limitId}'),
  );
  assert.match(inquiryRule, /allow create: if false/);
  assert.match(firestoreRules, /match \/contact_inquiry_limits\/\{limitId\}[\s\S]*allow read, write: if false/);
});

test('all privileged review and admin authorization uses custom claims instead of email identity', () => {
  for (const predicate of [hasServerAdminAccess, hasClientAdminAccess]) {
    assert.equal(predicate({ email: 'zyrolkofficial@gmail.com' }), false);
    assert.equal(predicate({ admin: true }), true);
    assert.equal(predicate({ role: 'admin' }), true);
    assert.equal(predicate({ role: 'customer' }), false);
  }
  assert.equal(hasSupplierHubAdminAccess({ supplierHubAdmin: true }), true);
  assert.equal(hasSupplierHubAdminAccess({ role: 'admin' }), true);
  assert.equal(hasSupplierHubAdminAccess({ email: 'zyrolkofficial@gmail.com' }), false);

  assert.match(reviewRoute, /hasAdminAccess\(user\)/);
  assert.doesNotMatch(reviewRoute, /isAdminEmail|ADMIN_EMAIL/);
  assert.match(storefrontApp, /hasAdminAccess\(tokenResult\.claims\)/);
  assert.doesNotMatch(storefrontApp, /isProductionAdminEmail/);
  assert.match(reviewUi, /isAdminUser/);
  assert.doesNotMatch(reviewUi, /ADMIN_EMAIL|currentUser\?\.email\?\.toLowerCase/);
  assert.match(localServer, /hasAdminAccess\(decodedToken\)/);
  assert.doesNotMatch(localServer, /const ADMIN_EMAIL/);
});

test('Firestore and Storage privileged operations share the same custom-claims model', () => {
  assert.match(firestoreRules, /request\.auth\.token\.admin == true \|\| request\.auth\.token\.role == 'admin'/);
  assert.match(storageRules, /request\.auth\.token\.admin == true \|\| request\.auth\.token\.role == 'admin'/);
  assert.doesNotMatch(firestoreRules, /request\.auth\.token\.email/);
  assert.doesNotMatch(storageRules, /request\.auth\.token\.email/);
});
