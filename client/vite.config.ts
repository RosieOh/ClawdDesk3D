import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Vendor groups get their own long-lived chunks, so an app change doesn't re-download three.js. */
const VENDOR_CHUNKS: Record<string, RegExp> = {
  three: /node_modules\/three\//,
  r3f: /node_modules\/(@react-three|three-stdlib|troika-|postprocessing|maath|camera-controls|@monogrid|meshline|stats-gl|three-mesh-bvh)/,
  react: /node_modules\/(react|react-dom|scheduler|zustand)\//,
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: false },
  build: {
    // three.js alone is ~700 kB minified; anything bigger than that is worth a look.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [name, re] of Object.entries(VENDOR_CHUNKS)) if (re.test(id)) return name;
          return undefined;
        },
      },
    },
  },
});
