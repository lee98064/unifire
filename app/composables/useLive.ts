import type { LiveEventT } from '#shared/schemas/system'

type LiveType = LiveEventT['type']
type Handler<K extends LiveType> = (data: Extract<LiveEventT, { type: K }>['data']) => void

const handlers = new Map<LiveType, Set<Handler<any>>>()
let source: EventSource | null = null
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

/** Which useFetch keys to refresh when an event arrives (debounced). */
const invalidations: Partial<Record<LiveType, string[]>> = {
  'egress.health': ['egresses', 'dashboard'],
  'route.switched': ['managed-routes', 'dashboard', 'switch-log', 'routes'],
  'route.changed': ['managed-routes', 'routes'],
  'client.changed': ['clients', 'dashboard'],
  'approval.new': ['approvals', 'dashboard', 'badges'],
  'presence': ['people', 'dashboard'],
  'quota': ['people', 'quotas', 'me'],
  'extension.request': ['extension-requests', 'badges'],
  'audit': ['audit-feed'],
  'controller': ['controller-status'],
  'sweep': ['egresses', 'sweep'],
}

const pending = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRefresh(keys: string[]) {
  keys.forEach(k => pending.add(k))
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    const ks = [...pending]
    pending.clear()
    flushTimer = null
    refreshNuxtData(ks)
  }, 400)
}

/**
 * Singleton SSE connection to /api/events.
 * Components register typed handlers with `on()`; cache invalidation is automatic.
 */
export function useLive() {
  const connected = useState('live-connected', () => false)
  const toast = useToast()
  const { t, te } = useI18n()

  function dispatch(type: LiveType, data: unknown) {
    handlers.get(type)?.forEach(h => h(data as never))
    const keys = invalidations[type]
    if (keys) scheduleRefresh(keys)
    if (type === 'toast') {
      const d = data as Extract<LiveEventT, { type: 'toast' }>['data']
      toast.add({ title: te(d.titleKey) ? t(d.titleKey, d.params) : d.titleKey, color: d.level === 'info' ? 'info' : d.level })
    }
  }

  function connect() {
    if (!import.meta.client || source) return
    source = new EventSource('/api/events', { withCredentials: true })
    source.onopen = () => { connected.value = true; retry = 0 }
    source.onerror = () => {
      connected.value = false
      source?.close()
      source = null
      const delay = Math.min(30_000, 1000 * 2 ** retry++)
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = setTimeout(connect, delay)
    }
    const types: LiveType[] = ['hello', 'controller', 'egress.health', 'route.switched', 'route.changed', 'client.changed', 'approval.new', 'presence', 'quota', 'extension.request', 'audit', 'sweep', 'toast']
    for (const type of types) {
      source.addEventListener(type, (ev) => {
        try { dispatch(type, JSON.parse((ev as MessageEvent).data)) }
        catch { /* ignore malformed */ }
      })
    }
  }

  function disconnect() {
    source?.close()
    source = null
    connected.value = false
  }

  function on<K extends LiveType>(type: K, handler: Handler<K>) {
    if (!handlers.has(type)) handlers.set(type, new Set())
    handlers.get(type)!.add(handler)
    if (getCurrentInstance()) onBeforeUnmount(() => handlers.get(type)?.delete(handler))
    return () => handlers.get(type)?.delete(handler)
  }

  return { connected, connect, disconnect, on }
}
