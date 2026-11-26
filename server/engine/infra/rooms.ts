import { randomUUID } from 'node:crypto'
import { and, eq, gte, isNull, lt, lte, max, or } from 'drizzle-orm'
import { Room, RoomTimeline } from '#shared/schemas/infra'
import type { PersonT } from '#shared/schemas/access'
import type { z } from 'zod'
import type { RoomInput } from '#shared/schemas/infra'
import type { Db } from '../../db'
import { apRooms, infraDevices, people, rooms, roomSegments } from '../../db/schema'
import type { ControllerService } from '../../services/controller'
import { deviceMac } from '../../unifi/device-shape'
import type { WireStation } from '../../unifi/endpoints/schemas'
import { apiError } from '../../utils/api-error'
import { liveBus } from '../../utils/bus'
import { DAY, HOUR, MINUTE } from '../access-time'

type RoomData = z.output<typeof RoomInput>
type Segment = typeof roomSegments.$inferSelect
type Location = Pick<Segment, 'apMac' | 'roomId'>

export function currentRoom(db: Db, scope: string, personId: string) {
  return db.select().from(roomSegments).where(and(eq(roomSegments.scope, scope),
    eq(roomSegments.personId, personId), isNull(roomSegments.end))).get()
}

export function createRooms(db: Db, service: ControllerService, now = Date.now, bus = liveBus) {
  const pending = new Map<string, Location & { minute: number, count: number }>()
  let observedScope: string | undefined
  let nextPrune = 0
  const scope = () => service.runtime?.scope ?? ''

  function list() {
    const mappings = db.select({ apMac: apRooms.apMac, roomId: apRooms.roomId }).from(apRooms)
      .innerJoin(infraDevices, eq(infraDevices.mac, apRooms.apMac)).where(eq(infraDevices.scope, scope())).orderBy(apRooms.apMac).all()
    const open = db.select().from(roomSegments).where(and(eq(roomSegments.scope, scope()), isNull(roomSegments.end)))
      .orderBy(roomSegments.personId).all()
    return Room.array().parse(db.select().from(rooms).orderBy(rooms.order, rooms.name, rooms.id).all().map(room => ({
      ...room, apMacs: mappings.filter(ap => ap.roomId === room.id).map(ap => ap.apMac),
      occupants: open.filter(segment => segment.roomId === room.id).map(segment => segment.personId),
    })))
  }

  function requireRoom(id: string) {
    const room = db.select().from(rooms).where(eq(rooms.id, id)).get()
    if (!room) throw apiError(404, 'ROOM_NOT_FOUND', 'errors.roomNotFound')
    return room
  }

  function publish(personId: string, from: string | null, to: string | null, formerName?: string) {
    if (from && from !== to) service.engine.emit('event', { type: 'person.room_left', personId, roomId: from, room: formerName })
    if (to && from !== to) service.engine.emit('event', { type: 'person.room_entered', personId, roomId: to })
    bus.emit({ type: 'room', data: { personId, roomId: to } })
  }

  function observe(controllerScope: string, roster: readonly PersonT[], home: ReadonlySet<string>,
    stations: readonly WireStation[], at: number, dwell: number) {
    if (observedScope !== controllerScope) {
      pending.clear()
      observedScope = controllerScope
    }
    const minute = Math.floor(at / MINUTE)
    const active = new Map(stations.map(station => [station.mac, station]))
    const mappings = new Map(db.select().from(apRooms).all().map(row => [row.apMac, row.roomId]))
    const changes: { personId: string, from: string | null, to: string | null }[] = []
    db.transaction(tx => {
      const open = tx.select().from(roomSegments).where(and(eq(roomSegments.scope, controllerScope), isNull(roomSegments.end))).all()
      const byPerson = new Map(open.map(row => [row.personId, row]))
      for (const person of roster) {
        const personId = person.id
        const previous = byPerson.get(personId)
        if (!home.has(personId)) {
          pending.delete(personId)
          if (previous) {
            tx.update(roomSegments).set({ end: Math.max(at, previous.start) }).where(eq(roomSegments.id, previous.id)).run()
            changes.push({ personId, from: previous.roomId, to: null })
          }
          continue
        }
        let best: { apMac: string, signal: number } | undefined
        for (const mac of person.presenceMacs) {
          const station = active.get(mac)
          const apMac = station?.is_wired === true ? null : deviceMac(station?.ap_mac)
          const signal = station?.signal ?? -Infinity
          if (apMac && (!best || signal > best.signal)) best = { apMac, signal }
        }
        if (!best) {
          pending.delete(personId)
          continue
        }
        const { apMac } = best
        const roomId = mappings.get(apMac) ?? null
        if (previous?.apMac === apMac && previous.roomId === roomId) {
          pending.delete(personId)
          continue
        }
        const candidate = pending.get(personId)
        if (candidate && candidate.minute > minute) continue
        const same = candidate?.apMac === apMac && candidate.roomId === roomId
        const count = same && candidate.minute === minute ? candidate.count
          : same && candidate.minute === minute - 1 ? candidate.count + 1 : 1
        if (count < dwell) {
          pending.set(personId, { apMac, roomId, count, minute })
          continue
        }
        const lastEnd = previous ? null : tx.select({ ts: max(roomSegments.end) }).from(roomSegments)
          .where(and(eq(roomSegments.scope, controllerScope), eq(roomSegments.personId, personId))).get()?.ts
        const start = Math.max(at, previous?.start ?? lastEnd ?? at)
        if (previous) tx.update(roomSegments).set({ end: start }).where(eq(roomSegments.id, previous.id)).run()
        tx.insert(roomSegments).values({ id: randomUUID(), scope: controllerScope, personId, apMac, roomId, start }).run()
        pending.delete(personId)
        changes.push({ personId, from: previous?.roomId ?? null, to: roomId })
      }
      if (at >= nextPrune) tx.delete(roomSegments).where(lt(roomSegments.end, at - 365 * DAY)).run()
    })
    if (at >= nextPrune) nextPrune = at + HOUR
    for (const change of changes) publish(change.personId, change.from, change.to)
  }

  return {
    list, observe,
    create(input: RoomData) {
      const id = randomUUID()
      db.insert(rooms).values({ ...input, id }).run()
      return Room.parse({ ...input, id, apMacs: [], occupants: [] })
    },
    update(id: string, input: Partial<RoomData>) {
      requireRoom(id)
      if (Object.keys(input).length) db.update(rooms).set(input).where(eq(rooms.id, id)).run()
      return list().find(room => room.id === id)!
    },
    assign(apMac: string, roomId: string | null) {
      db.transaction(tx => {
        const device = tx.select().from(infraDevices).where(and(eq(infraDevices.scope, scope()), eq(infraDevices.mac, apMac))).get()
        if (!device) throw apiError(404, 'DEVICE_NOT_FOUND', 'errors.deviceNotFound')
        if (roomId !== null && device.type !== 'ap') throw apiError(400, 'ROOM_AP_REQUIRED', 'errors.roomApRequired')
        if (roomId === null) tx.delete(apRooms).where(eq(apRooms.apMac, apMac)).run()
        else {
          requireRoom(roomId)
          tx.insert(apRooms).values({ apMac, roomId }).onConflictDoUpdate({ target: apRooms.apMac, set: { roomId } }).run()
        }
        tx.update(infraDevices).set({ roomId }).where(eq(infraDevices.mac, apMac)).run()
      })
      bus.emit({ type: 'device', data: { macs: [apMac] } })
      return list()
    },
    delete(id: string) {
      const room = requireRoom(id)
      const at = now()
      const { affected, macs } = db.transaction(tx => {
        const affected = tx.select().from(roomSegments).where(and(eq(roomSegments.roomId, id), isNull(roomSegments.end))).all()
        const macs = tx.select({ mac: apRooms.apMac }).from(apRooms).where(eq(apRooms.roomId, id)).all().map(row => row.mac)
        for (const row of affected) {
          tx.update(roomSegments).set({ end: Math.max(at, row.start) }).where(eq(roomSegments.id, row.id)).run()
        }
        tx.update(infraDevices).set({ roomId: null }).where(eq(infraDevices.roomId, id)).run()
        tx.delete(rooms).where(eq(rooms.id, id)).run()
        return { affected, macs }
      })
      for (const [personId, candidate] of pending) if (candidate.roomId === id) pending.delete(personId)
      for (const row of affected) if (row.scope === scope()) publish(row.personId, id, null, room.name)
      if (macs.length) bus.emit({ type: 'device', data: { macs } })
      return { ok: true as const }
    },
    timeline(from: number, to: number) {
      const rows = db.select().from(roomSegments).where(and(eq(roomSegments.scope, scope()),
        or(isNull(roomSegments.end), and(lte(roomSegments.start, to), gte(roomSegments.end, from)))))
        .orderBy(roomSegments.start, roomSegments.id).all()
      const byPerson = new Map<string, Segment[]>()
      for (const row of rows) {
        const segments = byPerson.get(row.personId) ?? []
        segments.push(row)
        byPerson.set(row.personId, segments)
      }
      return RoomTimeline.parse({ from, to, rooms: list(), people: db.select({ personId: people.id }).from(people)
        .orderBy(people.name, people.id).all().map(({ personId }) => {
          const segments = byPerson.get(personId) ?? []
          const open = segments.find(row => row.end === null)
          return { personId, current: open ? { roomId: open.roomId, apMac: open.apMac, since: open.start } : null,
            segments: segments.filter(row => row.start <= to) }
        }) })
    },
  }
}
