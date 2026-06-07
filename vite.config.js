import { defineConfig } from 'vite'

export default defineConfig({
  base: '/towerofHanoi/',
  optimizeDeps: {
    // Vite's pre-bundle drops TSL re-exports (Fn, pass, etc.) and breaks volumetric lighting.
    exclude: ['three', 'three/webgpu', 'three/tsl'],
  },
  build: {
    outDir: 'dist'
  },
})
