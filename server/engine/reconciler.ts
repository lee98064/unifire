import { wallClock } from '#shared/utils/schedule'
import type { ControllerService } from '../services/controller'
import { liveBus } from '../utils/bus'
import type { ControllerEvent } from '../unifi/ws'
import type { createManagedRoutes } from './managed-routes'

const MINUTE = 60_000

export function nextHourBoundary(at: number, timezone: string) {
  // Search UTC minutes and use the shared timezone helper. This also handles
  // zones with half-hour DST shifts, including a skipped or repeated local hour.
  const minute = Math.floor(at / MINUTE) * MINUTE
  for (let i = 1; i <= 120; i++) {
    const candidate = minute + i * MINUTE
    if (wallClock(candidate, timezone).minute === 0) return candidate
  }
  return minute + MINUTE
}

export function startReconciler(service: ControllerService, routes: ReturnType<typeof createManagedRoutes>,
  now = Date.now) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let work: Promise<void> | undefined
  let requested = false
  let expirations = new Map<string, number>()

  function schedule() {
    clearTimeout(timer)
    if (stopped) return
    const at = now()
    let wake = at + 30_000
    for (const [managedRouteId, endsAt] of expirations) {
      if (endsAt <= at) liveBus.emit({ type: 'route.changed', data: { managedRouteId } })
    }
    expirations = new Map()
    const zones = new Set<string>()
    for (const timing of routes.timing(at)) {
      if (timing.override) {
        expirations.set(timing.managedRouteId, timing.override.endsAt)
        wake = Math.min(wake, timing.override.endsAt)
      }
      if (timing.enabled) zones.add(timing.timezone)
    }
    for (const zone of zones) wake = Math.min(wake, nextHourBoundary(at, zone))
    timer = setTimeout(request, Math.max(0, wake - now()))
    timer.unref()
  }

  function request() {
    if (stopped) return
    requested = true
    schedule()
    if (work) return
    work = (async () => {
      while (requested && !stopped) {
        requested = false
        await routes.reconcile().catch(() => {})
      }
    })().finally(() => { work = undefined })
  }

  function onEvent(event: ControllerEvent) {
    if (event.type === 'routing.changed' || event.type === 'egress.healthChanged' || event.type === 'controller.mode'
      || event.type === 'controller.reconnected' || event.type === 'routing.settings'
      || event.type === 'cache.changed' && (event.resource === 'routes' || event.resource === 'networks')) request()
  }

  service.engine.on('event', onEvent)
  request()
  return async () => {
    stopped = true
    clearTimeout(timer)
    service.engine.off('event', onEvent)
    await work
  }
}
