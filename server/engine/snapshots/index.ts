import { Cron } from 'croner'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import { SnapshotDiff, SnapshotItem, SnapshotResource, type DiffChangeT, type RestoreInput, type SnapshotResourceT, type SnapshotT } from '#shared/schemas/insight'
import type { Db } from '../../db'
import { clients, egresses, settings as settingsTable } from '../../db/schema'
import { createAuditService } from '../../services/audit'
import { systemContext, type ControllerService } from '../../services/controller'
import { createSettingsService } from '../../services/settings'
import type { WireDoc } from '../../unifi/endpoints/schemas'
import { UnifiError } from '../../unifi/errors'
import { serializeSite, type BeforeWrite, type WriteContext } from '../../unifi/writes'
import { apiError } from '../../utils/api-error'
import { captureCollections, indexCollection } from './capture'
import { compareMaps, fieldDiff, labelResolver, redactDocument, summary } from './diff'
import { createRestore, requireRuntime, restoreReason } from './restore'
import { createSnapshotStore, DAY, type Capture } from './store'

type Runtime = ReturnType<typeof requireRuntime>

export function createSnapshots(db: Db, service: ControllerService, now = Date.now) {
  const store = createSnapshotStore(db)
  const restore = createRestore(db, service, store)
  const settings = createSettingsService(db)
  const audit = createAuditService(db)
  let cron: Cron | undefined
  let scheduled: Promise<unknown> | undefined
  let stopped = false

  async function capture(runtime: Runtime): Promise<Capture> {
    if (!runtime.active()) throw new UnifiError('UNIFI_INACTIVE')
    const captured = await captureCollections(runtime.api)
    if (!runtime.active()) throw new UnifiError('UNIFI_INACTIVE')
    return { ...captured, networkVersion: runtime.status.networkVersion }
  }

  function persist(runtime: Runtime, data: Capture, trigger: SnapshotT['trigger'], note: string | null, ctx: WriteContext) {
    const row = store.persist(runtime.scope, data, trigger, now(), note, settings.get().snapshots.retainDays)
    audit.record({ actor: ctx.actor, category: 'snapshot', action: 'snapshot.created',
      severity: row.complete ? 'success' : 'warning', target: { type: 'snapshot', id: row.id, label: row.note ?? row.id },
      messageKey: row.complete ? 'audit.snapshot.created' : 'audit.snapshot.incomplete',
      messageParams: { trigger, failed: row.failed.join(', ') } })
    return row
  }

  function create(note: string | undefined, ctx: WriteContext, trigger: 'manual' | 'scheduled' = 'manual') {
    const runtime = requireRuntime(service)
    return serializeSite(runtime.key, async () => persist(runtime, await capture(runtime), trigger, note ?? null, ctx))
  }

  const resourceForTarget: Record<string, SnapshotResourceT> = { route: 'trafficroutes', wlanconf: 'wlanconf', user: 'users', client: 'users' }

  const preWrite: BeforeWrite = async ({ target, action }) => {
    const runtime = requireRuntime(service)
    const resource = action.startsWith('poe.') ? 'devices' : resourceForTarget[target.type]
    const prior = store.recent(runtime.scope, now() - 120_000)
    if (action !== 'poe.qualify' && prior && (!resource || !prior.failed.includes(resource))) return
    const snapshot = persist(runtime, await capture(runtime), 'pre-write', null, systemContext)
    if (resource && snapshot.failed.includes(resource)) throw new UnifiError('UNIFI_SNAPSHOT_INCOMPLETE')
  }

  function item(id: string, resource: SnapshotResourceT, itemId: string) {
    store.get(id)
    const entry = store.item(id, resource, itemId)
    return SnapshotItem.parse({ resource, itemId, label: entry.label, doc: redactDocument(entry.doc) })
  }

  function remove(id: string, ctx: WriteContext) {
    const row = store.get(id)
    const result = store.remove(id)
    audit.record({ actor: ctx.actor, category: 'snapshot', action: 'snapshot.deleted', severity: 'success',
      target: { type: 'snapshot', id, label: row.note ?? id }, messageKey: 'audit.snapshot.deleted' })
    return result
  }

  function assertScope(saved: string | null, scope: string) {
    if (saved !== scope) throw apiError(409, 'SNAPSHOT_SCOPE_MISMATCH', 'errors.snapshotScopeMismatch')
  }

  async function diff(fromId: string, toId?: string) {
    const from = store.get(fromId)
    const runtime = toId === undefined ? requireRuntime(service) : service.runtime
    const unavailable = new Set(from.failed)
    function stored(row: typeof from) {
      for (const resource of row.failed) unavailable.add(resource)
      const collections = store.documents(row.id, unavailable)
      for (const resource of SnapshotResource.options) {
        if (!Object.hasOwn(row.counts, resource) || (collections.get(resource)?.size ?? 0) !== row.counts[resource]) unavailable.add(resource)
      }
      return collections
    }
    const source = stored(from)
    let target: Capture
    if (toId !== undefined) {
      const to = store.get(toId)
      if (from.controllerScope !== to.controllerScope) throw apiError(409, 'SNAPSHOT_SCOPE_MISMATCH', 'errors.snapshotScopeMismatch')
      target = { collections: stored(to), failed: to.failed, networkVersion: to.networkVersion }
    } else {
      assertScope(from.controllerScope, runtime!.scope)
      target = await serializeSite(runtime!.key, () => capture(runtime!))
    }
    for (const resource of target.failed) unavailable.add(resource)
    const sameRuntime = runtime?.scope === from.controllerScope ? runtime : undefined
    const owner = sameRuntime && service.ownership(sameRuntime.config.site)
    const names = sameRuntime ? new Map(db.select({ mac: clients.mac, name: clients.alias }).from(clients).all()
      .flatMap(row => row.name ? [[row.mac, row.name]] : [])) : new Map<string, string>()
    const exits = sameRuntime ? new Map(db.select({ id: egresses.id, name: egresses.name }).from(egresses)
      .where(eq(egresses.site, sameRuntime.config.site)).all().map(row => [row.id, row.name])) : new Map<string, string>()
    const labels = (collections: Capture['collections']) => {
      const resolve = labelResolver(collections, names)
      return (key: string, value: unknown) => resolve(key, value)
        ?? (typeof value === 'string' && /^network_id$|^egress_id$/i.test(key) ? exits.get(value) ?? null : null)
    }
    const replacements = toId === undefined && sameRuntime ? new Set(store.mappedIds(sameRuntime.scope)
      .filter(mapping => source.get(mapping.resource)?.has(mapping.originalId))
      .map(mapping => JSON.stringify([mapping.resource, mapping.currentId]))) : new Set<string>()
    const oldLabel = labels(source)
    const newLabel = labels(target.collections)
    const changes: DiffChangeT[] = []
    for (const resource of SnapshotResource.options) {
      if (unavailable.has(resource)) continue
      for (const { id, left, right, kind } of compareMaps(source.get(resource) ?? new Map(), target.collections.get(resource) ?? new Map())) {
        const itemLabel = right?.label ?? left!.label
        const fields = fieldDiff(left?.doc ?? {}, right?.doc ?? {}, oldLabel, newLabel)
        const targetId = sameRuntime && toId === undefined && left && !right
          ? store.resolveId(sameRuntime.scope, resource, id) : id
        const liveReplacement = targetId !== id ? target.collections.get(resource)?.get(targetId) : undefined
        changes.push({ resource, itemId: id, itemLabel, kind, fields, ...summary(resource, itemLabel, kind, fields, left?.doc, right?.doc),
          restorable: !(kind === 'added' && replacements.has(JSON.stringify([resource, id])))
            && !(resource === 'trafficroutes' && owner?.excluded.has(id))
            && !restoreReason(resource, targetId, left?.doc, right?.doc ?? liveReplacement?.doc, owner) })
      }
    }
    return SnapshotDiff.parse({ fromId, toId: toId ?? null, changes, unavailableResources: SnapshotResource.options.filter(resource => unavailable.has(resource)) })
  }

  function apply(id: string, input: z.output<typeof RestoreInput>, ctx: WriteContext) {
    if (input.items.some(({ itemId }) => !itemId || itemId === '.' || itemId === '..')) {
      throw apiError(400, 'INVALID_INPUT', 'errors.invalidInput')
    }
    const runtime = requireRuntime(service)
    const row = store.get(id)
    assertScope(row.controllerScope, runtime.scope)
    const saved = { collections: store.documents(id), failed: row.failed, networkVersion: row.networkVersion }
    return restore.run(runtime, input, ctx, saved, () => capture(runtime), data => {
      persist(runtime, data, 'pre-restore', null, ctx)
    })
  }

  function schedule() {
    cron?.stop()
    const config = settings.get()
    store.prune(now() - config.snapshots.retainDays * DAY)
    if (!config.snapshots.cron) return
    try {
      cron = new Cron(config.snapshots.cron, { timezone: config.timezone, unref: true }, () => {
        if (stopped || scheduled || !service.runtime?.active()) return
        scheduled = create(undefined, systemContext, 'scheduled').catch(() => {}).finally(() => { scheduled = undefined })
      })
    } catch {
      // Settings written before cron validation can be corrected through the settings API.
      audit.record({ actor: systemContext.actor, category: 'snapshot', action: 'snapshot.scheduleInvalid',
        severity: 'error', messageKey: 'errors.invalidSnapshotCron' })
    }
  }

  async function seed(runtime: Runtime) {
    const marker = 'mock.snapshots.seeded'
    await serializeSite(runtime.key, async () => {
      if (db.select().from(settingsTable).where(eq(settingsTable.key, marker)).get()) return
      const data = await capture(runtime)
      db.transaction(tx => {
        for (let day = 3; day >= 1; day--) {
          const entries = new Map(data.collections)
          const edit = (resource: SnapshotResourceT, id: string, patch: WireDoc) => {
            const docs = entries.get(resource)
            if (docs?.has(id)) entries.set(resource, indexCollection(resource,
              [...docs.values()].map(item => item.id === id ? { ...item.doc, ...patch } : item.doc)))
          }
          edit('portforward', 'demo-forward', { enabled: day === 1 })
          edit('wlanconf', 'demo-wlan-0', { enabled: day !== 2 })
          store.persist(runtime.scope, { ...data, collections: entries }, 'scheduled', now() - day * DAY, null, settings.get().snapshots.retainDays)
        }
        tx.insert(settingsTable).values({ key: marker, value: true }).run()
      })
    })
  }

  function onSettings(event: { type: string }) {
    if (event.type === 'routing.settings') schedule()
  }

  function start() {
    service.beforeWrite.add(preWrite)
    service.engine.on('event', onSettings)
    schedule()
    const runtime = service.runtime
    const ready = service.ready().then(async () => {
      if (!stopped && runtime?.active() && service.status().mock) await seed(runtime)
    })
    return { ready, async stop() {
      stopped = true
      cron?.stop()
      service.engine.off('event', onSettings)
      service.beforeWrite.delete(preWrite)
      await Promise.allSettled([scheduled, ready])
    } }
  }

  return { list: store.list, create, remove, item, diff, apply, start }
}
