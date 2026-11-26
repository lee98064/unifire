import { setTimeout as sleep } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import { Mac } from '#shared/schemas/common'
import type { RuleActionT, RuleT } from '#shared/schemas/automation'
import type { Db } from '../../db'
import { clients } from '../../db/schema'
import type { createAccess } from '../../services/access'
import type { ControllerService } from '../../services/controller'
import { UnifiError } from '../../unifi/errors'
import type { WriteContext } from '../../unifi/writes'
import { apiError } from '../../utils/api-error'
import { MINUTE } from '../access-time'
import type { createInfra } from '../infra'
import type { createManagedRoutes } from '../managed-routes'
import type { createNotifier } from '../notifiers'
import { httpUrl } from '../notifiers/channels'
import type { HttpTransport } from '../notifiers/telegram'
import type { createWatchdogs } from '../watchdogs'
import type { createWol } from '../wol'

export type RuleEvent = { type: string } & Record<string, unknown>
type Scope = Extract<RuleActionT, { type: 'block' }>['target']
type Effects = {
  access: ReturnType<typeof createAccess>
  managed: ReturnType<typeof createManagedRoutes>
  notifications: ReturnType<typeof createNotifier>
  watchdogs: ReturnType<typeof createWatchdogs>
  wol: ReturnType<typeof createWol>
  infra?: ReturnType<typeof createInfra>
}

function placeholder(event: RuleEvent, path: string) {
  if (path === 'event') return event
  let value: unknown = event
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

const display = (value: unknown) => typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
export function renderRuleText(template: string, event: RuleEvent) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (original, path: string) => {
    const found = placeholder(event, path)
    return found === undefined ? original : display(found)
  })
}

export function renderWebhookBody(template: string, event: RuleEvent) {
  // Escape text placeholders inside JSON strings and preserve types outside them.
  return template.replace(/"(?:\\[\s\S]|[^"\\])*"|\{\{\s*([\w.]+)\s*\}\}/g, (match, path?: string) => {
    if (path) return JSON.stringify(placeholder(event, path) ?? null)
    return match.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (original, key: string) => {
      const found = placeholder(event, key)
      return found === undefined ? original : JSON.stringify(display(found)).slice(1, -1)
    })
  })
}

export function createRuleActions(db: Db, service: ControllerService, effects: Effects, http: HttpTransport, now: () => number) {
  const { access, managed, notifications, watchdogs, wol } = effects

  function targets({ type, id }: Scope) {
    if (type === 'person') return access.people.get(id).deviceMacs
    if (type === 'group') {
      const group = access.people.groups().find(row => row.id === id)
      if (!group) throw apiError(404, 'GROUP_NOT_FOUND', 'errors.groupNotFound')
      return access.people.rows().filter(row => group.personIds.includes(row.id)).flatMap(row => row.deviceMacs)
    }
    const mac = Mac.safeParse(id).data
    if (!mac || !db.select().from(clients).where(eq(clients.mac, mac)).get()) {
      throw apiError(404, 'CLIENT_NOT_FOUND', 'errors.clientNotFound')
    }
    return [mac]
  }

  return async (action: RuleActionT, rule: RuleT, event: RuleEvent, dryRun: boolean, explicitDryRun: boolean, signal: AbortSignal) => {
    const ctx: WriteContext = { actor: { type: 'rule', id: rule.id, name: rule.name }, dryRun }
    if (action.type === 'client.kick') {
      return { changed: false, ok: false, message: 'rule.result.not_implemented' }
    }
    const preview = explicitDryRun || dryRun && action.type !== 'notify' && action.type !== 'webhook' && action.type !== 'delay'
    if (preview) return { changed: false, ok: true, message: 'rule.result.would' }
    if (signal.aborted) throw signal.reason
    let changed = true
    switch (action.type) {
      case 'route.override':
        await managed.override(action.managedRouteId, { egressId: action.egressId, minutes: action.minutes, reason: 'rule' }, ctx)
        break
      case 'route.clear_override':
        await managed.override(action.managedRouteId, null, ctx)
        break
      case 'block':
      case 'unblock': {
        const result = await access.blocks.ruleAction(targets(action.target), action.type === 'block', rule.id,
          action.type === 'block' && action.minutes !== null ? now() + action.minutes * MINUTE : null, ctx, access.desired)
        return { changed: result.changed, ok: !result.failed, message: result.failed ? 'rule.result.failed' : null }
      }
      case 'pause':
        access.people.pause(action.personId, { minutes: action.minutes, reason: rule.name.slice(0, 120) })
        await access.blocks.reconcile(access.desired)
        break
      case 'resume':
        access.people.pause(action.personId, null)
        await access.blocks.reconcile(access.desired)
        break
      // Group pauses follow membership at evaluation time, so members added later are covered too.
      case 'group.pause':
        access.people.groupPause(action.groupId, { minutes: action.minutes, reason: rule.name.slice(0, 120) })
        await access.blocks.reconcile(access.desired)
        break
      case 'group.resume':
        access.people.groupPause(action.groupId, null)
        await access.blocks.reconcile(access.desired)
        break
      case 'notify':
        await notifications.notify({ event: 'rule', data: event,
          message: { title: renderRuleText(action.title, event), body: renderRuleText(action.body, event) } }, action.channelIds, true)
        changed = false
        break
      case 'webhook': {
        const url = httpUrl(action.url)
        const headers = new Headers(action.headers)
        const body = action.method !== 'GET' && action.body !== null ? renderWebhookBody(action.body, event) : undefined
        if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
        const response = await http(url.href, { method: action.method, headers, body, redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
        await response.body?.cancel()
        if (!response.ok) throw apiError(502, 'RULE_WEBHOOK_FAILED', 'rule.result.webhookFailed')
        changed = false
        break
      }
      case 'poe.set':
        if (!effects.infra) throw new UnifiError('UNIFI_INACTIVE')
        await effects.infra.poe.override({ ...action, action: 'set' }, ctx, 'rule')
        break
      case 'poe.cycle':
        changed = (await watchdogs.cyclePort(action.switchMac, action.portIdx, ctx)).changed
        break
      case 'wlan.toggle':
      case 'device.restart': {
        const run = service.runtime
        if (!run?.active()) throw new UnifiError('UNIFI_NOT_CONFIGURED')
        const result = action.type === 'wlan.toggle'
          ? await run.writes.updateWlan(action.wlanId, { enabled: action.enabled }, ctx)
          : await run.writes.deviceAction({ cmd: 'restart', macs: [action.mac] }, ctx)
        if (action.type === 'wlan.toggle' && result.changed && !result.dryRun) await run.cache.refresh('wlans').catch(() => {})
        changed = result.changed && !result.dryRun
        break
      }
      case 'device.locate': {
        if (!effects.infra) throw new UnifiError('UNIFI_INACTIVE')
        const result = await effects.infra.locate(action.mac, { on: true, minutes: action.minutes }, ctx)
        changed = result?.changed === true && !result.dryRun
        break
      }
      case 'wol':
        await wol.wake(action.targetId, ctx)
        break
      case 'delay':
        await sleep(action.seconds * 1000, undefined, { signal, ref: false })
        changed = false
        break
    }
    return { changed, ok: true, message: null }
  }
}
