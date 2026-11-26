import type { SnapshotResourceT } from '#shared/schemas/insight'

type Transition = { before: string | undefined, after: string | undefined, ts: number }

export function createWriteLedger(now = Date.now) {
  const windowMs = 15_000
  const entries = new Map<string, Transition[]>()
  const key = (resource: SnapshotResourceT, id: string) => JSON.stringify([resource, id])
  function recent() {
    const threshold = now() - windowMs
    for (const [id, transitions] of entries) {
      const live = transitions.filter(entry => entry.ts >= threshold)
      if (live.length) entries.set(id, live)
      else entries.delete(id)
    }
  }
  return {
    record(resource: SnapshotResourceT, id: string, before?: string, after?: string) {
      recent()
      const index = key(resource, id)
      entries.set(index, [...entries.get(index) ?? [], { before, after, ts: now() }])
    },
    explains(resource: SnapshotResourceT, id: string, before?: string, after?: string) {
      recent()
      const reachable = new Set([before])
      for (const transition of entries.get(key(resource, id)) ?? []) {
        if (reachable.has(transition.before)) reachable.add(transition.after)
      }
      return reachable.has(after)
    },
  }
}
