import { portKey } from '../engine/infra/port-history'
import { heldPort, invalidatePoeQualification, readPoeQualification, releasePoe } from '../engine/infra/poe-state'
import { digest } from '../engine/snapshots/diff'
import { createWriteLedger } from '../unifi/write-ledger'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { and, eq } from 'drizzle-orm'
import {
  CapabilityKey, ControllerMode, ControllerStatus, type ControllerInputT,
  type ControllerModeT, type ControllerStatusT,
} from '#shared/schemas/controller'
import type { Db } from '../db'
import { controller, egresses, guestWifi, managedRoutes, poeApplied, quotaRoutes, settings } from '../db/schema'
import { probeCapabilities } from '../unifi/capabilities'
import { createUnifiTransport, type UnifiConfig } from '../unifi/client'
import { createUnifiEndpoints } from '../unifi/endpoints'
import { UnifiError, unifiErrorCode, unifiStatusKey } from '../unifi/errors'
import { startMockController, type MockController } from '../unifi/mock'
import { controllerUrl, normalizeFingerprint } from '../unifi/tls'
import { serializeSite, siteKey, createWriteGate, type BeforeWrite, type WriteContext } from '../unifi/writes'
import { checkWebSocket, startEvents, type ControllerEvent } from '../unifi/ws'
import { liveBus } from '../utils/bus'
import { decrypt, encrypt } from '../utils/crypto'
import { createAuditService } from './audit'
import { createSyncCache } from './cache'
import { createSettingsService } from './settings'
import { createRouteObservations } from './route-observations'
import { seedMockDemo } from './seed'
import { seedMockAccess } from './seed-access'

const MOCK_ROW = 'mock://unifire'
const MOCK_MODE = 'wp2.mockMode'
const QUALIFIED_CONTROLLER = 'wp2.qualifiedController'
const AUTH_LOCK = 'wp2.controllerAuthLock'
export const systemContext: WriteContext = { actor: { type: 'system', id: null, name: null } }
type Row = typeof controller.$inferSelect
type Endpoints = ReturnType<typeof createUnifiEndpoints>

export function savedController(db: Db) {
  const row = db.select().from(controller).where(eq(controller.id, 1)).get()
  return row?.url !== MOCK_ROW ? row : undefined
}

function initialStatus(mock: boolean, config?: UnifiConfig, row?: Row): ControllerStatusT {
  return {
    configured: !!config || !!row, mock, connected: false, wsConnected: false,
    url: config?.url ?? row?.url ?? null, username: config?.username ?? row?.username ?? null,
    site: config?.site ?? row?.site ?? null, verifyMode: config?.verifyMode ?? row?.verifyMode ?? null,
    fingerprint: config?.fingerprint ?? row?.fingerprint ?? null,
    mode: mock ? 'live' : row?.mode ?? 'dry-run', networkVersion: row?.networkVersion ?? null,
    consoleVersion: row?.consoleVersion ?? null, model: row?.model ?? null, timezone: row?.timezone ?? null,
    selfMac: row?.selfMac ?? null, selfIp: row?.selfIp ?? null, lastError: null, lastSyncAt: row?.lastSyncAt ?? null,
    capabilities: row?.capabilities.length ? row.capabilities : CapabilityKey.options.map(key => ({
      key, status: 'unknown', detail: null, checkedAt: null,
    })),
  }
}

function normalizeConfig(input: ControllerInputT, password: string): UnifiConfig {
  if (input.site === '.' || input.site === '..') throw new UnifiError('UNIFI_INVALID_SITE')
  const url = controllerUrl(input.url).origin
  const fingerprint = normalizeFingerprint(input.fingerprint)
  if (input.verifyMode === 'fingerprint' && !/^[\dA-F]{64}$/.test(fingerprint)) throw new UnifiError('UNIFI_INVALID_FINGERPRINT')
  if (input.verifyMode === 'ca' && !input.caPem?.trim()) throw new UnifiError('UNIFI_CA_REQUIRED')
  return {
    url, site: input.site, username: input.username, password, verifyMode: input.verifyMode,
    ...(input.verifyMode === 'fingerprint' && { fingerprint: fingerprint.match(/../g)?.join(':') }),
    ...(input.verifyMode === 'ca' && { caPem: input.caPem }),
  }
}

function configKey(config: UnifiConfig) {
  return createHash('sha256').update(JSON.stringify(normalizeConfig(config, config.password))).digest('base64url')
}

function fromRow(row: Row) {
  const password = decrypt(row.encryptedPassword)
  if (typeof password !== 'string' || !password) throw new UnifiError('UNIFI_INVALID_CREDENTIALS')
  return normalizeConfig({ ...row, fingerprint: row.fingerprint ?? undefined, caPem: row.caPem ?? undefined }, password)
}

function applySysinfo(status: ControllerStatusT, info: Awaited<ReturnType<Endpoints['sysinfo']>>[number]) {
  status.networkVersion = info.version
  status.consoleVersion = info.console_display_version ?? info.udm_version ?? null
  status.model = info.name ?? null
  status.timezone = info.timezone ?? null
}

export async function createControllerService(db: Db, options: {
  mock: boolean
  lively?: boolean
  active?: () => boolean
}): Promise<ControllerService> {
  const audit = createAuditService(db)
  const settingsService = createSettingsService(db)
  const engine = new EventEmitter<{ event: [ControllerEvent] }>()
  const beforeWrite = new Set<BeforeWrite>()
  const beforeRoutingChange = new Set<() => Promise<void>>()
  let stopped = false
  let routingChange = false
  let mock: MockController | undefined
  let background: Promise<unknown> | undefined
  let activeRuntime: ReturnType<typeof createRuntime> | undefined
  let testRuntime: { key: string, transport: ReturnType<typeof createUnifiTransport> } | undefined
  let fallback = initialStatus(options.mock)
  let lastPublished = ''
  const canRun = () => !stopped && options.active?.() !== false

  if (options.mock) {
    const guest = db.select().from(guestWifi).get()
    const passphrase = guest?.encryptedPassphrase ? decrypt(guest.encryptedPassphrase) : null
    mock = await startMockController({ lively: options.lively, guestWlan: guest?.wlanId && typeof passphrase === 'string'
      ? { id: guest.wlanId, passphrase } : undefined })
    if (!savedController(db)) db.insert(controller).values({
      id: 1, url: MOCK_ROW, username: mock.config.username, encryptedPassword: encrypt(mock.config.password),
      verifyMode: 'insecure', mode: 'dry-run', site: mock.config.site,
    }).onConflictDoNothing().run()
  }

  function ownership(site: string, scope = activeRuntime?.scope) {
    const managed = db.select().from(managedRoutes).where(and(eq(managedRoutes.controllerId, 1), eq(managedRoutes.site, site))).all()
      .filter(row => row.controllerScope === null || row.controllerScope === scope)
    const probeRows = db.select({ id: egresses.probeRouteId }).from(egresses)
      .where(and(eq(egresses.site, site), scope ? eq(egresses.probeRouteScope, scope) : undefined)).all()
    const sweepId = scope && db.select().from(settings).where(eq(settings.key, `routing.sweepRoute:${scope}`)).get()?.value
    return {
      managed: new Map(managed.map(row => [row.unifiRouteId, row])),
      quotaRoutes: new Set(scope ? db.select({ id: quotaRoutes.routeId }).from(quotaRoutes)
        .where(eq(quotaRoutes.controllerScope, scope)).all().map(row => row.id) : []),
      excluded: new Set(settingsService.get().excludedRouteIds),
      probes: new Set([...probeRows.flatMap(row => row.id ? [row.id] : []), ...(typeof sweepId === 'string' ? [sweepId] : [])]),
    }
  }

  function assertActive() {
    if (!canRun()) throw new UnifiError('UNIFI_INACTIVE')
  }

  function mode() {
    if (!options.mock) return savedController(db)?.mode ?? 'dry-run'
    return ControllerMode.safeParse(db.select().from(settings).where(eq(settings.key, MOCK_MODE)).get()?.value).data ?? 'live'
  }

  function status(): ControllerStatusT {
    const current = activeRuntime?.status ?? fallback
    return ControllerStatus.parse({ ...current, mode: mode(), selfMac: settingsService.get().selfMacOverride ?? current.selfMac })
  }

  function publish() {
    if (!canRun()) return
    const current = activeRuntime?.status ?? fallback
    const data = { connected: current.connected, wsConnected: current.wsConnected, lastError: current.lastError }
    const key = JSON.stringify(data)
    if (key !== lastPublished) {
      lastPublished = key
      liveBus.emit({ type: 'controller', data })
    }
  }

  function createRuntime(config: UnifiConfig, row?: Row, existing?: ReturnType<typeof createUnifiTransport>) {
    const state = initialStatus(options.mock, config, row)
    const live = () => canRun() && activeRuntime?.status === state
    const key = siteKey(new URL(config.url).origin, config.site)
    const scope = options.mock ? 'mock:default' : key
    const observations = createRouteObservations(db, scope)
    const ledger = createWriteLedger()
    const authLocked = !options.mock && db.select().from(settings).where(eq(settings.key, AUTH_LOCK)).get()?.value === key

    function persistAuthLock() {
      if (!options.mock && live()) db.insert(settings).values({ key: AUTH_LOCK, value: key })
        .onConflictDoUpdate({ target: settings.key, set: { value: key } }).run()
    }

    const transport = existing ?? createUnifiTransport(config, {
      mock: options.mock, authLocked, canLogin: live,
      onAuthError(code) {
        if (!live()) return
        if (code === 'UNIFI_AUTH_LOCKED') persistAuthLock()
        state.lastError = unifiStatusKey(code)
        if (code) state.connected = false
        publish()
      },
    })
    const api = createUnifiEndpoints(transport)
    let disconnect: (() => void) | undefined
    let inspection: Promise<void> | undefined
    let probing: Promise<void> | undefined

    function persist() {
      if (options.mock || !live()) return
      const { capabilities, networkVersion, consoleVersion, model, timezone, selfMac, selfIp, lastSyncAt } = state
      db.update(controller).set({ capabilities, networkVersion, consoleVersion, model, timezone, selfMac, selfIp, lastSyncAt })
        .where(eq(controller.id, 1)).run()
    }

    function detectSelf(active: Awaited<ReturnType<Endpoints['activeClients']>>) {
      state.selfIp = row?.selfIpOverride ?? transport.localIp()
      const override = settingsService.get().selfMacOverride ?? row?.selfMacOverride
      const previousMac = state.selfMac
      state.selfMac = override ?? active.find(client => client.ip && client.ip === state.selfIp)?.mac ?? null
      if (live() && !previousMac && state.selfMac && state.capabilities.some(capability =>
        capability.key === 'routes.create' && capability.detail === 'capability.selfMacRequired')) {
        void qualify(systemContext).catch(() => {})
      }
    }

    const cache = createSyncCache(api, {
      db, site: config.site, scope, engine, active: live, observeRoutes: observations.observe,
      onPoll(result) {
        const wasConnected = state.connected
        const previousError = state.lastError
        if (result.error === null) {
          state.lastSyncAt = result.at
          if (result.resource === 'activeClients') {
            detectSelf(cache.snapshot().activeClients)
            void inspectVersion(false).catch(() => {})
          }
          if (state.networkVersion) {
            state.connected = true
            state.lastError = unifiStatusKey(transport.lastError())
          }
          persist()
        } else {
          const code = unifiErrorCode(result.error)
          if (transport.lastError() === 'UNIFI_AUTH_LOCKED') persistAuthLock()
          if (['UNIFI_UNREACHABLE', 'UNIFI_AUTH_REQUIRED', 'UNIFI_AUTH_LOCKED', 'UNIFI_TIMEOUT', 'UNIFI_HTML',
            'UNIFI_FINGERPRINT_MISMATCH', 'UNIFI_TLS', 'UNIFI_LOGIN_RESPONSE'].includes(code)) {
            state.connected = false
            state.lastError = unifiStatusKey(transport.lastError() ?? code)
          }
        }
        publish()
        if (!state.connected && state.lastError && state.lastError !== previousError) {
          engine.emit('event', { type: 'notification', event: 'controller_error', error: state.lastError })
        }
        if (!wasConnected && state.connected) engine.emit('event', { type: 'controller.reconnected' })
      },
    })

    const writes = createWriteGate(transport, api, {
      site: config.site, mode, ownership: () => ownership(config.site, scope),
      baseline: id => {
        const row = ownership(config.site, scope).managed.get(id)
        return row?.baselineFingerprint ?? db.select({ fingerprint: quotaRoutes.fingerprint }).from(quotaRoutes)
          .where(and(eq(quotaRoutes.controllerScope, scope), eq(quotaRoutes.routeId, id))).get()?.fingerprint
      },
      active: live,
      qualified: () => options.mock || db.select().from(settings)
        .where(eq(settings.key, QUALIFIED_CONTROLLER)).get()?.value === key,
      preWrite: () => settingsService.get().snapshots.preWrite, audit, hooks: beforeWrite,
      onRouteWrite: observations.recordWrite,
      onConfigWrite(resource, id, before, after) {
        ledger.record(resource, id, before ? digest(before) : undefined, after ? digest(after) : undefined)
        engine.emit('event', { type: 'config.unifire_write' })
      },
      onDevicePower: ledger.recordDevicePower,
      poeSelf: () => ({ mac: settingsService.get().selfMacOverride ?? state.selfMac, ip: state.selfIp }),
      poeOwned: (switchMac, portIdx) => !!heldPort(db, { scope, switchMac, portIdx }),
      poeQualified: () => readPoeQualification(db, scope, state.networkVersion).qualified,
      onSnapshotPower(switchMac, changes, verified) {
        const at = Date.now()
        db.transaction(tx => {
          for (const { idx: portIdx, mode, previous } of changes) {
            const key = { scope, switchMac, portIdx }
            if (mode === 'off' && !verified) {
              tx.insert(poeApplied).values({ ...key, ...previous, at, scheduleId: null,
                source: 'snapshot', phase: 'applying' }).onConflictDoNothing().run()
            } else if (mode === 'off' || !verified) {
              tx.update(poeApplied).set({ phase: verified ? 'held' : 'restoring' }).where(portKey(poeApplied, key)).run()
            } else {
              releasePoe(tx, key, at, true)
            }
          }
        })
      },
      onRoutesChanged() {
        // A poll started before the mutation may still be in flight.
        void cache.refresh('routes').catch(() => {}).then(() => cache.refresh('routes')).catch(() => {})
      },
    })

    async function qualify(context: WriteContext) {
      if (probing) return probing
      probing = (async () => {
        const capabilities = await probeCapabilities({
          api, authenticate: transport.wsSession, websocket: () => checkWebSocket(transport), writes,
          mode: mode(), selfMac: state.selfMac, context,
        })
        if (!live()) return
        // The boot check runs in dry-run and cannot exercise writes. While the stored live qualification for this
        // controller is still valid, keep reporting those write checks as passed instead of resetting them to "skipped".
        const previous = new Map(state.capabilities.map(item => [item.key, item]))
        state.capabilities = writes.qualified() && !options.mock ? capabilities.map(item => item.status === 'skipped' && item.detail === 'capability.dryRun'
          ? previous.get(item.key)?.status === 'ok' ? previous.get(item.key)! : { ...item, status: 'ok' as const, detail: 'capability.qualifiedEarlier' }
          : item) : capabilities
        if (!options.mock && capabilities.some(item => item.key === 'routes.create' && item.status === 'ok')) {
          db.insert(settings).values({ key: QUALIFIED_CONTROLLER, value: key })
            .onConflictDoUpdate({ target: settings.key, set: { value: key } }).run()
        }
        const sysinfo = capabilities.find(item => item.key === 'sysinfo')
        const auth = capabilities.find(item => item.key === 'auth')
        state.connected = sysinfo?.status === 'ok'
        state.lastError = state.connected ? null
          : unifiStatusKey(transport.lastError()) ?? (auth?.status === 'fail' ? auth.detail : sysinfo?.detail) ?? null
        persist()
        publish()
      })().finally(() => { probing = undefined })
      return probing
    }

    let versionCheckedAt = 0
    async function inspectVersion(force: boolean) {
      if (inspection) return inspection
      if (!force && Date.now() - versionCheckedAt < 60_000) return
      versionCheckedAt = Date.now()
      const previous = `${state.networkVersion}/${state.consoleVersion}`
      let changed = false
      inspection = (async () => {
        const info = (await api.sysinfo())[0]
        if (!info) throw new UnifiError('UNIFI_EMPTY')
        if (!live()) return
        applySysinfo(state, info)
        invalidatePoeQualification(db, scope, state.networkVersion)
        changed = previous !== `${state.networkVersion}/${state.consoleVersion}`
        state.connected = true
        state.lastError = null
        persist()
        publish()
      })().catch((error: unknown) => {
        if (live()) {
          state.connected = false
          state.lastError = unifiStatusKey(transport.lastError() ?? unifiErrorCode(error))
          publish()
        }
      }).finally(() => { inspection = undefined })
      await inspection
      if (!force && changed && live()) {
        engine.emit('event', { type: 'controller.reconnected' })
        await qualify(systemContext)
      }
    }

    function connectEvents() {
      disconnect?.()
      disconnect = startEvents(transport, engine, value => {
        if (!live()) return
        state.wsConnected = value
        publish()
      })
    }

    async function start() {
      cache.start()
      await Promise.allSettled([cache.sync(), inspectVersion(true)])
      if (!live()) return
      if (options.mock) {
        seedMockDemo(db, cache.snapshot().routes)
        seedMockAccess(db, new Set(cache.snapshot().activeClients.map(row => row.mac)))
      }
      connectEvents()
      // Boot only qualifies read endpoints. An explicit admin probe authorizes the live scratch route.
      await qualify({ ...systemContext, dryRun: true })
    }

    return {
      config, transport, status: state, api, cache, writes, key, scope, observations, ledger, active: live, qualify, inspectVersion, connectEvents, start,
      resetEvents() { disconnect?.(); disconnect = undefined; state.wsConnected = false },
      async close() { disconnect?.(); cache.stop(); await transport.close() },
    }
  }

  function launch(config: UnifiConfig, row?: Row, transport?: ReturnType<typeof createUnifiTransport>) {
    const runtime = createRuntime(config, row, transport)
    activeRuntime = runtime
    background = runtime.start().catch(error => {
      if (canRun() && activeRuntime === runtime) {
        runtime.status.lastError = unifiStatusKey(unifiErrorCode(error))
        publish()
      }
    })
    publish()
  }

  const row = savedController(db)
  if (mock) launch(mock.config)
  else if (row) {
    try { launch(fromRow(row), row) } catch (error) {
      fallback = { ...initialStatus(false, undefined, row), lastError: unifiStatusKey(unifiErrorCode(error)) }
      publish()
    }
  }

  function requireRuntime() {
    assertActive()
    if (!activeRuntime) throw new UnifiError('UNIFI_NOT_CONFIGURED')
    return activeRuntime
  }

  let setupTest: Promise<ControllerStatusT> | undefined
  const configQueue = 'unifire-controller-config'

  function configFromInput(input: ControllerInputT) {
    const stored = savedController(db)
    const origin = controllerUrl(input.url).origin
    const matching = stored && stored.url === origin && stored.username === input.username
    const password = input.password ?? (matching ? decrypt(stored.encryptedPassword) : undefined)
    if (typeof password !== 'string' || !password) throw new UnifiError('UNIFI_PASSWORD_REQUIRED')
    return normalizeConfig(input, password)
  }

  async function test(input: ControllerInputT, context: WriteContext) {
    assertActive()
    const config = configFromInput(input)
    const key = configKey(config)
    if (setupTest && (testRuntime?.key === key || activeRuntime && !options.mock && configKey(activeRuntime.config) === key)) return setupTest
    return serializeSite(configQueue, async () => {
      assertActive()
      const sameLive = activeRuntime && !options.mock && configKey(activeRuntime.config) === key
      if (!sameLive && testRuntime?.key !== key) {
        await testRuntime?.transport.close()
        testRuntime = { key, transport: createUnifiTransport(config, { canLogin: canRun }) }
      }
      const transport = sameLive ? activeRuntime!.transport : testRuntime!.transport
      const api = createUnifiEndpoints(transport)
      const result = initialStatus(false, config)
      result.selfMac = settingsService.get().selfMacOverride
      const task = (async () => {
        result.capabilities = await probeCapabilities({
          api, authenticate: transport.wsSession, websocket: () => checkWebSocket(transport),
          writes: { qualifyRoutes: async () => new Map() }, mode: 'dry-run', selfMac: result.selfMac, context,
        })
        result.lastError = unifiStatusKey(transport.lastError()) ?? result.capabilities.find(item => item.status === 'fail')?.detail ?? null
        const info = await api.sysinfo().then(values => values[0]).catch(() => undefined)
        result.connected = !!info
        if (info) {
          applySysinfo(result, info)
          result.lastError = null
          result.selfIp = transport.localIp()
          result.selfMac ??= (await api.activeClients().catch(() => [])).find(client => client.ip === result.selfIp)?.mac ?? null
        }
        return ControllerStatus.parse(result)
      })()
      setupTest = task
      try { return await task } finally { setupTest = undefined }
    })
  }

  async function save(input: ControllerInputT, context: WriteContext) {
    await serializeSite(configQueue, async () => {
      assertActive()
      const config = configFromInput(input)
      const previous = savedController(db)
      const key = configKey(config)
      if (previous) {
        try { if (configKey(fromRow(previous)) === key && (options.mock || activeRuntime)) return } catch { /* Replace unreadable config. */ }
      }

      const fields = {
        url: config.url, username: config.username, site: config.site, verifyMode: config.verifyMode,
        fingerprint: config.fingerprint ?? null, caPem: config.caPem ?? null, encryptedPassword: encrypt(config.password),
        mode: 'dry-run' as const, selfMac: null, selfIp: null, selfMacOverride: null, selfIpOverride: null,
        model: null, networkVersion: null, consoleVersion: null, timezone: null, capabilities: [], lastSyncAt: null,
      }
      const change = async () => {
        assertActive()
        db.transaction(tx => {
          tx.insert(controller).values({ id: 1, ...fields })
            .onConflictDoUpdate({ target: controller.id, set: fields }).run()
          tx.delete(settings).where(eq(settings.key, QUALIFIED_CONTROLLER)).run()
          tx.delete(settings).where(eq(settings.key, AUTH_LOCK)).run()
        })
        audit.record({
          actor: context.actor, action: 'config.controllerSaved', category: 'config', severity: 'success',
          target: { type: 'controller', id: '1', label: config.url },
          messageKey: 'audit.config.controllerSaved', messageParams: { site: config.site },
        })
        if (options.mock) return
        const old = activeRuntime
        activeRuntime = undefined
        await old?.close()
        const test = testRuntime?.key === key ? testRuntime : undefined
        if (test) testRuntime = undefined
        launch(config, savedController(db), test?.transport)
      }
      routingChange = true
      try {
        if (activeRuntime && !options.mock) for (const hook of beforeRoutingChange) await hook()
        if (activeRuntime) await serializeSite(activeRuntime.key, change)
        else await change()
      } finally { routingChange = false }
    })
    await background
    return status()
  }

  async function setMode(value: ControllerModeT, context: WriteContext) {
    return serializeSite(configQueue, async () => {
      const runtime = requireRuntime()
      routingChange = true
      try {
        if (mode() !== value) for (const hook of beforeRoutingChange) await hook()
        const result = await serializeSite(runtime.key, () => {
          assertActive()
          if (mode() === value) return status()
          if (options.mock) db.insert(settings).values({ key: MOCK_MODE, value })
            .onConflictDoUpdate({ target: settings.key, set: { value } }).run()
          else db.update(controller).set({ mode: value }).where(eq(controller.id, 1)).run()
          audit.record({
            actor: context.actor, action: 'config.controllerModeChanged', category: 'config', severity: 'success',
            target: { type: 'controller', id: '1', label: runtime.config.url },
            messageKey: 'audit.config.controllerModeChanged', messageParams: { mode: value }, dryRun: value === 'dry-run',
          })
          for (const capability of runtime.status.capabilities) {
            if (capability.key === 'routes.create' || capability.key === 'routes.update' || capability.key === 'routes.delete') {
              capability.status = 'skipped'
              capability.detail = value === 'dry-run' ? 'capability.dryRun' : 'capability.reprobeRequired'
              capability.checkedAt = null
            }
          }
          return status()
        })
        routingChange = false
        engine.emit('event', { type: 'controller.mode' })
        return result
      } finally { routingChange = false }
    })
  }

  let reconnecting: Promise<ControllerStatusT> | undefined

  function probe(context: WriteContext) {
    if (reconnecting) return reconnecting
    reconnecting = serializeSite(configQueue, async () => {
      const runtime = requireRuntime()
      await background
      assertActive()
      await serializeSite(runtime.key, async () => {
        runtime.resetEvents()
        await runtime.transport.reconnect()
        if (!options.mock) db.delete(settings).where(eq(settings.key, AUTH_LOCK)).run()
      })
      await Promise.allSettled([runtime.cache.sync(), runtime.inspectVersion(true)])
      assertActive()
      await runtime.qualify(context)
      runtime.connectEvents()
      return status()
    }).finally(() => { reconnecting = undefined })
    return reconnecting
  }

  return {
    connectivity() {
      const { configured, connected } = activeRuntime?.status ?? fallback
      return { configured, connected }
    },
    engine, beforeWrite, beforeRoutingChange, routingLocked: () => routingChange, status, ownership, test, save, setMode, probe,
    get mockProbe() { return mock?.probe },
    get mockWatchdogProbe() { return mock?.watchdogProbe },
    get mockScenario() { return mock?.scenario },
    get mockTrace() { return mock?.trace },
    get runtime() { return activeRuntime },
    async ready() { await background },
    async sync() {
      const runtime = requireRuntime()
      const results = await runtime.cache.sync()
      const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined
      if (failure) throw failure.reason
    },
    async stop() {
      stopped = true
      await serializeSite(configQueue, async () => {
        const runtime = activeRuntime
        if (runtime) await serializeSite(runtime.key, runtime.close)
        await testRuntime?.transport.close()
        await mock?.close()
      })
      await background
    },
  }
}

export type ControllerService = {
  engine: EventEmitter<{ event: [ControllerEvent] }>
  beforeWrite: Set<BeforeWrite>
  beforeRoutingChange: Set<() => Promise<void>>
  routingLocked: () => boolean
  connectivity: () => { configured: boolean, connected: boolean }
  status: () => ControllerStatusT
  ownership: (site: string) => {
    managed: Map<string, typeof managedRoutes.$inferSelect>, excluded: Set<string>, probes: Set<string>, quotaRoutes: Set<string>
  }
  test: (input: ControllerInputT, context: WriteContext) => Promise<ControllerStatusT>
  save: (input: ControllerInputT, context: WriteContext) => Promise<ControllerStatusT>
  setMode: (value: ControllerModeT, context: WriteContext) => Promise<ControllerStatusT>
  probe: (context: WriteContext) => Promise<ControllerStatusT>
  mockProbe: MockController['probe'] | undefined
  mockScenario?: MockController['scenario']
  mockTrace: MockController['trace'] | undefined
  mockWatchdogProbe?: MockController['watchdogProbe']
  runtime: { config: UnifiConfig, api: Endpoints, cache: ReturnType<typeof createSyncCache>, writes: ReturnType<typeof createWriteGate>,
    scope: string, key: string, status: ControllerStatusT, ledger: ReturnType<typeof createWriteLedger>, active: () => boolean, observations: ReturnType<typeof createRouteObservations> } | undefined
  ready: () => Promise<void>
  sync: () => Promise<void>
  stop: () => Promise<void>
}
