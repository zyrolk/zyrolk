import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(process.env.ZYRO_SOURCE_ROOT || path.resolve(fixtureRoot, '../../../../../../..'));

export default {
  root: fixtureRoot,
  publicDir: path.join(sourceRoot, 'public'),
  define: {
    'import.meta.env.DEV': 'false',
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: path.join(sourceRoot, 'src/firebase.ts'), replacement: path.join(fixtureRoot, 'firebaseMock.ts') },
      {
        find: /src[\\/]services[\\/]storefront[\\/]homepagePreviewPresentation\.ts$/,
        replacement: path.join(fixtureRoot, 'homepagePreviewPresentationMock.ts'),
      },
      { find: '@zyro', replacement: path.join(sourceRoot, 'src') },
      { find: /^react$/, replacement: path.join(sourceRoot, 'node_modules/react/index.js') },
      { find: /^react\/(.+)$/, replacement: `${path.join(sourceRoot, 'node_modules/react')}/$1` },
      { find: /^react-dom$/, replacement: path.join(sourceRoot, 'node_modules/react-dom/index.js') },
      { find: /^react-dom\/(.+)$/, replacement: `${path.join(sourceRoot, 'node_modules/react-dom')}/$1` },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 4177,
    strictPort: true,
    fs: { allow: [sourceRoot, fixtureRoot] },
  },
};
