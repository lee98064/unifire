import { eq } from 'drizzle-orm'
import { infraDevices } from '../db/schema'
import type { createInfra } from './infra'
import type { Db } from '../db'
import type { createAccess } from '../services/access'
import type { ControllerService } from '../services/controller'
import type { ControllerEvent } from '../unifi/ws'
import { createGuestWifi } from './guest-wifi'
import type { createManagedRoutes } from './managed-routes'
import { createNotifier, type Notification } from './notifiers'
import { createRules } from './rules'
import { createWatchdogs } from './watchdogs'
import { createWol } from './wol'

function notification(input: ControllerEvent): Notification | undefined {
  switch (input.type) {
    case 'notification': {
      const { type: _type, event, ...data } = input
      if (event === 'extension_request' && input.variant === 'extension_decided') return {
        event, variant: input.variant, member: { personId: input.personId }, data,
      }
      return { event, data,
        ...(event === 'quota_warning' && input.personId && { member: { personId: input.personId } }) }
    }
    case 'egress.down': return { event: 'egress_down', data: { egressId: input.egressId } }
    case 'egress.up': return { event: 'egress_up', data: { egressId: input.egressId } }
    case 'egress.ip_changed':
      return { event: 'egress_ip_changed', data: { egressId: input.egressId, ip: input.ip, previousIp: input.previousIp } }
    case 'config.external_change':
      return { event: 'external_change', data: { resource: input.resource, itemId: input.itemId, label: input.label } }
  }
}

export function createAutomation(db: Db, service: ControllerService, access: ReturnType<typeof createAccess>,
  managed: ReturnType<typeof createManagedRoutes>, infra?: ReturnType<typeof createInfra>) {
  const notifications = createNotifier(db, access, { mock: service.status().mock })
  const watchdogs = createWatchdogs(db, service, notifications.notify)
  const guestWifi = createGuestWifi(db, service, notifications.notify)
  const wol = createWol(db, service)
  const rules = createRules(db, service, { access, managed, notifications, watchdogs, wol, infra })
  return {
    notifications, watchdogs, guestWifi, rules, wol,
    start(hasLease: () => boolean) {
      const pending = new Set<Promise<void>>()
      const onEvent = (input: ControllerEvent) => {
        if (!hasLease()) return
        const event: Notification | undefined = input.type === 'infra.firmware'
          ? { event: 'device_firmware', data: { mac: input.mac, version: input.version,
              device: db.select({ name: infraDevices.name }).from(infraDevices).where(eq(infraDevices.mac, input.mac)).get()?.name ?? input.mac } }
          : notification(input)
        if (!event) return
        const task = notifications.notify(event).catch(() => {}).finally(() => { pending.delete(task) })
        pending.add(task)
      }
      service.engine.on('event', onEvent)
      const stopNotifier = notifications.start(hasLease)
      const stops = [watchdogs.start(hasLease), guestWifi.start(hasLease), wol.start(hasLease), rules.start(hasLease)]
      return async () => {
        service.engine.off('event', onEvent)
        await Promise.allSettled([stopNotifier(), ...stops.map(stop => stop()), ...pending])
      }
    },
  }
}
