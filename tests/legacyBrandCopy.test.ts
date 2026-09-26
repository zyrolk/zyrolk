import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildStorefrontSeo } from '../src/services/seo/storefrontSeo';
import {
  DEFAULT_WEBSITE_SETTINGS,
  LEGACY_BRAND_COPY_VALUES,
  isLegacyBrandCopy,
  normalizeWebsiteSettings,
  withoutLegacyBrandCopy,
} from '../src/services/settings/websiteSettings';
import { WebsiteSettings } from '../src/types';

const LEGACY_SEO_TITLE = 'Zyro.lk | Flagship Tech, Smart Energy & Premium Audio Sri Lanka';
const LEGACY_SEO_DESCRIPTION = 'Browse premium consumer electronics, solar hybrid smart inverters, flagship audio systems, and high-end smart kitchen appliances in Sri Lanka with Islandwide Cash on Delivery.';
const LEGACY_ABOUT_TEXT = "Sri Lanka's premier destination for high-end digital solutions, smart energy solar, kitchen devices, and lifestyle audio components.";
const LEGACY_STORE_TAGLINE = "Sri Lanka's Premium Electronics & Solar Solutions Hub";

const unrelatedCmsFields: Partial<WebsiteSettings> = {
  heroBanners: [{
    id: 'launch-main',
    title: 'Upgrade Your Everyday',
    subtitle: 'Discover useful everyday products',
    image: '/launch/hero-main-desktop.png',
    mobileImage: '/launch/hero-main-mobile.png',
    buttonText: 'Shop Now',
    buttonUrl: '/products',
    enabled: true,
  } as NonNullable<WebsiteSettings['heroBanners']>[number]],
  deliveryCharge: 350,
  freeDeliveryMin: 5000,
  enableCOD: true,
  contactPhone: '+94714021999',
  whatsappNumber: '94714021999',
  contactEmail: 'zyrolkofficial@gmail.com',
  contactAddress: 'Colombo, Sri Lanka',
  storeName: 'Zyro.lk',
  copyrightText: '© 2026 Zyro.lk. All rights reserved.',
  facebookUrl: 'https://facebook.com/zyro.lk',
  seoKeywords: 'Zyro.lk, online shopping Sri Lanka',
};

const withoutBrandFields = (settings: WebsiteSettings) => {
  const { seoTitle, seoDescription, aboutText, storeTagline, ...rest } = settings;
  return rest;
};

test('known legacy CMS brand copy is replaced with the launch defaults', () => {
  const cleaned = withoutLegacyBrandCopy(normalizeWebsiteSettings({
    seoTitle: LEGACY_SEO_TITLE,
    seoDescription: LEGACY_SEO_DESCRIPTION,
    aboutText: LEGACY_ABOUT_TEXT,
    storeTagline: LEGACY_STORE_TAGLINE,
  }));
  assert.equal(cleaned.seoTitle, 'Zyro.lk — Shop Online in Sri Lanka');
  assert.equal(cleaned.seoDescription, 'Discover everyday products across electronics, automotive, home, fashion and more at Zyro.lk.');
  assert.equal(cleaned.aboutText, DEFAULT_WEBSITE_SETTINGS.aboutText);
  assert.equal(cleaned.storeTagline, DEFAULT_WEBSITE_SETTINGS.storeTagline);

  const home = buildStorefrontSeo({ currentPage: 'home', settings: cleaned });
  assert.equal(home.title, 'Zyro.lk — Shop Online in Sri Lanka');
  assert.equal(home.description, 'Discover everyday products across electronics, automotive, home, fashion and more at Zyro.lk.');
});

test('legacy matching ignores case and surrounding or repeated whitespace only', () => {
  assert.equal(isLegacyBrandCopy(`  ${LEGACY_SEO_TITLE.toUpperCase()}  `), true);
  assert.equal(isLegacyBrandCopy(LEGACY_ABOUT_TEXT.replace(/ /gu, '   ')), true);
  assert.equal(isLegacyBrandCopy(`${LEGACY_STORE_TAGLINE}!`), false);
  assert.equal(isLegacyBrandCopy(`${LEGACY_SEO_DESCRIPTION} Shop now.`), false);
  assert.deepEqual(LEGACY_BRAND_COPY_VALUES, [LEGACY_SEO_TITLE, LEGACY_SEO_DESCRIPTION, LEGACY_ABOUT_TEXT, LEGACY_STORE_TAGLINE]);
});

test('legitimate admin-authored copy using similar words is preserved', () => {
  for (const copy of [
    'Visit our flagship store in Colombo',
    'Premium electronics deals this week',
    'Premier destination for gifts',
    'High-end audio for everyday listening',
  ]) {
    const settings = normalizeWebsiteSettings({ seoTitle: copy, seoDescription: copy, aboutText: copy, storeTagline: copy });
    assert.deepEqual(withoutLegacyBrandCopy(settings), settings, copy);
  }
});

test('empty and missing brand copy keeps the normal fallback behaviour', () => {
  const missing = withoutLegacyBrandCopy(normalizeWebsiteSettings({}));
  assert.equal(missing.seoTitle, DEFAULT_WEBSITE_SETTINGS.seoTitle);
  assert.equal(missing.seoDescription, DEFAULT_WEBSITE_SETTINGS.seoDescription);
  assert.equal(missing.aboutText, '');

  const empty = withoutLegacyBrandCopy(normalizeWebsiteSettings({ seoTitle: '', seoDescription: '', aboutText: '', storeTagline: '' }));
  assert.equal(empty.seoTitle, '');
  assert.equal(empty.aboutText, '');
  const home = buildStorefrontSeo({ currentPage: 'home', settings: empty });
  assert.equal(home.title, 'Zyro.lk — Shop Online in Sri Lanka');
  assert.equal(home.description, 'Discover everyday products across electronics, automotive, home, fashion and more at Zyro.lk.');
  assert.match(readFileSync('src/components/Footer.tsx', 'utf8'), /settings\?\.aboutText \|\| 'Shop everyday products online with Zyro\.lk\.'/);
});

test('unrelated settings are structurally unchanged when legacy copy is replaced', () => {
  const settings = normalizeWebsiteSettings({
    ...unrelatedCmsFields,
    seoTitle: LEGACY_SEO_TITLE,
    seoDescription: LEGACY_SEO_DESCRIPTION,
    aboutText: LEGACY_ABOUT_TEXT,
    storeTagline: LEGACY_STORE_TAGLINE,
  });
  const snapshot = structuredClone(settings);
  const cleaned = withoutLegacyBrandCopy(settings);
  assert.notEqual(cleaned, settings);
  assert.deepEqual(settings, snapshot);
  assert.deepEqual(withoutBrandFields(cleaned), withoutBrandFields(settings));
  assert.equal(cleaned.heroBanners, settings.heroBanners);
  assert.equal(cleaned.deliveryCharge, 350);
  assert.equal(cleaned.freeDeliveryMin, 5000);
  assert.equal(cleaned.contactPhone, '+94714021999');
});

test('the filter is applied only to storefront settings state', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  assert.equal(app.match(/withoutLegacyBrandCopy\(/gu)?.length, 1);
  assert.match(app, /const cleanData = withoutLegacyBrandCopy\(data\)/);
  for (const file of [
    'src/components/AdminDashboard.tsx',
    'src/services/storefront/storefrontCatalog.ts',
    'src/components/CartDrawer.tsx',
    'src/features/supplier-portal/SupplierPortal.tsx',
  ]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /withoutLegacyBrandCopy|isLegacyBrandCopy/u, file);
  }
});

test('touched storefront sources carry no legacy brand copy outside the recognition list', () => {
  assert.match(readFileSync('index.html', 'utf8'), /<title>Zyro\.lk — Shop Online in Sri Lanka<\/title>/);
  const settingsSource = readFileSync('src/services/settings/websiteSettings.ts', 'utf8')
    .replace(/export const LEGACY_BRAND_COPY_VALUES[\s\S]*?\];/u, '');
  const sources: Array<[string, string]> = [
    ['src/services/settings/websiteSettings.ts', settingsSource],
    ...['index.html', 'src/App.tsx', 'src/components/AdminDashboard.tsx', 'src/components/Footer.tsx', 'src/services/seo/storefrontSeo.ts']
      .map((file): [string, string] => [file, readFileSync(file, 'utf8')]),
  ];
  for (const [file, source] of sources) {
    assert.doesNotMatch(source, /Flagship Tech|premier destination|high-end digital solutions|Solar Solutions Hub/iu, file);
  }
});
