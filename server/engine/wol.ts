import { randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { isIP } from 'node:net'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import { WolTarget, type WolTargetInput } from '#shared/schemas/automation'
import { Mac } from '#shared/schemas/common'
import type { Db } from '../db'
import { wolTargets } from '../db/schema'
import { createAuditService } from '../services/audit'
import { systemContext, type ControllerService } from '../services/controller'
import { createSettingsService } from '../services/settings'
import type { WriteContext } from '../unifi/writes'
import { apiError } from '../utils/api-error'
import { createCronJobs, validateCron } from './automation-cron'

type Input = z.output<typeof WolTargetInput>
type Send = (packet: Buffer, port: number, broadcast: string) => Promise<void>

export function magicPacket(mac: string) {
  const address = Buffer.from(Mac.parse(mac).replaceAll(':', ''), 'hex')
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(address)])
}

export function subnetBroadcast(cidr: string) {
  const [address, prefix, ...rest] = cidr.split('/')
  if (!address || isIP(address) !== 4 || !prefix || !/^\d{1,2}$/.test(prefix) || rest.length) return null
  const length = Number(prefix)
  if (length < 1 || length > 30) return null
  const ip = address.split('.').reduce((value, octet) => (value << 8) | Number(octet), 0)
  const broadcast = ip | (0xffffffff >>> length)
  return [24, 16, 8, 0].map(shift => (broadcast >>> shift) & 255).join('.')
}

const sendUdp: Send = (packet, port, address) => new Promise((resolve, reject) => {
  const socket = createSocket('udp4')
  let settled = false
  const finish = (error?: Error | null) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.close()
    if (error) reject(error)
    else resolve()
  }
  const timer = setTimeout(() => finish(new Error('Wake-on-LAN socket timed out')), 5000)
  timer.unref()
  socket.once('error', finish)
  socket.bind(() => {
    try {
      socket.setBroadcast(true)
      socket.send(packet, port, address, finish)
    } catch (error) { finish(error instanceof Error ? error : new Error('Wake-on-LAN send failed')) }
  })
})

export function createWol(db: Db, service: ControllerService, options: { send?: Send, now?: () => number } = {}) {
  const send = options.send ?? (service.status().mock ? async () => {} : sendUdp)
  const now = options.now ?? Date.now
  const settings = createSettingsService(db)
  const audit = createAuditService(db)
  const jobs = createCronJobs()
  let leased: (() => boolean) | undefined
  const active = new Set<Promise<unknown>>()

  function get(id: string) {
    const row = db.select().from(wolTargets).where(eq(wolTargets.id, id)).get()
    if (!row) throw apiError(404, 'WOL_NOT_FOUND', 'errors.wolNotFound')
    return row
  }

  function view(row: ReturnType<typeof get>) {
    const runtime = service.runtime
    const inventory = runtime?.cache.snapshot()
    const known = inventory?.knownClients.find(station => station.mac === row.mac)
    const online = inventory?.activeClients.find(station => station.mac === row.mac)
    const network = inventory?.networks.find(net => net._id === (online?.network_id || known?.network_id))
    const networkId = online?.network_id || known?.network_id
    const broadcast = row.broadcast ?? (networkId ? settings.get().broadcastOverrides[networkId] : undefined)
      ?? (network?.ip_subnet ? subnetBroadcast(network.ip_subnet) : null)
    return WolTarget.parse({ ...row, effectiveBroadcast: broadcast !== null && isIP(broadcast) === 4 ? broadcast : null,
      online: runtime?.cache.activeClientsAt() != null ? !!online : null })
  }

  function sync(row: ReturnType<typeof get>) {
    if (!leased) return
    jobs.set(row.id, row.schedule, () => leased?.() ? wake(row.id, systemContext) : Promise.resolve())
  }

  function save(id: string, data: Input, updating: boolean) {
    if ((data.broadcast !== null && isIP(data.broadcast) !== 4) || data.port < 1 || data.port > 65535) {
      throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
    }
    if (data.schedule) validateCron(data.schedule)
    const row = updating ? db.update(wolTargets).set(data).where(eq(wolTargets.id, id)).returning().get()
      : db.insert(wolTargets).values({ id, ...data }).returning().get()
    sync(row)
    return view(row)
  }

  function wake(id: string, ctx: WriteContext) {
    const task = (async () => {
      const target = view(get(id))
      const dryRun = service.status().mode === 'dry-run' || !!ctx.dryRun
      let failure: unknown
      try {
        if (!target.effectiveBroadcast) throw apiError(409, 'WOL_BROADCAST_UNKNOWN', 'errors.wolBroadcastUnknown')
        if (!dryRun) {
          try { await send(magicPacket(target.mac), target.port, target.effectiveBroadcast) }
          catch { throw apiError(502, 'WOL_SEND_FAILED', 'errors.wolSendFailed') }
          db.update(wolTargets).set({ lastWokeAt: now() }).where(eq(wolTargets.id, id)).run()
        }
      } catch (error) { failure = error; throw error }
      finally {
        audit.record({ actor: ctx.actor, category: 'wol', action: 'wol.wake', severity: failure ? 'error' : dryRun ? 'info' : 'success',
          target: { type: 'wol', id, label: target.name }, messageKey: failure ? 'audit.wol.failed' : dryRun ? 'audit.wol.preview' : 'audit.wol.woke',
          messageParams: { name: target.name, mac: target.mac, broadcast: target.effectiveBroadcast ?? '' }, dryRun })
      }
      return view(get(id))
    })().finally(() => { active.delete(task) })
    active.add(task)
    return task
  }

  return {
    list: () => db.select().from(wolTargets).orderBy(wolTargets.name, wolTargets.id).all().map(view),
    create: (data: Input) => save(randomUUID(), data, false),
    update(id: string, data: Partial<Input>) {
      const { id: _id, lastWokeAt: _lastWokeAt, ...current } = get(id)
      return save(id, { ...current, ...data }, true)
    },
    delete(id: string) {
      get(id)
      jobs.set(id, null, async () => {})
      db.delete(wolTargets).where(eq(wolTargets.id, id)).run()
      return { ok: true as const }
    },
    wake,
    start(hasLease: () => boolean) {
      leased = hasLease
      for (const row of db.select().from(wolTargets).all()) sync(row)
      return async () => {
        leased = undefined
        jobs.stop()
        await Promise.allSettled(active)
      }
    },
  }
}
