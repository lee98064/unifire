import type { IncidentSignalT, IncidentT } from '#shared/schemas/infra'
import { MINUTE } from '../../access-time'

type AffectedDevice = { mac: string, clients: number, people: string[], groups: string[] }

export type SignalFacts = {
  failure?: string
  recovers?: string[]
  mac?: string
  ancestors?: string[]
  global?: boolean
  devices?: AffectedDevice[]
  egressId?: string
  critical?: boolean
  lostClients?: string[]
}

export type Signal = IncidentSignalT & { facts: SignalFacts }
type OpenIncident = { latestAt: number, signals: readonly Signal[] }

function related(left: SignalFacts, right: SignalFacts) {
  return left.global && right.global || left.mac && right.mac
    && (left.mac === right.mac || left.ancestors?.includes(right.mac) || right.ancestors?.includes(left.mac))
}

export function incidentToJoin<T extends OpenIncident>(signal: Signal, open: readonly T[], windowMinutes: number) {
  return open.filter(incident => Math.abs(signal.ts - incident.latestAt) <= windowMinutes * MINUTE
    && incident.signals.some(prior => prior.facts.failure && (signal.facts.failure ? related(signal.facts, prior.facts)
      : prior.facts.mac && (signal.facts.mac === prior.facts.mac || signal.facts.ancestors?.includes(prior.facts.mac)))))
    .sort((a, b) => b.latestAt - a.latestAt)[0]
}

export const suspectWindow = 15 * MINUTE

export function isSuspect(signal: Signal, openedAt: number) {
  return signal.kind === 'config_change' && signal.ts >= openedAt - suspectWindow && signal.ts <= openedAt
}

export function recoveryState(signals: readonly Signal[]) {
  const pending = new Set<string>()
  let lastRecovery: number | null = null
  let lastFailure = 0
  for (const { ts, facts } of signals) {
    if (facts.failure) {
      lastFailure = Math.max(ts, lastFailure)
      pending.add(facts.failure)
    }
    for (const key of facts.recovers ?? []) {
      if (pending.delete(key)) lastRecovery = Math.max(ts, lastRecovery ?? 0)
    }
  }
  return { pending, lastRecovery, lastFailure }
}

export function resolutionAt(signals: readonly Signal[], quietMinutes: number, at: number) {
  const { pending, lastRecovery, lastFailure } = recoveryState(signals)
  if (!pending.size && lastRecovery !== null && at >= Math.max(lastFailure, lastRecovery) + quietMinutes * MINUTE) return lastRecovery
  return null
}

export function summarize(signals: readonly Signal[], baselineClients: number, severity: IncidentT['severity']) {
  const failures = signals.filter(signal => signal.facts.failure)
  const earliest = failures.reduce((first, signal) => signal.ts < first.ts
    || signal.ts === first.ts && signal.facts.global && !signal.facts.mac && (!first.facts.global || first.facts.mac)
    ? signal : first)
  const root = earliest.facts.global && !earliest.facts.mac ? earliest
    : failures.filter(signal => signal.facts.mac).reduce((first, signal) => {
      const difference = (signal.facts.ancestors?.length ?? 0) - (first.facts.ancestors?.length ?? 0)
      return difference < 0 || difference === 0 && signal.ts < first.ts ? signal : first
    }, earliest)

  const devices = new Map<string, AffectedDevice>()
  const egresses = new Set<string>()
  const people = new Set<string>()
  const groups = new Set<string>()
  for (const { facts } of failures) {
    for (const device of facts.devices ?? []) {
      if (!devices.has(device.mac) || devices.get(device.mac)!.clients < device.clients) devices.set(device.mac, device)
      for (const person of device.people) people.add(person)
      for (const group of device.groups) groups.add(group)
    }
    if (facts.egressId) egresses.add(facts.egressId)
  }
  const clients = [...devices.values()].reduce((sum, device) => sum + device.clients, 0)
  const impact = { devices: [...devices.keys()], clients, people: [...people], egresses: [...egresses] }
  const critical = failures.some(signal => signal.facts.critical) || baselineClients > 0 && clients * 2 >= baselineClients
  return {
    root: { kind: root.kind, ref: root.ref },
    titleKey: `incident.title.${root.kind}`,
    titleParams: { name: root.ref?.label ?? '', devices: String(devices.size), clients: String(clients), people: String(people.size) },
    impact, severity: critical ? 'critical' as const : severity,
    affectedNodes: [...impact.devices.map(mac => 'dev:' + mac), ...groups, ...impact.egresses.map(id => 'egress:' + id)],
    signalCount: signals.length,
    suspectCount: signals.filter(signal => signal.suspect).length,
  }
}
