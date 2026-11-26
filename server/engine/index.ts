import type { Db } from '../db'
import type { ControllerService } from '../services/controller'
import { createSettingsService } from '../services/settings'
import type { ControllerEvent } from '../unifi/ws'
import { createManagedRoutes } from './managed-routes'
import { createProbeRoutes } from './probes/routes'
import { createProbeRunner } from './probes/runner'
import { createSweep } from './probes/sweep'
import { startReconciler } from './reconciler'

export function createRouting(db: Db, service: ControllerService) {
  const managed = createManagedRoutes(db, service)
  const probes = createProbeRoutes(db, service)
  const runner = createProbeRunner(db, service, probes)
  const sweep = createSweep(db, service, probes)
  const settings = createSettingsService(db)
  let stopped = false
  let probeTimer: ReturnType<typeof setTimeout> | undefined
  let sweepTimer: ReturnType<typeof setTimeout> | undefined
  let settingsWork: Promise<unknown> | undefined

  function probeTick() {
    clearTimeout(probeTimer)
    if (stopped) return
    void runner.round().catch(() => {})
    probeTimer = setTimeout(probeTick, settings.get().probe.intervalSec * 1_000)
    probeTimer.unref()
  }

  function scheduleSweep() {
    clearTimeout(sweepTimer)
    if (stopped) return
    const interval = settings.get().probe.sweepIntervalMin
    if (!interval) return
    sweepTimer = setTimeout(() => {
      if (service.status().connected && service.status().mode === 'live') {
        try { sweep.start() } catch { /* A later tick retries when probe prerequisites are available. */ }
      }
      scheduleSweep()
    }, interval * 60_000)
    sweepTimer.unref()
  }

  function onEvent(event: ControllerEvent) {
    if (event.type === 'routing.settings' || event.type === 'controller.mode' || event.type === 'controller.reconnected') {
      if (event.type === 'routing.settings') scheduleSweep()
      probeTick()
      settingsWork ??= sweep.recoverIdle().catch(() => {}).finally(() => { settingsWork = undefined })
    }
  }
  const beforeChange = async () => {
    await settingsWork
    await sweep.cancel(true)
  }

  function start() {
    const stopReconciler = startReconciler(service, managed)
    service.engine.on('event', onEvent)
    service.beforeRoutingChange.add(beforeChange)
    void service.ready().then(() => {
      if (stopped) return
      probeTick()
      settingsWork ??= sweep.recoverIdle().catch(() => {}).finally(() => { settingsWork = undefined })
    }).catch(() => {})
    scheduleSweep()
    return async () => {
      stopped = true
      clearTimeout(probeTimer)
      clearTimeout(sweepTimer)
      service.engine.off('event', onEvent)
      service.beforeRoutingChange.delete(beforeChange)
      await Promise.allSettled([stopReconciler(), sweep.cancel(), runner.idle(), settingsWork, probes.idle()])
    }
  }

  return { managed, probes, runner, sweep, start }
}
