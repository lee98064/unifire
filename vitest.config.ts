import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Use the same h3 major Nitro uses under pnpm's isolated dependency layout.
const requireFromNuxt = createRequire(import.meta.resolve('nuxt'))
const requireFromNuxtServer = createRequire(requireFromNuxt.resolve('@nuxt/nitro-server'))
const requireFromNitro = createRequire(requireFromNuxtServer.resolve('nitropack/package.json'))

export default defineConfig({
  resolve: {
    alias: {
      h3: requireFromNitro.resolve('h3'),
      '#shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '~~/server': fileURLToPath(new URL('./server', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/server/**/*.test.ts', 'tests/shared/**/*.test.ts'],
  },
})
