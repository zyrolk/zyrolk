import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/gu, '\n');
const cms = source('src/components/CmsPage.tsx');
const app = source('src/App.tsx');
const loader = cms.slice(cms.indexOf('const fetchPageContent = async'), cms.indexOf('fetchPageContent();'));

test('CMS page chrome uses neutral wording without spec-style labels', () => {
  assert.doesNotMatch(cms, /Corporate Specifications/u);
  assert.doesNotMatch(cms, /Official Zyro Spec/u);
  assert.match(cms, /<FileText className="h-3 w-3 text-blue-500" \/>\n\s+Information\n\s+<\/span>/u);
});

test('fallback pages never fabricate an Updated date', () => {
  assert.doesNotMatch(loader, /new Date\(/u);
  const fallbackBranches = loader.split('const fallback = DEFAULT_PAGES.find(p => p.id === pageId);').slice(1);
  assert.equal(fallbackBranches.length, 2);
  for (const branch of fallbackBranches) {
    const fallbackPage = branch.slice(branch.indexOf('setPage({'), branch.indexOf('});') + 3);
    assert.match(fallbackPage, /title: fallback\.title,\s+content: fallback\.content\s+\}\);/u);
    assert.doesNotMatch(fallbackPage, /lastUpdated/u);
  }
});

test('stored CMS pages keep their real Updated date and body content', () => {
  assert.match(loader, /getDoc\(doc\(db, "pages", pageId\)\)/u);
  assert.match(loader, /title: data\.title \|\| "",\s+content: data\.content \|\| "",\s+lastUpdated: data\.lastUpdated \|\| undefined/u);
  assert.match(cms, /\{page\?\.lastUpdated && \([\s\S]*?Updated: \{page\.lastUpdated\}/u);
  assert.match(cms, /const parsedSections = page \? parseContent\(page\.content\) : \[\];/u);
  assert.match(cms, /\{page\?\.title\}/u);
});

test('CMS page routing and navigation are unchanged', () => {
  assert.match(app, /<CmsPage\n\s+pageId=\{currentPage\}\n\s+onBackToHome=\{\(\) => setCurrentPage\('home'\)\}/u);
  assert.match(cms, /onClick=\{onBackToHome\}/u);
  assert.match(cms, /<span>Return to Homepage<\/span>/u);
  for (const id of ['about-us', 'privacy-policy', 'terms-conditions', 'return-policy', 'warranty-policy', 'faq', 'contact-us']) {
    assert.match(cms, new RegExp(`id: "${id}"`, 'u'), id);
  }
});
