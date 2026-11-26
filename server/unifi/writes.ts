import { performance } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ControllerModeT } from '#shared/schemas/controller'
import type { AuditEventT, SnapshotResourceT } from '#shared/schemas/insight'
import { digest, fieldDiff, normalize } from '../engine/snapshots/diff'
import { classifyRoute, PROBE_PREFIX, QUOTA_PREFIX, routeFingerprint } from '../services/ownership'
import type { createAuditService } from '../services/audit'
import { type UnifiTransport } from './client'
import { parseWire, type UnifiEndpoints } from './endpoints'
import { Doc, Route, type WireDoc, type WireRoute } from './endpoints/schemas'
import { UnifiError, unifiErrorCode } from './errors'
import { segment } from './paths'
import { assertPoePort } from './poe-ports'
import { itemIdentity, itemLabel, readCollection, resourcePath, snapshotResources } from './snapshot-resources'

type ConfigWrite = (resource: SnapshotResourceT, id: string, before?: WireDoc, after?: WireDoc) => void
export type RestoreMutation = {
  resource: SnapshotResourceT
  id: string
  method: 'PUT' | 'POST' | 'DELETE'
  before?: WireDoc
  body?: WireDoc
  label: string
  onVerified?: (id: string, doc: WireDoc) => void
}

const pending = new Map<string, Promise<void>>()

export function serializeSite<T>(site: string, work: () => Promise<T> | T): Promise<T> {
  const result = (pending.get(site) ?? Promise.resolve()).then(work)
  const tail = result.then(() => {}, () => {})
  pending.set(site, tail)
  void tail.then(() => { if (pending.get(site) === tail) pending.delete(site) })
  return result
}

type Ownership = Parameters<typeof classifyRoute>[1]
export type WriteContext = { actor: AuditEventT['actor'], dryRun?: boolean, probeBaseline?: string, quietProbe?: boolean, quietSuccess?: boolean }
type RoutePatch = Partial<Pick<WireRoute, 'network_id' | 'description' | 'enabled' | 'kill_switch_enabled'
  | 'target_devices' | 'matching_target' | 'domains' | 'ip_addresses' | 'ip_ranges' | 'regions' | 'next_hop'>>
export type BeforeWrite = (operation: { action: string, target: NonNullable<AuditEventT['target']> }) => Promise<void> | void
export type WriteResult = { dryRun: boolean, changed: boolean, verified: boolean, durationMs: number, diff: AuditEventT['diff'] }
type Plan = {
  before?: WireDoc
  after?: WireDoc
  label?: string
  apply?: () => Promise<unknown>
  verify?: (result: unknown) => Promise<void>
  commit?: () => void
}
type Prepare = (setLabel: (label: string) => void) => Promise<Plan>
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
  onRouteWrite?: (route: WireRoute) => void
  onRoutesChanged?: () => void
  onConfigWrite?: ConfigWrite
}) {
  const { paths, write } = transport
  const queue = <T>(work: () => Promise<T>) => serializeSite(siteKey(transport.origin.origin, options.site), work)
  const scratch = new Set<string>()
  const scratchBaselines = new Map<string, string>()
  const routePath = paths.v2('trafficroutes')
  const duration = (start: number) => Math.round(performance.now() - start)

  async function execute(action: string, category: Category, targetInput: WriteTarget, ctx: WriteContext,
    prepare: Prepare, scratchCheck = false, preCaptured = false): Promise<WriteResult> {
    const target = { ...targetInput, label: targetInput.label ?? targetInput.id }
    const start = performance.now()
    const dryRun = ctx.dryRun === true || options.mode() === 'dry-run'
    let diff: AuditEventT['diff'] = null
    let changed = false
    let verified = false
    let failure: string | null = null
    const describe = (plan: Plan) => {
      target.label = plan.label ?? target.label
      diff = fieldDiff(plan.before ?? {}, plan.after ?? {})
    }
    try {
      if (!options.active()) throw new UnifiError('UNIFI_INACTIVE')
      const setLabel = (label: string) => { target.label = label }
      let plan = await prepare(setLabel)
      describe(plan)
      if (!dryRun && plan.apply && !scratchCheck && options.qualified?.() === false) {
        throw new UnifiError('UNIFI_QUALIFICATION_REQUIRED')
      }
      if (!dryRun && plan.apply && !preCaptured && options.preWrite() && options.hooks.size) {
        for (const hook of options.hooks) await hook({ action, target })
        if (!options.active()) throw new UnifiError('UNIFI_INACTIVE')
        // A snapshot may take time. Revalidate and merge against fresh data.
        plan = await prepare(setLabel)
        describe(plan)
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
      return { dryRun, changed, verified, durationMs: duration(start), diff }
    } catch (error) {
      failure = unifiErrorCode(error)
      throw error
    } finally {
      if (failure || (!ctx.quietProbe && !ctx.quietSuccess)) options.audit.record({
        actor: ctx.actor, category, action, target, diff, dryRun,
        severity: failure ? 'error' : dryRun || !changed ? 'info' : 'success',
        messageKey: action.startsWith('restore.') ? failure ? 'audit.snapshot.restoreFailed'
          : dryRun ? 'audit.snapshot.restoreSkipped' : 'audit.snapshot.restoreApplied'
          : failure ? 'audit.unifi.writeFailed' : dryRun ? 'audit.unifi.writeDryRun'
          : changed ? 'audit.unifi.writeApplied' : 'audit.unifi.writeUnchanged',
        messageParams: { action, target: target.label, ...(failure && { error: failure }) },
      })
    }
  }

  function run(action: string, category: Category, target: WriteTarget, ctx: WriteContext, prepare: Prepare) {
    return queue(() => execute(action, category, target, ctx, prepare))
  }

  const executeScratch: typeof run = (action, category, target, ctx, prepare) =>
    execute(action, category, target, ctx, prepare, true)

  async function findRoute(id: string, docs?: WireRoute[]) {
    const route = (docs ?? await api.routes()).find(candidate => candidate._id === id)
    if (!route) throw new UnifiError('UNIFI_ROUTE_NOT_FOUND', 404)
    return route
  }

  function routeOwner(route: z.infer<typeof Route>) {
    const ownership = options.ownership()
    return classifyRoute(route, { ...ownership, probes: new Set([...ownership.probes, ...scratch]) })
  }

  async function ownedRoute(id: string, setLabel: (label: string) => void, docs?: WireRoute[]) {
    const route = await findRoute(id, docs)
    setLabel(route.description || id)
    const owner = routeOwner(route)
    if (owner !== 'managed' && owner !== 'probe') throw new UnifiError('ROUTE_NOT_OWNED')
    return route
  }

  function updateRoute(id: string, patch: RoutePatch, ctx: WriteContext, guardBaseline: boolean, executor = run,
    onVerified?: (before: WireRoute, after: WireRoute) => void, probeRepair = false, checkExisting?: (docs: WireRoute[]) => void) {
    return executor('routes.update', 'route', { type: 'route', id }, ctx, async setLabel => {
      const docs = checkExisting ? await api.routes() : undefined
      const route = await ownedRoute(id, setLabel, docs)
      if (docs) checkExisting?.(docs)
      if (probeRepair && routeOwner(route) !== 'probe') throw new UnifiError('ROUTE_NOT_OWNED')
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
          apply: () => {
            options.onRouteWrite?.(after)
            return write('PUT', `${routePath}/${segment(id)}`, after)
          },
          async verify() {
            const current = await findRoute(id)
            if (!['managed', 'probe'].includes(routeOwner(current)) || routeFingerprint(current) !== expectedFingerprint
              || Object.entries(patch).some(([field, value]) => !isDeepStrictEqual(current[field], value))) {
              throw new UnifiError('UNIFI_VERIFY_FAILED')
            }
            options.onRouteWrite?.(current)
            options.onConfigWrite?.('trafficroutes', id, route, current)
            onVerified?.(route, current)
          },
        }),
        commit: () => {
          if (changes(route, after)?.length) options.onRoutesChanged?.()
          else onVerified?.(route, route)
        },
      }
    })
  }

  function deleteRoute(id: string, ctx: WriteContext, executor = run) {
    return executor('routes.delete', 'route', { type: 'route', id }, ctx, async setLabel => {
      const route = await ownedRoute(id, setLabel)
      // A scratch marker alone is insufficient if UniFi changed the route's forwarding behavior.
      if (scratch.has(id) && routeFingerprint(route) !== scratchBaselines.get(id)) throw new UnifiError('UNIFI_ROUTE_DRIFT')
      return {
        before: route,
        apply: () => write('DELETE', `${routePath}/${segment(id)}`),
        async verify() {
          if ((await api.routes()).some(item => item._id === id)) throw new UnifiError('UNIFI_VERIFY_FAILED')
          options.onConfigWrite?.('trafficroutes', id, route)
          scratch.delete(id)
          scratchBaselines.delete(id)
        },
        commit: options.onRoutesChanged,
      }
    })
  }

  type RouteCreateObserver = {
    created?: (id: string) => void
    verified?: (doc: WireRoute) => void
    checkExisting?: (docs: WireRoute[]) => void
  }

  async function createRoute(document: WireDoc, ctx: WriteContext, executor = run, observer?: RouteCreateObserver) {
    const { _id: _, ...draft } = parseWire(Route, { ...document, _id: 'new' })
    let id: string | null = null
    const result = await executor('routes.create', 'route', { type: 'route', id: 'new', label: draft.description ?? 'new' }, ctx, async () => {
      if (Object.hasOwn(draft, 'origin_type') || draft.predefined === true) throw new UnifiError('ROUTE_NOT_OWNED')
      const docs = await api.routes()
      observer?.checkExisting?.(docs)
      const existing = new Set(docs.map(route => route._id))
      return {
        after: draft, apply: () => write('POST', routePath, draft),
        async verify(response) {
          const created = parseWire(z.object({ _id: z.string().min(1) }), Array.isArray(response) ? response[0] : response)
          if (existing.has(created._id)) throw new UnifiError('UNIFI_VERIFY_FAILED')
          id = created._id
          observer?.created?.(id)
          const route = await findRoute(id)
          if (routeFingerprint(route) !== routeFingerprint({ ...draft, _id: id })
            || route.network_id !== draft.network_id || route.description !== draft.description) {
            throw new UnifiError('UNIFI_VERIFY_FAILED')
          }
          options.onRouteWrite?.(route)
          options.onConfigWrite?.('trafficroutes', id, undefined, route)
          observer?.verified?.(route)
        },
        commit: options.onRoutesChanged,
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
        await createRoute(document, ctx, executeScratch, { created(created) {
          id = created
          scratch.add(created)
          scratchBaselines.set(created, routeFingerprint(document))
        } })
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
      if (resource === 'wlanconf' && typeof patch.x_passphrase === 'string' && before.security !== 'wpapsk') {
        throw new UnifiError('WLAN_PSK_REQUIRED', 409)
      }
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
            if (resource === 'wlanconf') options.onConfigWrite?.('wlanconf', id, before, result)
          },
        }),
      }
    })
  }

  function assertRestoreRoute(id: string, doc: WireDoc) {
    const route = Route.safeParse({ ...doc, _id: id }).data
    const ownership = options.ownership()
    if (!route || route.description?.startsWith(PROBE_PREFIX) || route.description?.startsWith(QUOTA_PREFIX)
      || ownership.probes.has(id) || ownership.quotaRoutes?.has(id)
      || classifyRoute(route, ownership) !== 'managed') throw new UnifiError('ROUTE_NOT_OWNED')
  }

  function restoreMutation(ctx: WriteContext, step: RestoreMutation) {
    const { resource, id, method, before, body, label } = step
    const config = snapshotResources[resource].write
    return execute(`restore.${method.toLowerCase()}`, 'snapshot', { type: resource, id, label }, ctx, async () => {
      if (!config || method === 'DELETE' && !config.remove || method !== 'DELETE' && !body
        || resource === 'static-dns' && method === 'PUT') throw new UnifiError('UNIFI_RESTORE_UNSUPPORTED')
      const load = () => readCollection(api, resource)
      const docs = await load()
      const current = docs.find(doc => itemIdentity(resource, doc) === id)
      if (digest(current ?? null) !== digest(before ?? null)
        || method === 'POST' && resource === 'static-dns' && docs.some(doc => doc.key === body?.key)) {
        throw new UnifiError('UNIFI_RESTORE_STALE')
      }
      if (resource === 'trafficroutes') {
        if (current) assertRestoreRoute(id, current)
        if (body) assertRestoreRoute(id, body)
      }
      const payload = method === 'PUT' && body && current ? mergeRestore(current, body, resource === 'users') : body
      const path = resourcePath(paths, resource, method === 'POST' ? undefined : id)
      const existingIds = new Set(docs.map(doc => itemIdentity(resource, doc)))
      return {
        before: current, after: payload, label: current ? itemLabel(resource, current, id) : label,
        apply: () => write(method, path, payload),
        async verify(response) {
          const latest = await load()
          if (method === 'DELETE') {
            if (latest.some(doc => itemIdentity(resource, doc) === id)) throw new UnifiError('UNIFI_VERIFY_FAILED')
            options.onConfigWrite?.(resource, id, current)
            return
          }
          const returned = Doc.safeParse(Array.isArray(response) ? response[0] : response).data
          const newId = method === 'POST' && returned ? itemIdentity(resource, returned) : undefined
          const matches = latest.filter(doc => {
            const candidate = itemIdentity(resource, doc)
            if (!candidate || (method === 'PUT' ? candidate !== id : existingIds.has(candidate) || newId && candidate !== newId)) return false
            return includesDocument(doc, payload!, method === 'POST')
          })
          const verified = matches.length === 1 ? matches[0] : undefined
          const verifiedId = verified && itemIdentity(resource, verified)
          if (!verified || !verifiedId) throw new UnifiError('UNIFI_VERIFY_FAILED')
          if (resource === 'trafficroutes') {
            assertRestoreRoute(id, verified)
            const ownership = options.ownership()
            if (verifiedId !== id && (ownership.managed.has(verifiedId) || ownership.excluded.has(verifiedId)
              || ownership.probes.has(verifiedId))) throw new UnifiError('UNIFI_VERIFY_FAILED')
          }
          options.onConfigWrite?.(resource, verifiedId, current, verified)
          step.onVerified?.(verifiedId, verified)
          if (resource === 'trafficroutes') options.onRouteWrite?.(parseWire(Route, verified))
        },
        commit: resource === 'trafficroutes' ? options.onRoutesChanged : undefined,
      }
    }, false, true)
  }

  return {
    restore: <T>(ctx: WriteContext, work: (mutate: (step: RestoreMutation) => Promise<WriteResult>) => Promise<T>) =>
      queue(() => {
        if (!options.active()) throw new UnifiError('UNIFI_INACTIVE')
        return work(step => restoreMutation(ctx, step))
      }),
    createRoute: (draft: WireDoc, ctx: WriteContext, observer?: RouteCreateObserver) => createRoute(draft, ctx, run, observer),
    updateRoute: (id: string, patch: RoutePatch, ctx: WriteContext, onVerified?: (before: WireRoute, after: WireRoute) => void,
      checkExisting?: (docs: WireRoute[]) => void) => updateRoute(id, patch, ctx, true, run, onVerified, false, checkExisting),
    repairProbe: (id: string, patch: RoutePatch, ctx: WriteContext) => updateRoute(id, patch, ctx, false, run, undefined, true),
    deleteRoute: (id: string, ctx: WriteContext) => deleteRoute(id, ctx),
    updateRouteEgress: (routeId: string, egressId: string, ctx: WriteContext, onVerified?: (before: WireRoute, after: WireRoute) => void) =>
      updateRoute(routeId, { network_id: egressId }, ctx, true, run, onVerified),
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
        async setLabel => {
          if (command.cmd === 'power-cycle') {
            const device = assertPoePort(await api.devices(), command.mac, command.port_idx)
            setLabel(device.name || device.mac)
          }
          return { after: parseWire(Doc, command), apply: () => write('POST', paths.classic('cmd/devmgr'), command) }
        })
    },
  }
}

export function siteKey(origin: string, site: string) { return JSON.stringify([origin, site]) }

function includesDocument(actual: WireDoc, expected: WireDoc, created: boolean) {
  const left = normalize(actual) as WireDoc
  const right = normalize(expected) as WireDoc
  return Object.entries(right).every(([key, value]) => created && (key === '_id' || key === 'id')
    || includesValue(left[key], value))
}

function includesValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => includesValue(actual[index], value))
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object' && !Array.isArray(actual)) {
    return Object.entries(expected).every(([key, value]) => includesValue((actual as WireDoc)[key], value))
  }
  return isDeepStrictEqual(actual, expected)
}

export function mergeRestore(current: WireDoc, saved: WireDoc, user: boolean): WireDoc {
  if (user) return { ...current, ...saved }
  // A snapshot cannot describe properties introduced later by the controller.
  return Object.fromEntries([...new Set([...Object.keys(current), ...Object.keys(saved)])].map(key => {
    const left = current[key]
    const right = saved[key]
    return [key, !Object.hasOwn(saved, key) ? left
      : left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)
        ? mergeRestore(left as WireDoc, right as WireDoc, false) : right]
  }))
}
