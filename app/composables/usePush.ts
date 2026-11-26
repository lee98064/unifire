/** Web Push subscription for this browser/device. */
export function usePush() {
  const supported = computed(() => import.meta.client && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)
  const permission = ref<NotificationPermission>(import.meta.client && 'Notification' in window ? Notification.permission : 'default')
  const subscribed = ref(false)
  const secure = computed(() => import.meta.client && window.isSecureContext)

  async function refreshState() {
    if (!supported.value) return
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    subscribed.value = !!sub
    permission.value = Notification.permission
  }

  function urlBase64ToUint8Array(base64: string) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4)
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
  }

  async function subscribe(deviceLabel?: string) {
    if (!supported.value) throw new Error('unsupported')
    permission.value = await Notification.requestPermission()
    if (permission.value !== 'granted') throw new Error('denied')
    const reg = await navigator.serviceWorker.ready
    const { publicKey } = await $fetch<{ publicKey: string }>('/api/push/vapid')
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
    const json = sub.toJSON() as { endpoint: string, keys: { p256dh: string, auth: string } }
    await $fetch('/api/push/subscribe', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys, deviceLabel: deviceLabel ?? navigator.userAgent.slice(0, 80) } })
    subscribed.value = true
  }

  async function unsubscribe() {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      await $fetch('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {})
      await sub.unsubscribe()
    }
    subscribed.value = false
  }

  onMounted(refreshState)
  return { supported, secure, permission, subscribed, subscribe, unsubscribe, refreshState }
}
