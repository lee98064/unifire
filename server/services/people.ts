import { randomUUID } from 'node:crypto'
import { and, desc, eq, exists, gt, isNull, lt, or } from 'drizzle-orm'
import type { z } from 'zod'
import { type GroupT, type PersonT, type PresenceTimelineT, type GroupInput, type PauseInput, type PersonInput } from '#shared/schemas/access'
import type { Db } from '../db'
import { allowances, clients, groupPauses, groups, pauseSchedules, people, personDevices, personGroups, presenceSessions, users } from '../db/schema'
import { MINUTE } from '../engine/access-time'
import { removeAccessActions } from '../engine/rules/access-references'
import { apiError } from '../utils/api-error'
import { liveBus } from '../utils/bus'
import type { EngineEvents } from '../unifi/ws'

export type PersonFields = Partial<z.output<typeof PersonInput>>
type GroupFields = Partial<z.output<typeof GroupInput>>
type Pause = z.output<typeof PauseInput>
const notFound = (person: boolean) => person
  ? apiError(404, 'PERSON_NOT_FOUND', 'errors.personNotFound')
  : apiError(404, 'GROUP_NOT_FOUND', 'errors.groupNotFound')

export function grantAllowance(db: Pick<Db, 'insert'>, personId: string, amount: number, at: number) {
  const until = at + Math.ceil(amount * MINUTE)
  if (!Number.isSafeInteger(until)) throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
  db.insert(allowances).values({ id: randomUUID(), personId, startsAt: at, until }).run()
}

export function createPeopleService(db: Db, engine: EngineEvents, now = Date.now) {
  function rows(at = now()): PersonT[] {
    const devices = db.select().from(personDevices).all()
    const memberships = db.select().from(personGroups).all()
    const schedules = db.select().from(pauseSchedules).all()
    const accounts = new Map(db.select({ id: users.id, person: users.personId }).from(users).all().map(row => [row.person, row.id]))
    const sessions = new Map<string, typeof presenceSessions.$inferSelect>()
    for (const row of db.select().from(presenceSessions).orderBy(desc(presenceSessions.start)).all()) {
      if (!sessions.has(row.personId)) sessions.set(row.personId, row)
    }
    const available = db.select().from(allowances).where(and(lt(allowances.startsAt, at + 1), gt(allowances.until, at))).all()
    const pauses = new Map(db.select().from(groupPauses).all().map(row => [row.groupId, row]))
    return db.select().from(people).all().map(row => {
      const assigned = devices.filter(device => device.personId === row.id)
      const groupIds = memberships.filter(item => item.personId === row.id).map(item => item.groupId)
      const session = sessions.get(row.id)
      const own = row.paused ? [{ until: row.pausedUntil, reason: row.pauseReason }] : []
      const candidates = [...own, ...groupIds.flatMap(id => pauses.get(id) ?? [])]
        .filter(pause => pause.until === null || pause.until > at)
      const pause = candidates.find(item => item.until === null)
        ?? candidates.sort((a, b) => b.until! - a.until!)[0]
      return {
        id: row.id, name: row.name, avatar: row.avatar, color: row.color, createdAt: row.createdAt,
        deviceMacs: assigned.map(device => device.mac), presenceMacs: assigned.filter(device => device.presence).map(device => device.mac),
        groupIds, userId: accounts.get(row.id) ?? null,
        bedtime: schedules.filter(item => item.personId === row.id).map(({ days, start, end, enabled }) => ({ days, start, end, enabled })),
        presence: { home: !!session && session.end === null, since: session ? session.end ?? session.start : null },
        pause: { active: !!pause, until: pause?.until ?? null, reason: pause?.reason ?? null },
        allowanceUntil: available.filter(item => item.personId === row.id).reduce<number | null>(
          (latest, item) => Math.max(latest ?? 0, item.until), null),
      }
    })
  }

  function get(id: string) {
    const row = rows().find(person => person.id === id)
    if (!row) throw notFound(true)
    return row
  }

  function changed(ids: string[]) {
    const set = new Set(ids)
    const affected = rows().filter(person => set.has(person.id))
    for (const person of affected) liveBus.emit({ type: 'presence', data: { personId: person.id, home: person.presence.home } })
    const macs = affected.flatMap(person => person.deviceMacs)
    if (macs.length) liveBus.emit({ type: 'client.changed', data: { macs } })
    engine.emit('event', { type: 'access.changed' })
  }

  function update(id: string, input: PersonFields, create?: z.output<typeof PersonInput>) {
    const moved = new Set<string>([id])
    db.transaction(tx => {
      if (create) tx.insert(people).values({ id, name: create.name, avatar: create.avatar, color: create.color, createdAt: now() }).run()
      else if (!tx.select({ id: people.id }).from(people).where(eq(people.id, id)).get()) throw notFound(true)

      const { name, color, avatar, groupIds, bedtime } = input
      if (name !== undefined || color !== undefined || avatar !== undefined) {
        tx.update(people).set({ name, color, avatar }).where(eq(people.id, id)).run()
      }
      if (input.deviceMacs !== undefined || input.presenceMacs !== undefined) {
        const previous = tx.select().from(personDevices).where(eq(personDevices.personId, id)).all()
        const devices = [...new Set(input.deviceMacs ?? previous.map(row => row.mac))]
        const presence = new Set(input.presenceMacs ?? previous.filter(row => row.presence && devices.includes(row.mac)).map(row => row.mac))
        if ([...presence].some(mac => !devices.includes(mac))) throw apiError(400, 'INVALID_PRESENCE_DEVICES', 'errors.invalidPresenceDevices')
        tx.delete(personDevices).where(eq(personDevices.personId, id)).run()
        for (const mac of devices) {
          if (!tx.select({ mac: clients.mac }).from(clients).where(eq(clients.mac, mac)).get()) {
            throw apiError(404, 'CLIENT_NOT_FOUND', 'errors.clientNotFound')
          }
          const old = tx.select().from(personDevices).where(eq(personDevices.mac, mac)).get()
          if (old) moved.add(old.personId)
          tx.insert(personDevices).values({ mac, personId: id, presence: presence.has(mac) }).onConflictDoUpdate({
            target: personDevices.mac, set: { personId: id, presence: presence.has(mac) },
          }).run()
        }
      }
      if (groupIds !== undefined) {
        tx.delete(personGroups).where(eq(personGroups.personId, id)).run()
        for (const groupId of new Set(groupIds)) {
          if (!tx.select().from(groups).where(eq(groups.id, groupId)).get()) throw notFound(false)
          tx.insert(personGroups).values({ groupId, personId: id }).run()
        }
      }
      if (bedtime !== undefined) {
        tx.delete(pauseSchedules).where(eq(pauseSchedules.personId, id)).run()
        if (bedtime.length) tx.insert(pauseSchedules).values(bedtime.map(row => ({ ...row, id: randomUUID(), personId: id }))).run()
      }
    })
    changed([...moved])
    return get(id)
  }

  function personPause(id: string, input: Pause | null) {
    const row = db.update(people).set({
      paused: !!input, pausedUntil: input?.minutes == null ? null : now() + input.minutes * MINUTE,
      pauseReason: input?.reason ?? null,
    }).where(eq(people.id, id)).run()
    if (!row.changes) throw notFound(true)
    changed([id])
    return get(id)
  }

  function groupList(): GroupT[] {
    const members = db.select().from(personGroups).all()
    return db.select().from(groups).all().map(row => ({
      ...row, personIds: members.filter(member => member.groupId === row.id).map(member => member.personId),
    }))
  }

  function groupGet(id: string) {
    const row = groupList().find(item => item.id === id)
    if (!row) throw notFound(false)
    return row
  }

  function groupUpdate(id: string, input: GroupFields, create?: z.output<typeof GroupInput>) {
    const previous = create ? [] : groupGet(id).personIds
    db.transaction(tx => {
      const { name, color, personIds } = input
      if (create) tx.insert(groups).values({ id, name: create.name, color: create.color }).run()
      else if (name !== undefined || color !== undefined) tx.update(groups).set({ name, color }).where(eq(groups.id, id)).run()
      if (personIds === undefined) return
      tx.delete(personGroups).where(eq(personGroups.groupId, id)).run()
      for (const personId of new Set(personIds)) {
        if (!tx.select({ id: people.id }).from(people).where(eq(people.id, personId)).get()) throw notFound(true)
        tx.insert(personGroups).values({ personId, groupId: id }).run()
      }
    })
    const group = groupGet(id)
    changed([...previous, ...group.personIds])
    return group
  }

  function groupPause(id: string, input: Pause | null) {
    const { personIds } = groupGet(id)
    if (!input) db.delete(groupPauses).where(eq(groupPauses.groupId, id)).run()
    else {
      const values = { until: input.minutes === null ? null : now() + input.minutes * MINUTE, reason: input.reason ?? null }
      db.insert(groupPauses).values({ groupId: id, ...values }).onConflictDoUpdate({ target: groupPauses.groupId, set: values }).run()
    }
    changed(personIds)
    return rows().filter(person => personIds.includes(person.id))
  }

  return {
    rows, get, changed,
    counts(at: number) {
      const home = exists(db.select({ id: presenceSessions.id }).from(presenceSessions)
        .where(and(eq(presenceSessions.personId, people.id), isNull(presenceSessions.end))))
      const pausedGroup = exists(db.select({ id: personGroups.groupId }).from(personGroups)
        .innerJoin(groupPauses, eq(groupPauses.groupId, personGroups.groupId))
        .where(and(eq(personGroups.personId, people.id), or(isNull(groupPauses.until), gt(groupPauses.until, at)))))
      const rows = db.select({ home, paused: or(pausedGroup, and(eq(people.paused, true),
        or(isNull(people.pausedUntil), gt(people.pausedUntil, at))))! }).from(people).all()
      return { total: rows.length, home: rows.filter(row => row.home).length, paused: rows.filter(row => row.paused).length }
    },
    create: (input: z.output<typeof PersonInput>) => update(randomUUID(), input, input),
    update, pause: personPause,
    remove(id: string) {
      const person = get(id)
      const ruleIds = db.transaction(tx => {
        const affected = removeAccessActions(tx, { type: 'person', id })
        tx.delete(people).where(eq(people.id, id)).run()
        return affected
      })
      if (ruleIds.length) engine.emit('event', { type: 'rules.changed', ruleIds })
      if (person.deviceMacs.length) liveBus.emit({ type: 'client.changed', data: { macs: person.deviceMacs } })
      changed([])
      return { ok: true as const }
    },
    allow(id: string, minutes: number) {
      get(id)
      grantAllowance(db, id, minutes, now())
      changed([id])
      return get(id)
    },
    groups: groupList,
    groupCreate: (input: z.output<typeof GroupInput>) => groupUpdate(randomUUID(), input, input),
    groupUpdate, groupPause,
    groupRemove(id: string) {
      const group = groupGet(id)
      const ruleIds = db.transaction(tx => {
        const affected = removeAccessActions(tx, { type: 'group', id })
        tx.delete(groups).where(eq(groups.id, id)).run()
        return affected
      })
      if (ruleIds.length) engine.emit('event', { type: 'rules.changed', ruleIds })
      changed(group.personIds)
      return { ok: true as const }
    },
    timeline(from: number, to: number): PresenceTimelineT {
      if (to <= from) throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
      const sessions = db.select().from(presenceSessions).where(and(
        lt(presenceSessions.start, to), or(isNull(presenceSessions.end), gt(presenceSessions.end, from)),
      )).orderBy(presenceSessions.start).all()
      return { from, to, people: db.select({ id: people.id }).from(people).all().map(row => ({
        personId: row.id,
        sessions: sessions.filter(item => item.personId === row.id).map(({ start, end, mac }) => ({ start, end, mac })),
      })) }
    },
  }
}
