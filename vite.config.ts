import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    esbuild: {
      pure: ['console.log', 'console.info', 'console.debug'],
    },
    build: {
      modulePreload: {
        resolveDependencies(_filename, deps) {
          return deps.filter((dep) => (
            !dep.includes('admin-') &&
            !dep.includes('supplier-') &&
            !dep.includes('charts-')
          ));
        },
      },
      rollupOptions: {
        // Keep long-lived platform dependencies cacheable and administrative bundles out of storefront preloads.
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('@firebase/storage') || id.includes('/firebase/storage/')) {
                return 'firebase-storage';
              }
              if (id.includes('@firebase/firestore') || id.includes('/firebase/firestore/')) {
                return 'firebase-firestore';
              }
              if (id.includes('@firebase/auth') || id.includes('/firebase/auth/')) {
                return 'firebase-auth';
              }
              if (id.includes('firebase')) {
                return 'firebase-core';
              }
              if (id.includes('lucide-react')) {
                return 'icons';
              }
              if (id.includes('react') || id.includes('react-dom') || id.includes('motion')) {
                return 'react-vendor';
              }
              if (id.includes('recharts')) {
                return 'charts';
              }
            }

            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    preview: {
      port: 3000,
      host: '0.0.0.0',
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
