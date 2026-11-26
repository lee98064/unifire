import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import { RestorePlan, type RestoreInput, type RestorePlanT, type SnapshotResourceT } from '#shared/schemas/insight'
import type { Db } from '../../db'
import { managedRoutes } from '../../db/schema'
import { createAuditService } from '../../services/audit'
import type { ControllerService } from '../../services/controller'
import { classifyRoute, PROBE_PREFIX, QUOTA_PREFIX, routeFingerprint } from '../../services/ownership'
import { managedRouteShape } from '../../services/route-shape'
import { Route, type WireDoc } from '../../unifi/endpoints/schemas'
import { UnifiError, unifiErrorCode } from '../../unifi/errors'
import { osPaths } from '../../unifi/paths'
import { itemIdentity, readCollection, resourcePath, snapshotResources } from '../../unifi/snapshot-resources'
import { mergeRestore, type RestoreMutation, type WriteContext } from '../../unifi/writes'
import { digest, redactDocument, type SnapshotEntry } from './diff'
import type { Capture, createSnapshotStore } from './store'

type Runtime = NonNullable<ControllerService['runtime']>
type Selection = z.output<typeof RestoreInput>['items'][number]
type Step = RestorePlanT['steps'][number]
const userFields = ['name', 'fixed_ip', 'use_fixedip', 'network_id']

export function restoreReason(resource: SnapshotResourceT, id: string, before: WireDoc | undefined,
  after: WireDoc | undefined, ownership: ReturnType<ControllerService['ownership']> | undefined) {
  if (resource === 'trafficroutes') {
    if (ownership?.excluded.has(id) || ownership?.probes.has(id) || ownership?.quotaRoutes?.has(id)
      || [before, after].some(doc => typeof doc?.description === 'string'
        && (doc.description.startsWith(PROBE_PREFIX) || doc.description.startsWith(QUOTA_PREFIX)))) return 'excluded'
    for (const doc of [before, after]) {
      if (!doc) continue
      const route = Route.safeParse({ ...doc, _id: id }).data
      if (!ownership || !route || classifyRoute(route, ownership) !== 'managed') return 'notOwned'
    }
  }
  const definition = snapshotResources[resource].write
  if (!definition || !before && !definition.remove) return 'unsupported'
  if (resource === 'users' && !after && typeof before?.mac !== 'string') return 'unsupported'
  return null
}

function restoredBody(resource: SnapshotResourceT, saved: WireDoc, method: 'PUT' | 'POST', current?: WireDoc) {
  if (resource === 'users') {
    return Object.fromEntries([
      ...userFields.filter(key => Object.hasOwn(saved, key) || !!current && Object.hasOwn(current, key))
        .map(key => [key, saved[key] ?? (key === 'use_fixedip' ? false : key === 'fixed_ip' ? '' : null)]),
      ...(method === 'POST' ? [['mac', saved.mac]] : []),
    ])
  }
  const { id: _, _id: __, ...configuration } = saved
  // Update uses the current identity when an earlier POST assigned a new one.
  return method === 'POST' ? configuration : { ...configuration, ...('_id' in current! && { _id: current!._id }),
    ...('id' in current! && { id: current!.id }) }
}

export function createRestore(db: Db, service: ControllerService, store: ReturnType<typeof createSnapshotStore>) {
  const audit = createAuditService(db)

  async function run(runtime: Runtime, input: z.output<typeof RestoreInput>, ctx: WriteContext,
    saved: Capture, captureLive: () => Promise<Capture>, preRestore: (capture: Capture) => void) {
    return runtime.writes.restore(ctx, async mutate => {
      const live = await captureLive()
      const ownership = service.ownership(runtime.config.site)
      const paths = osPaths(runtime.config.site)
      const replacements = new Set(store.mappedIds(runtime.scope)
        .filter(mapping => saved.collections.get(mapping.resource)?.has(mapping.originalId))
        .map(mapping => JSON.stringify([mapping.resource, mapping.currentId])))
      const distinct = new Map(input.items.map(item => [JSON.stringify([item.resource, item.itemId]), item]))
      const operations = [...distinct.values()].map(item => plan(item))
      if (!input.dryRun) preRestore(live)

      function plan({ resource, itemId }: Selection) {
        const prior = saved.collections.get(resource)?.get(itemId)
        const collection = live.collections.get(resource)
        const resolved = prior ? store.resolveId(runtime.scope, resource, itemId) : itemId
        const id = collection?.has(itemId) ? itemId : resolved
        const current = collection?.get(id)
        const label = prior?.label ?? current?.label ?? itemId
        const method = prior ? current ? 'PUT' : 'POST' : 'DELETE'
        const step = (verb: Step['method'], reason: string | null, body?: WireDoc): Step => ({
          resource, itemId, label, method: verb, path: resourcePath(paths, resource, verb !== 'POST' ? id : undefined),
          body: body ? redactDocument(body) : null, supported: reason === null, reason,
          result: reason !== null ? 'skipped' : 'pending', error: null,
        })
        const reason = resource === 'trafficroutes' && ownership.excluded.has(itemId)
          ? 'excluded' : restoreReason(resource, id, prior?.doc, current?.doc, ownership)
        const unavailable = saved.failed.includes(resource) || live.failed.includes(resource)
        const replacement = !prior && replacements.has(JSON.stringify([resource, itemId]))
        const blocked = reason === 'excluded' ? reason : unavailable ? 'incomplete' : replacement ? 'replacement' : reason
        if (blocked) return { id, current, steps: [step(method, blocked)], mutations: [] }
        if (!prior && !current) return { id, current, steps: [step(method, 'missing')], mutations: [] }

        function mutation(verb: Step['method'], before?: SnapshotEntry, body?: WireDoc): RestoreMutation {
          return { resource, id, method: verb, before: before?.doc, body, label,
            onVerified(newId, doc) {
              db.transaction(tx => {
                store.remap(runtime.scope, resource, itemId, id, newId)
                if (resource === 'trafficroutes') {
                  const owned = ownership.managed.get(id)
                  const route = Route.parse(doc)
                  if (owned) tx.update(managedRoutes).set({
                    unifiRouteId: newId, baselineFingerprint: routeFingerprint(route), routeShape: managedRouteShape(route),
                  }).where(and(eq(managedRoutes.id, owned.id), eq(managedRoutes.unifiRouteId, id))).run()
                }
              })
            },
          }
        }

        if (prior && current) {
          const desired = restoredBody(resource, prior.doc, 'PUT', current.doc)
          const payload = mergeRestore(current.doc, desired, resource === 'users')
          if (digest(payload) === current.hash) return { id, current, steps: [step('PUT', 'unchanged')], mutations: [] }
          if (resource === 'static-dns') {
            const create = restoredBody(resource, prior.doc, 'POST')
            return { id, current, steps: [step('DELETE', null), step('POST', null, create)],
              mutations: [mutation('DELETE', current), mutation('POST', undefined, create)] }
          }
          return { id, current, steps: [step('PUT', null, payload)], mutations: [mutation('PUT', current, desired)] }
        }
        if (prior) {
          const create = restoredBody(resource, prior.doc, 'POST')
          return { id, current, steps: [step('POST', null, create)], mutations: [mutation('POST', undefined, create)] }
        }
        return { id, current, steps: [step('DELETE', null)], mutations: [mutation('DELETE', current)] }
      }

      function auditSkipped(step: Step) {
        audit.record({ actor: ctx.actor, category: 'snapshot', action: `restore.${step.method.toLowerCase()}`, severity: 'info',
          target: { type: step.resource, id: step.itemId, label: step.label }, dryRun: service.status().mode === 'dry-run',
          messageKey: 'audit.snapshot.restoreSkipped', messageParams: { action: step.method, target: step.label, reason: step.reason ?? '' } })
      }

      if (!input.dryRun) {
        for (const group of operations) {
          for (const [i, step] of group.steps.entries()) {
            if (!step.supported) { auditSkipped(step); continue }
            const mutation = group.mutations[i]!
            const previous = group.steps[i - 1]
            if (previous && previous.result !== 'applied') {
              step.result = 'skipped'
              step.reason = service.status().mode === 'dry-run' ? 'dryRun' : 'dependencyFailed'
              auditSkipped(step)
              continue
            }
            try {
              const result = await mutate(mutation)
              step.result = result.dryRun ? 'skipped' : 'applied'
              if (result.dryRun) step.reason = 'dryRun'
            } catch (error) {
              step.result = 'failed'
              step.error = unifiErrorCode(error)
              if (previous?.result === 'applied' && group.current) {
                try {
                  const original = group.current.doc
                  const records = await readCollection(runtime.api, 'static-dns')
                  // A timed-out POST can still have committed. Restore the original only if the record is absent.
                  if (!records.some(doc => doc.key === original.key || doc.key === mutation.body?.key
                    || itemIdentity('static-dns', doc) === group.id)) {
                    await mutate({ ...mutation, body: restoredBody('static-dns', original, 'POST') })
                    previous.result = 'skipped'
                    previous.reason = 'compensated'
                    audit.record({ actor: ctx.actor, category: 'snapshot', action: 'restore.compensated', severity: 'warning',
                      target: { type: step.resource, id: step.itemId, label: step.label },
                      messageKey: 'audit.snapshot.restoreCompensated', messageParams: { target: step.label } })
                  }
                } catch {
                  step.error = 'UNIFI_RESTORE_RECOVERY_FAILED'
                }
              }
            }
          }
        }
      }
      return RestorePlan.parse({ dryRun: input.dryRun, steps: operations.flatMap(group => group.steps) })
    })
  }

  return { run }
}

export function requireRuntime(service: ControllerService) {
  const runtime = service.runtime
  if (!runtime?.active()) throw new UnifiError('UNIFI_NOT_CONFIGURED')
  return runtime
}
