import { and, eq, isNotNull } from 'drizzle-orm'
import type { z } from 'zod'
import type { LocateInput, SeriesRangeT } from '#shared/schemas/infra'
import type { Db } from '../../db'
import { infraDevices } from '../../db/schema'
import { systemContext, type ControllerService } from '../../services/controller'
import { UnifiError } from '../../unifi/errors'
import { serializeSite, type WriteContext, type WriteResult } from '../../unifi/writes'
import type { ControllerEvent } from '../../unifi/ws'
import { liveBus } from '../../utils/bus'
import { MINUTE } from '../access-time'
import { deviceEvents, deviceSeries } from './device-history'
import { createDeviceSampler } from './device-sampler'
import { infraDeviceDetail, listInfraDevices } from './device-views'

export function createInfra(db: Db, service: ControllerService, options: { now?: () => number, bus?: typeof liveBus } = {}) {
  const now = options.now ?? Date.now
  const bus = options.bus ?? liveBus
  const dirty = new Set<string>()
  const expiredLocates = new Map<string, number>()
  const operations = new Set<Promise<unknown>>()
  let lastPush = -Infinity
  let pushTimer: ReturnType<typeof setTimeout> | undefined
  let locateTimer: ReturnType<typeof setTimeout> | undefined
  let expiry: Promise<void> | undefined
  let active: (() => boolean) | undefined
  let stop = false

  function publish() {
    pushTimer = undefined
    if (!dirty.size || stop || active?.() === false) return
    lastPush = now()
    const macs = [...dirty]
    dirty.clear()
    bus.emit({ type: 'device', data: { macs } })
  }

  function changed(macs: string[]) {
    for (const mac of macs) dirty.add(mac)
    if (pushTimer || stop || active?.() === false) return
    const delay = lastPush + 5000 - now()
    if (delay <= 0) publish()
    else {
      pushTimer = setTimeout(publish, delay)
      pushTimer.unref()
    }
  }

  const sampler = createDeviceSampler(db, { emit: event => service.engine.emit('event', event), changed })
  let lastPoll: { at: number } | null = null
  function sample() {
    const runtime = service.runtime
    const poll = runtime?.cache.devicePoll()
    if (!runtime?.active() || !poll || poll === lastPoll) return
    sampler.sample(runtime.cache.snapshot().devices, runtime.config.site, runtime.scope, poll.at, runtime.ledger.explainsDeviceReboot)
    lastPoll = poll
  }

  const scopes = (scope: string) => eq(infraDevices.scope, scope)
  function find(mac: string, scope = service.runtime?.scope) {
    return scope ? db.select().from(infraDevices).where(and(scopes(scope), eq(infraDevices.mac, mac))).get() : undefined
  }

  function requireDevice(mac: string) {
    const row = find(mac)
    if (!row) throw new UnifiError('DEVICE_NOT_FOUND', 404)
    return row
  }

  function locateRows(scope: string) {
    return db.select().from(infraDevices).where(and(scopes(scope), isNotNull(infraDevices.locateUntil))).all()
  }

  function scheduleExpiry() {
    clearTimeout(locateTimer)
    locateTimer = undefined
    const runtime = service.runtime
    if (!runtime?.active() || stop || !active?.()) return
    const at = now()
    const deadlines = locateRows(runtime.scope).flatMap(row => row.locateUntil ?? [])
    if (!deadlines.length) return
    const next = Math.min(...deadlines)
    locateTimer = setTimeout(() => { void expire().catch(() => {}) }, next <= at ? 30_000 : next - at)
    locateTimer.unref()
  }

  function locate(mac: string, input: z.output<typeof LocateInput>, ctx: WriteContext, due?: number): Promise<WriteResult | undefined> {
    const runtime = service.runtime
    if (!runtime?.active() || stop) return Promise.reject(new UnifiError('UNIFI_NOT_CONFIGURED'))
    const pending = serializeSite(JSON.stringify(['locate', runtime.scope, mac]), async () => {
      if (stop || !runtime.active()) throw new UnifiError('UNIFI_INACTIVE')
      const row = find(mac, runtime.scope)
      if (!row) throw new UnifiError('DEVICE_NOT_FOUND', 404)
      if (due !== undefined && (row.locateUntil !== due || due > now() || service.status().mode !== 'live')) return
      return runtime.writes.deviceCommand(input.on ? 'set-locate' : 'unset-locate', mac, ctx, {
        label: row.name,
        onSent() {
          db.update(infraDevices).set({ locateUntil: input.on ? now() + input.minutes * MINUTE : null })
            .where(and(scopes(runtime.scope), eq(infraDevices.mac, mac))).run()
          if (due === undefined) changed([mac])
          expiredLocates.delete(JSON.stringify([runtime.scope, mac]))
        },
      })
    }).finally(() => {
      operations.delete(pending)
      if (!expiry) scheduleExpiry()
    })
    operations.add(pending)
    return pending
  }

  function expire() {
    if (expiry) return expiry
    const runtime = service.runtime
    if (!runtime?.active() || stop || active?.() === false) return Promise.resolve()
    const at = now()
    const expired = locateRows(runtime.scope).filter(row => row.locateUntil !== null && row.locateUntil <= at)
    const ended = expired.flatMap(row => {
      const key = JSON.stringify([runtime.scope, row.mac])
      if (expiredLocates.get(key) === row.locateUntil) return []
      expiredLocates.set(key, row.locateUntil!)
      return [row.mac]
    })
    if (ended.length) changed(ended)
    expiry = Promise.allSettled(expired.map(row => locate(row.mac, { on: false, minutes: 5 }, systemContext, row.locateUntil!)))
      .then(() => {}).finally(() => {
        expiry = undefined
        scheduleExpiry()
      })
    return expiry
  }

  function onEvent(event: ControllerEvent) {
    if (!active?.()) return
    if (event.type === 'cache.changed' && event.resource === 'devices') sample()
    if (event.type === 'controller.mode' || event.type === 'controller.reconnected') void expire().catch(() => {})
  }

  return {
    list: () => listInfraDevices(db, service, now()),
    get(mac: string) {
      const view = listInfraDevices(db, service, now(), mac)[0]
      if (!view) throw new UnifiError('DEVICE_NOT_FOUND', 404)
      return view
    },
    detail: (mac: string) => infraDeviceDetail(db, service, mac, now()),
    series(mac: string, range: SeriesRangeT) {
      requireDevice(mac)
      return deviceSeries(db, mac, range, now())
    },
    events(mac: string, from: number, to: number) {
      requireDevice(mac)
      return deviceEvents(db, mac, from, to)
    },
    locate, expire,
    async restart(mac: string, confirmGateway: boolean, ctx: WriteContext) {
      requireDevice(mac)
      const runtime = service.runtime
      if (!runtime?.active()) throw new UnifiError('UNIFI_NOT_CONFIGURED')
      await runtime.writes.deviceAction({ cmd: 'restart', macs: [mac] }, ctx, confirmGateway)
      return { ok: true as const }
    },
    start(hasLease: () => boolean) {
      active = hasLease
      service.engine.on('event', onEvent)
      sample()
      void expire().catch(() => {})
      return async () => {
        stop = true
        service.engine.off('event', onEvent)
        clearTimeout(pushTimer)
        clearTimeout(locateTimer)
        await Promise.allSettled([...operations, expiry])
      }
    },
  }
}
