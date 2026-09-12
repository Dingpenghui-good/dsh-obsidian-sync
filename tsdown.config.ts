import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-obsidian-sync-v2',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
})
