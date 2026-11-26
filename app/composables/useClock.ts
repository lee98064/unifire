/** Reactive "now" that ticks every `intervalMs` (VueUse 15 dropped useNow's interval option). */
export function useClock(intervalMs = 1000) {
  const now = shallowRef(new Date())
  if (import.meta.client) {
    const id = setInterval(() => (now.value = new Date()), intervalMs)
    if (getCurrentScope()) onScopeDispose(() => clearInterval(id))
  }
  return now
}
