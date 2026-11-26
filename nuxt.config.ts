// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  devtools: { enabled: true },

  // Admin console + PWA: client-rendered SPA, Nitro serves API + engine.
  ssr: false,

  modules: ['@nuxt/ui', '@nuxtjs/i18n', '@vite-pwa/nuxt', 'nuxt-auth-utils', '@vueuse/nuxt'],

  css: ['~/assets/css/main.css'],

  components: [{ path: '~/components', pathPrefix: false }],

  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant-TW' },
      title: 'Unifire',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#006FFF' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'description', content: 'Unifire — UniFi extension & automation console' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
      ],
    },
  },

  ui: {
    theme: { colors: ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral', 'vpn'] },
  },

  icon: {
    // Bundle icon collections so the app works on an offline LAN.
    serverBundle: { collections: ['lucide', 'circle-flags'] },
    clientBundle: { scan: true, sizeLimitKb: 512 },
  },

  fonts: {
    families: [
      { name: 'Inter', provider: 'google', weights: [400, 500, 600, 700] },
      { name: 'JetBrains Mono', provider: 'google', weights: [400, 500] },
    ],
  },

  i18n: {
    locales: [
      { code: 'zh-TW', language: 'zh-Hant-TW', name: '繁體中文', file: 'zh-TW.json' },
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
    ],
    defaultLocale: 'zh-TW',
    strategy: 'no_prefix',
    detectBrowserLanguage: { useCookie: true, cookieKey: 'unifire_locale', fallbackLocale: 'zh-TW' },
  },

  pwa: {
    strategies: 'buildSW',
    filename: 'sw.js',
    registerType: 'prompt',
    injectRegister: false,
    manifest: {
      id: '/',
      name: 'Unifire',
      short_name: 'Unifire',
      description: 'UniFi extension & automation console',
      lang: 'zh-Hant-TW',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      display_override: ['window-controls-overlay', 'standalone'],
      orientation: 'any',
      background_color: '#131416',
      theme_color: '#006FFF',
      categories: ['utilities', 'productivity'],
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [
        { name: '審核新裝置', short_name: '審核', url: '/approvals', icons: [{ src: '/icons/shortcut-approvals.png', sizes: '96x96' }] },
        { name: '人員與暫停上網', short_name: '人員', url: '/people', icons: [{ src: '/icons/shortcut-people.png', sizes: '96x96' }] },
        { name: '出口排程', short_name: '路由', url: '/routes', icons: [{ src: '/icons/shortcut-routes.png', sizes: '96x96' }] },
      ],
    },
    buildSW: {
      swSrc: 'service-worker/sw.ts',
      globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,webmanifest}'],
    },
    maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
    client: { installPrompt: true, periodicSyncForUpdates: 3600 },
    devOptions: { enabled: false, type: 'module' },
  },

  runtimeConfig: {
    // All overridable via NUXT_* env vars.
    dataDir: './.data',
    unifireSecret: '', // NUXT_UNIFIRE_SECRET — encrypts controller credentials & snapshots
    mockController: false, // NUXT_MOCK_CONTROLLER=true → use bundled fake UniFi
    session: {
      name: 'unifire-session',
      maxAge: 60 * 60 * 24 * 30,
      // Backend startup uses NUXT_SESSION_PASSWORD or session.key as the Nuxt app secret.
      cookie: { secure: true },
    },
    public: {
      appVersion: '0.1.0',
    },
  },

  nitro: {
    preset: 'node-server',
    experimental: { tasks: true },
    rollupConfig: {
      plugins: [{
        name: 'unifire:initialize-session-key',
        transform(code: string, id: string) {
          // Nitro 2 resolves and freezes the shared config during module evaluation.
          if (!/[/\\]nitropack[/\\]dist[/\\]runtime[/\\]internal[/\\]config\.mjs$/.test(id)) return
          const bootstrap = new URL('./server/runtime/session-key.ts', import.meta.url).pathname
          const marker = 'const _sharedRuntimeConfig ='
          if (!code.includes(marker)) throw new Error('Nitro runtime config initialization has changed')
          return {
            code: `import { initializeSessionKey } from ${JSON.stringify(bootstrap)};\n`
              + code.replace(marker, `initializeSessionKey();\n${marker}`),
            map: null,
          }
        },
      }],
    },
    serverAssets: [{ baseName: 'locales', dir: './i18n/locales' }],
  },

  typescript: {
    strict: true,
  },
})
