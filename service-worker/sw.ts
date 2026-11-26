/// <reference lib="webworker" />
/**
 * Unifire service worker
 * - precache the app shell & assets, network-first for pages and read-only API data (offline: last known state)
 * - Web Push with action buttons (approve / block / extend) that call back the API with signed one-time tokens
 * - App badge = pending approvals + extension requests
 */
import { cleanupOutdatedCaches, precacheAndRoute } from '@vite-pwa/workbox-swkit/precaching'
import { NavigationRoute, registerRoute } from '@vite-pwa/workbox-swkit/routing'
import { NetworkFirst } from '@vite-pwa/workbox-swkit/strategies'
import { ExpirationPlugin } from '@vite-pwa/workbox-swkit/expiration'

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string, revision: string | null }> }

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// SPA navigations: network first, fall back to the last cached shell when offline.
registerRoute(new NavigationRoute(new NetworkFirst({
  cacheName: 'uf-pages',
  networkTimeoutSeconds: 4,
  plugins: [new ExpirationPlugin({ maxEntries: 20 })],
}), { denylist: [/^\/api\//, /^\/kiosk\//] }))

// Read-only API snapshots for offline viewing. Never cache SSE, auth, or mutations (non-GET aren't routed).
registerRoute(
  ({ url, request }) => request.method === 'GET'
    && url.pathname.startsWith('/api/')
    && /^\/api\/(dashboard|egresses|managed-routes|routes|people|clients|approvals|quotas|me\/summary|controller|settings|networks|presence|reports)/.test(url.pathname),
  new NetworkFirst({
    cacheName: 'uf-api',
    networkTimeoutSeconds: 5,
    plugins: [new ExpirationPlugin({ maxEntries: 120, maxAgeSeconds: 7 * 24 * 3600 })],
  }),
)

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/* ───────────────────────────── Push ───────────────────────────── */

interface PushAction { action: string, title: string, endpoint: string }
interface PushData {
  title: string
  body: string
  tag?: string
  url?: string
  event: string
  badgeCount?: number
  actions?: PushAction[]
}

const ACTION_ICONS: Record<string, string> = {
  approve: '/icons/action-approve.png',
  block: '/icons/action-block.png',
  extend: '/icons/action-approve.png',
  deny: '/icons/action-block.png',
}

async function setBadge(n: number | undefined) {
  const nav = self.navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>, clearAppBadge?: () => Promise<void> }
  if (n == null) return
  try {
    if (n > 0) await nav.setAppBadge?.(n)
    else await nav.clearAppBadge?.()
  }
  catch { /* unsupported */ }
}

self.addEventListener('push', (event) => {
  let data: PushData
  try { data = event.data?.json() as PushData }
  catch { data = { title: 'Unifire', body: event.data?.text() ?? '', event: 'rule' } }

  const options: NotificationOptions & { actions?: { action: string, title: string, icon?: string }[], renotify?: boolean, vibrate?: number[] } = {
    body: data.body,
    tag: data.tag,
    renotify: !!data.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { url: data.url ?? '/', actions: data.actions ?? [], event: data.event },
    actions: (data.actions ?? []).slice(0, 2).map(a => ({ action: a.action, title: a.title, icon: ACTION_ICONS[a.action] })),
    requireInteraction: data.event === 'new_device' || data.event === 'extension_request',
    vibrate: [80, 40, 80],
  }
  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title, options),
    setBadge(data.badgeCount),
  ]))
})

async function focusOrOpen(url: string) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const target = new URL(url, self.location.origin).href
  for (const c of all) {
    if ('focus' in c) {
      await (c as WindowClient).focus()
      if ('navigate' in c) await (c as WindowClient).navigate(target).catch(() => {})
      return
    }
  }
  await self.clients.openWindow(target)
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification
  const data = n.data as { url: string, actions: PushAction[], event: string }
  n.close()
  const picked = event.action ? data.actions.find(a => a.action === event.action) : undefined

  event.waitUntil((async () => {
    if (!picked) return focusOrOpen(data.url)
    try {
      const res = await fetch(picked.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: new URL(picked.endpoint, self.location.origin).searchParams.get('token') }),
        credentials: 'include',
      })
      const ok = res.ok
      await self.registration.showNotification(ok ? '✓ Unifire' : '✗ Unifire', {
        body: ok ? `${picked.title}` : `${picked.title} — ${res.status}`,
        tag: `${n.tag ?? 'uf'}-result`,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        silent: true,
      })
    }
    catch {
      await focusOrOpen(data.url)
    }
  })())
})

self.addEventListener('pushsubscriptionchange', (event) => {
  // Re-subscribe with the same VAPID key and tell the server (best effort).
  const e = event as Event & { oldSubscription?: PushSubscription, waitUntil: (p: Promise<unknown>) => void }
  e.waitUntil((async () => {
    const res = await fetch('/api/push/vapid', { credentials: 'include' })
    if (!res.ok) return
    const { publicKey } = await res.json() as { publicKey: string }
    const pad = '='.repeat((4 - (publicKey.length % 4)) % 4)
    const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'))
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from([...raw].map(c => c.charCodeAt(0))) })
    const json = sub.toJSON() as { endpoint: string, keys: { p256dh: string, auth: string } }
    await fetch('/api/push/subscribe', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) })
  })())
})
