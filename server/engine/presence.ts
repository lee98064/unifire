import { randomUUID } from 'node:crypto'
import { eq, isNull } from 'drizzle-orm'
import type { PersonT } from '#shared/schemas/access'
import type { Db } from '../db'
import { presenceSessions } from '../db/schema'
import type { EngineEvents } from '../unifi/ws'
import { liveBus } from '../utils/bus'
import { MINUTE } from './access-time'

export function updatePresence(db: Db, engine: EngineEvents, people: PersonT[], online: Set<string>, at: number, grace: number) {
  const open = new Map(db.select().from(presenceSessions).where(isNull(presenceSessions.end)).all().map(row => [row.personId, row]))
  for (const person of people) {
    const mac = person.presenceMacs.find(mac => online.has(mac))
    const session = open.get(person.id)
    if (mac && !session) {
      db.insert(presenceSessions).values({ id: randomUUID(), personId: person.id, mac, start: at }).run()
      engine.emit('event', { type: 'person.arrived', personId: person.id, mac })
      liveBus.emit({ type: 'presence', data: { personId: person.id, home: true } })
    } else if (session) {
      if (mac) {
        if (session.offlineSince !== null) db.update(presenceSessions).set({ offlineSince: null }).where(eq(presenceSessions.id, session.id)).run()
      } else if (session.offlineSince === null) {
        db.update(presenceSessions).set({ offlineSince: at }).where(eq(presenceSessions.id, session.id)).run()
      } else if (at - session.offlineSince >= grace * MINUTE) {
        db.update(presenceSessions).set({ end: at, offlineSince: null }).where(eq(presenceSessions.id, session.id)).run()
        engine.emit('event', { type: 'person.left', personId: person.id, mac: session.mac })
        liveBus.emit({ type: 'presence', data: { personId: person.id, home: false } })
      }
    }
  }
}
