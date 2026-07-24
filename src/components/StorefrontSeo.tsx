import { useEffect } from 'react';
import { Product, WebsiteSettings } from '../types';
import { buildStorefrontSeo } from '../services/seo/storefrontSeo';

interface StorefrontSeoProps {
  currentPage: string;
  product?: Product | null;
  settings?: WebsiteSettings | null;
  isAdminMode: boolean;
}

const upsertMeta = (attribute: 'name' | 'property', key: string, content: string) => {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
};

const removeMeta = (attribute: 'name' | 'property', key: string) => {
  document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`)?.remove();
};

export default function StorefrontSeo({ currentPage, product, settings, isAdminMode }: StorefrontSeoProps) {
  useEffect(() => {
    const seo = buildStorefrontSeo({
      currentPage,
      product,
      settings,
      isAdminMode,
      // Canonicals must never point to a preview, emulator, or local hostname.
      origin: 'https://zyro.lk',
    });

    document.title = seo.title;
    upsertMeta('name', 'description', seo.description);
    upsertMeta('name', 'keywords', seo.keywords);
    upsertMeta('name', 'robots', seo.robots);
    upsertMeta('property', 'og:type', seo.type);
    upsertMeta('property', 'og:site_name', seo.siteName);
    upsertMeta('property', 'og:locale', seo.locale);
    upsertMeta('property', 'og:title', seo.title);
    upsertMeta('property', 'og:description', seo.description);
    upsertMeta('property', 'og:url', seo.canonical);
    upsertMeta('name', 'twitter:card', seo.image ? 'summary_large_image' : 'summary');
    upsertMeta('name', 'twitter:url', seo.canonical);
    upsertMeta('name', 'twitter:title', seo.title);
    upsertMeta('name', 'twitter:description', seo.description);
    upsertMeta('name', 'twitter:domain', new URL(seo.canonical).hostname);

    if (seo.image) {
      upsertMeta('property', 'og:image', seo.image);
      upsertMeta('property', 'og:image:alt', seo.imageAlt || seo.siteName);
      upsertMeta('name', 'twitter:image', seo.image);
      upsertMeta('name', 'twitter:image:alt', seo.imageAlt || seo.siteName);
    } else {
      removeMeta('property', 'og:image');
      removeMeta('property', 'og:image:alt');
      removeMeta('name', 'twitter:image');
      removeMeta('name', 'twitter:image:alt');
    }

    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    canonical.href = seo.canonical;

    let structuredData = document.head.querySelector<HTMLScriptElement>('#zyro-storefront-structured-data');
    if (!structuredData) {
      structuredData = document.createElement('script');
      structuredData.id = 'zyro-storefront-structured-data';
      structuredData.type = 'application/ld+json';
      document.head.appendChild(structuredData);
    }
    structuredData.textContent = JSON.stringify(seo.structuredData).replace(/</gu, '\\u003c');
  }, [currentPage, isAdminMode, product, settings]);

  return null;
}
