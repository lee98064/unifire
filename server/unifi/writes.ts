import { performance } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ControllerModeT } from '#shared/schemas/controller'
import type { AuditEventT } from '#shared/schemas/insight'
import { classifyRoute, PROBE_PREFIX, routeFingerprint } from '../services/ownership'
import type { createAuditService } from '../services/audit'
import { type UnifiTransport } from './client'
import { parseWire, type UnifiEndpoints } from './endpoints'
import { Doc, Route, type WireDoc } from './endpoints/schemas'
import { UnifiError, unifiErrorCode } from './errors'
import { segment } from './paths'

const pending = new Map<string, Promise<void>>()

export function serializeSite<T>(site: string, work: () => Promise<T> | T): Promise<T> {
  const result = (pending.get(site) ?? Promise.resolve()).then(work)
  const tail = result.then(() => {}, () => {})
  pending.set(site, tail)
  void tail.then(() => { if (pending.get(site) === tail) pending.delete(site) })
  return result
}

type Ownership = Parameters<typeof classifyRoute>[1]
export type WriteContext = { actor: AuditEventT['actor'], dryRun?: boolean, probeBaseline?: string }
export type BeforeWrite = (operation: { action: string, target: NonNullable<AuditEventT['target']> }) => Promise<void> | void
export type WriteResult = { dryRun: boolean, changed: boolean, verified: boolean, durationMs: number }
type Plan = {
  before?: WireDoc
  after?: WireDoc
  apply?: () => Promise<unknown>
  verify?: (result: unknown) => Promise<void>
  commit?: () => void
}
type WriteTarget = { type: string, id: string, label?: string }
type Category = AuditEventT['category']

function changes(before: WireDoc = {}, after: WireDoc = {}): AuditEventT['diff'] {
  return Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).flatMap(path =>
    isDeepStrictEqual(before[path], after[path]) ? [] : [{
      path, before: before[path] ?? null, after: after[path] ?? null,
      beforeLabel: null, afterLabel: null, secret: false,
    }])
}

export function createWriteGate(transport: Pick<UnifiTransport, 'write' | 'origin' | 'paths'>, api: UnifiEndpoints, options: {
  site: string
  mode: () => ControllerModeT
  ownership: () => Ownership
  baseline: (id: string) => string | undefined
  active: () => boolean
  qualified?: () => boolean
  preWrite: () => boolean
  audit: Pick<ReturnType<typeof createAuditService>, 'record'>
  hooks: Set<BeforeWrite>
}) {
  const { paths, write } = transport
  const queue = (work: () => Promise<unknown>) => serializeSite(siteKey(transport.origin.origin, options.site), work)
  const scratch = new Set<string>()
  const scratchBaselines = new Map<string, string>()
  const routePath = paths.v2('trafficroutes')
  const duration = (start: number) => Math.round(performance.now() - start)

  async function execute(action: string, category: Category, targetInput: WriteTarget, ctx: WriteContext,
    prepare: () => Promise<Plan>, scratchCheck = false): Promise<WriteResult> {
    const target = { ...targetInput, label: targetInput.label ?? targetInput.id }
    const start = performance.now()
    const dryRun = ctx.dryRun === true || options.mode() === 'dry-run'
    let diff: AuditEventT['diff'] = null
    let changed = false
    let verified = false
    let failure: string | null = null
    try {
      if (!options.active()) throw new UnifiError('UNIFI_INACTIVE')
      let plan = await prepare()
      diff = changes(plan.before, plan.after)
      if (!dryRun && plan.apply && !scratchCheck && options.qualified?.() === false) {
        throw new UnifiError('UNIFI_QUALIFICATION_REQUIRED')
      }
      if (!dryRun && plan.apply && options.preWrite() && options.hooks.size) {
        for (const hook of options.hooks) await hook({ action, target })
        if (!options.active()) throw new UnifiError('UNIFI_INACTIVE')
        // A snapshot may take time. Revalidate and merge against fresh data.
        plan = await prepare()
        diff = changes(plan.before, plan.after)
      }
      changed = plan.apply !== undefined
      if (!dryRun) {
        if (!options.active()) throw new UnifiError('UNIFI_INACTIVE')
        if (options.mode() !== 'live') throw new UnifiError('UNIFI_INACTIVE')
        if (plan.apply) {
          const response = await plan.apply()
          if (plan.verify) {
            await plan.verify(response)
            verified = true
          }
        } else {
          verified = true
        }
        plan.commit?.()
      }
      return { dryRun, changed, verified, durationMs: duration(start) }
    } catch (error) {
      failure = unifiErrorCode(error)
      throw error
    } finally {
      options.audit.record({
        actor: ctx.actor, category, action, target, diff, dryRun,
        severity: failure ? 'error' : dryRun || !changed ? 'info' : 'success',
        messageKey: failure ? 'audit.unifi.writeFailed' : dryRun ? 'audit.unifi.writeDryRun'
          : changed ? 'audit.unifi.writeApplied' : 'audit.unifi.writeUnchanged',
        messageParams: { action, target: target.label, ...(failure && { error: failure }) },
      })
    }
  }

  function run(action: string, category: Category, target: WriteTarget, ctx: WriteContext, prepare: () => Promise<Plan>) {
    return serializeSite(siteKey(transport.origin.origin, options.site), () => execute(action, category, target, ctx, prepare))
  }

  const executeScratch: typeof run = (action, category, target, ctx, prepare) =>
    execute(action, category, target, ctx, prepare, true)

  async function findRoute(id: string) {
    const route = (await api.routes()).find(candidate => candidate._id === id)
    if (!route) throw new UnifiError('UNIFI_ROUTE_NOT_FOUND', 404)
    return route
  }

  function routeOwner(route: z.infer<typeof Route>) {
    const ownership = options.ownership()
    return classifyRoute(route, { ...ownership, probes: new Set([...ownership.probes, ...scratch]) })
  }

  async function ownedRoute(id: string) {
    const route = await findRoute(id)
    const owner = routeOwner(route)
    if (owner !== 'managed' && owner !== 'probe') throw new UnifiError('ROUTE_NOT_OWNED')
    return route
  }

  function updateRoute(id: string, patch: { network_id?: string, description?: string, enabled?: boolean, kill_switch_enabled?: boolean },
    ctx: WriteContext, guardBaseline: boolean, executor = run) {
    return executor('routes.update', 'route', { type: 'route', id }, ctx, async () => {
      const route = await ownedRoute(id)
      const fingerprint = routeFingerprint(route)
      const expected = routeOwner(route) === 'probe'
        ? scratchBaselines.get(id) ?? ctx.probeBaseline
        : options.baseline(id)
      if (guardBaseline && (!expected || expected !== fingerprint)) throw new UnifiError('UNIFI_ROUTE_DRIFT')
      const after = { ...route, ...patch }
      const expectedFingerprint = routeFingerprint(after)
      return {
        before: route, after,
        ...(changes(route, after)?.length && {
          apply: () => write('PUT', `${routePath}/${segment(id)}`, after),
          async verify() {
            const current = await findRoute(id)
            if (!['managed', 'probe'].includes(routeOwner(current)) || routeFingerprint(current) !== expectedFingerprint
              || Object.entries(patch).some(([field, value]) => !isDeepStrictEqual(current[field], value))) {
              throw new UnifiError('UNIFI_VERIFY_FAILED')
            }
          },
        }),
      }
    })
  }

  function deleteRoute(id: string, ctx: WriteContext, executor = run) {
    return executor('routes.delete', 'route', { type: 'route', id }, ctx, async () => {
      const route = await ownedRoute(id)
      // A scratch marker alone is insufficient if UniFi changed the route's forwarding behavior.
      if (scratch.has(id) && routeFingerprint(route) !== scratchBaselines.get(id)) throw new UnifiError('UNIFI_ROUTE_DRIFT')
      return {
        before: route,
        apply: () => write('DELETE', `${routePath}/${segment(id)}`),
        async verify() {
          if ((await api.routes()).some(item => item._id === id)) throw new UnifiError('UNIFI_VERIFY_FAILED')
          scratch.delete(id)
          scratchBaselines.delete(id)
        },
      }
    })
  }

  async function createRoute(document: WireDoc, ctx: WriteContext, executor = run, onCreated?: (id: string) => void) {
    const { _id: _, ...draft } = parseWire(Route, { ...document, _id: 'new' })
    let id: string | null = null
    const result = await executor('routes.create', 'route', { type: 'route', id: 'new', label: draft.description ?? 'new' }, ctx, async () => {
      if (Object.hasOwn(draft, 'origin_type') || draft.predefined === true) throw new UnifiError('ROUTE_NOT_OWNED')
      const existing = new Set((await api.routes()).map(route => route._id))
      return {
        after: draft, apply: () => write('POST', routePath, draft),
        async verify(response) {
          const created = parseWire(z.object({ _id: z.string().min(1) }), Array.isArray(response) ? response[0] : response)
          if (existing.has(created._id)) throw new UnifiError('UNIFI_VERIFY_FAILED')
          id = created._id
          onCreated?.(id)
          const route = await findRoute(id)
          if (routeFingerprint(route) !== routeFingerprint({ ...draft, _id: id })
            || route.network_id !== draft.network_id || route.description !== draft.description) {
            throw new UnifiError('UNIFI_VERIFY_FAILED')
          }
        },
      }
    })
    return { ...result, id }
  }

  async function qualifyRoutes(selfMac: string, egressId: string, ctx: WriteContext) {
    const outcomes = new Map<'routes.create' | 'routes.update' | 'routes.delete', string | null>()
    await queue(async () => {
      if (options.mode() !== 'live' || ctx.dryRun) return
      const document = {
        _id: 'new', description: `${PROBE_PREFIX} capability-check`, enabled: false,
        target_devices: [{ type: 'CLIENT', client_mac: selfMac }],
        matching_target: 'IP', network_id: egressId, next_hop: '', kill_switch_enabled: true,
        domains: [], ip_addresses: [{ ip_or_subnet: '192.0.2.1', ip_version: 'v4', port_ranges: [], ports: [] }],
        ip_ranges: [], regions: [],
      }
      let id: string | undefined
      try {
        await createRoute(document, ctx, executeScratch, created => {
          id = created
          scratch.add(created)
          scratchBaselines.set(created, routeFingerprint(document))
        })
        outcomes.set('routes.create', null)
        if (id) {
          try {
            await updateRoute(id, { description: `${document.description} verified` }, ctx, true, executeScratch)
            outcomes.set('routes.update', null)
          } catch (error) { outcomes.set('routes.update', unifiErrorCode(error)) }
        }
      } catch (error) {
        outcomes.set('routes.create', unifiErrorCode(error))
      } finally {
        if (id) {
          try {
            await deleteRoute(id, ctx, executeScratch)
            outcomes.set('routes.delete', null)
          } catch (error) { outcomes.set('routes.delete', unifiErrorCode(error)) }
        }
      }
    })
    return outcomes
  }

  function updateDocument<T extends WireDoc>(resource: 'user' | 'wlanconf', id: string, patch: WireDoc,
    load: (id: string) => Promise<T[]>, ctx: WriteContext) {
    return run(`${resource}.update`, resource === 'user' ? 'client' : 'wifi', { type: resource, id }, ctx, async () => {
      const before = (await load(id)).find(doc => doc._id === id)
      if (!before) throw new UnifiError('UNIFI_NOT_FOUND', 404)
      const after = { ...before, ...patch }
      return {
        before, after,
        ...(changes(before, after)?.length && {
          apply: () => write('PUT', paths.classic(`rest/${resource}/${segment(id)}`), after),
          async verify() {
            const result = (await load(id)).find(doc => doc._id === id)
            if (!result || Object.entries(patch).some(([key, value]) => !isDeepStrictEqual(result[key], value))) {
              throw new UnifiError('UNIFI_VERIFY_FAILED')
            }
          },
        }),
      }
    })
  }

  return {
    createRoute: (draft: WireDoc, ctx: WriteContext) => createRoute(draft, ctx),
    updateRoute: (id: string, patch: Parameters<typeof updateRoute>[1], ctx: WriteContext) => updateRoute(id, patch, ctx, true),
    deleteRoute: (id: string, ctx: WriteContext) => deleteRoute(id, ctx),
    updateRouteEgress: (routeId: string, egressId: string, ctx: WriteContext) => updateRoute(routeId, { network_id: egressId }, ctx, true),
    qualifyRoutes,
    updateUser: (id: string, patch: { name?: string, use_fixedip?: boolean, fixed_ip?: string, network_id?: string }, ctx: WriteContext) =>
      updateDocument('user', id, patch, api.user, ctx),
    updateWlan: (id: string, patch: { enabled?: boolean, x_passphrase?: string }, ctx: WriteContext) =>
      updateDocument('wlanconf', id, patch, api.wlan, ctx),
    clientAction(mac: string, action: 'block' | 'unblock' | 'kick', ctx: WriteContext, decide: () => Promise<{
      wasBlocked?: boolean, send: boolean, verify?: () => Promise<void>, commit?: () => void
    }>) {
      const command = { cmd: `${action}-sta`, mac }
      return run(`client.${action}`, 'client', { type: 'client', id: mac }, ctx, async () => {
        const decision = await decide()
        return {
          before: decision.wasBlocked === undefined ? {} : { blocked: decision.wasBlocked },
          after: action === 'kick' ? command : { blocked: action === 'block' },
          apply: decision.send ? () => write('POST', paths.classic('cmd/stamgr'), command) : undefined,
          verify: decision.verify,
          commit: decision.commit,
        }
      })
    },
    deviceAction(command: { cmd: 'restart', macs: string[] } | { cmd: 'power-cycle', mac: string, port_idx: number } | { cmd: 'speedtest' },
      ctx: WriteContext) {
      const id = command.cmd === 'restart' ? command.macs.join(',') : command.cmd === 'power-cycle' ? command.mac : 'gateway'
      return run(`device.${command.cmd}`, command.cmd === 'power-cycle' ? 'poe' : 'system', { type: 'device', id }, ctx,
        async () => ({ after: parseWire(Doc, command), apply: () => write('POST', paths.classic('cmd/devmgr'), command) }))
    },
  }
}

export function siteKey(origin: string, site: string) { return JSON.stringify([origin, site]) }
