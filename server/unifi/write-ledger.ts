import type { SnapshotResourceT } from '#shared/schemas/insight'

type Transition = { before: string | undefined, after: string | undefined, ts: number }

export function createWriteLedger(now = Date.now) {
  const powerWindow = 15 * 60_000
  const powerEvents = new Map<string, number>()
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
  function prunePowerEvents(at: number) {
    for (const [mac, ts] of powerEvents) if (at - ts > powerWindow) powerEvents.delete(mac)
  }

  return {
    recordDevicePower(macs: readonly string[]) {
      const at = now()
      prunePowerEvents(at)
      for (const mac of macs) powerEvents.set(mac, at)
    },
    explainsDeviceReboot(mac: string, at = now()) {
      prunePowerEvents(at)
      const ts = powerEvents.get(mac)
      return ts !== undefined && ts <= at && at - ts <= powerWindow
    },
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
