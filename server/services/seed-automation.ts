import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { NotificationEvent } from '#shared/schemas/system'
import type { Db } from '../db'
import { guestWifi, notificationChannels, poeWatchdogs, rules, settings, wolTargets, personGroups } from '../db/schema'
import { nextCron } from '../engine/automation-cron'
import { initialWatchdogState } from '../engine/watchdogs'
import { buildFixtures, SWITCH_MAC } from '../unifi/mock/fixtures'
import { encrypt } from '../utils/crypto'
import { createSettingsService } from './settings'

const seeded = 'automation.demoSeeded'
export function seedMockAutomation(db: Db, at = Date.now()) {
  if (db.select().from(settings).where(eq(settings.key, seeded)).get()) return
  const { timezone } = createSettingsService(db).get()
  const fixtures = buildFixtures(at, '127.0.0.1')
  db.transaction(tx => {
    if (!tx.select().from(notificationChannels).limit(1).get()) tx.insert(notificationChannels).values({
      id: 'demo-webpush', name: 'Web Push', type: 'webpush', enabled: true, events: [...NotificationEvent.options],
      encryptedConfig: encrypt({ type: 'webpush' }),
    }).run()
    if (!tx.select().from(rules).limit(1).get()) {
      const kids = tx.select().from(personGroups).where(eq(personGroups.groupId, 'demo-kids')).all()
      const baseline = { createdAt: at, description: null, conditions: [], cooldownSeconds: 300, actions: [] }
      tx.insert(rules).values([
        { ...baseline, id: 'demo-rule-vpn', name: 'VPN down', enabled: true, trigger: { type: 'egress.down', egressId: 'demo-vpn-4' },
          encryptedActions: encrypt([{ type: 'notify', channelIds: [], title: '{{egress}}', body: '{{name}}' }]) },
        { ...baseline, id: 'demo-rule-home', name: 'Kid arrives home', enabled: true, trigger: { type: 'person.arrived', personId: 'demo-person-3' },
          encryptedActions: encrypt([{ type: 'webhook', url: 'http://127.0.0.1/unifire-demo-echo', method: 'POST',
            headers: {}, body: '{"person":"{{person}}"}' }]) },
        { ...baseline, id: 'demo-rule-curfew', name: 'Pause Kids at 22:00', enabled: false,
          trigger: { type: 'schedule', cron: '0 22 * * *', timezone }, encryptedActions: encrypt(kids.length
            ? kids.map(kid => ({ type: 'pause', personId: kid.personId, minutes: 60 }))
            : [{ type: 'block', target: { type: 'group', id: 'demo-kids' }, minutes: 60 }]) },
      ]).run()
    }
    if (!tx.select().from(poeWatchdogs).limit(1).get()) {
      for (const [index, hostname] of ['porch-camera', 'workbench-camera'].entries()) {
        const target = fixtures.clients.find(client => client.hostname === hostname)!
        if (!('sw_port' in target)) throw new Error('Mock camera is missing its switch port')
        tx.insert(poeWatchdogs).values({ id: `demo-watchdog-${index + 1}`, name: index ? 'Workbench camera' : 'Porch camera',
          targetMac: target.mac, targetIp: target.ip, intervalSec: 10, failThreshold: 2, cooldownMin: 2,
          method: index ? 'tcp' : 'icmp', tcpPort: index ? 554 : null, maxCyclesPerDay: 6, enabled: true,
          switchMac: SWITCH_MAC, switchName: 'Studio Switch', portIdx: target.sw_port!, state: initialWatchdogState(true) }).run()
      }
    }
    if (!tx.select().from(guestWifi).limit(1).get()) {
      const wlan = fixtures.wlans.find(wlan => wlan.is_guest)!
      const token = randomBytes(32).toString('base64url')
      const rotation = { cron: '0 4 * * 1', timezone, style: 'words' as const, length: 12 }
      tx.insert(guestWifi).values({ id: 1, enabled: true, wlanId: wlan._id, ssid: wlan.name, rotation,
        encryptedPassphrase: encrypt(wlan.x_passphrase), encryptedKioskToken: encrypt(token),
        kioskTokenHash: createHash('sha256').update(token).digest('hex'), nextRotationAt: nextCron(rotation, at) }).run()
    }
    if (!tx.select().from(wolTargets).limit(1).get()) {
      for (const [index, hostname] of ['maple-desktop', 'atlas-nas'].entries()) {
        const target = fixtures.clients.find(client => client.hostname === hostname)!
        tx.insert(wolTargets).values({ id: `demo-wol-${index + 1}`, name: index ? 'Atlas NAS' : 'Maple desktop',
          mac: target.mac, port: 9, schedule: index ? null : { cron: '0 8 * * 1-5', timezone } }).run()
      }
    }
    tx.insert(settings).values({ key: seeded, value: true }).run()
  })
}
