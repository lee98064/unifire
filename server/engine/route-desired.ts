import type { RouteOverrideT, RouteScheduleT, FailoverPolicyT, ManagedRouteT, RoutePreviewT } from '#shared/schemas/routes'
import type { EgressHealthT } from '#shared/schemas/egress'
import { cellAt, nextChange, segments } from '#shared/utils/schedule'

type Timing = {
  defaultEgressId: string
  schedule: RouteScheduleT | null
  override: RouteOverrideT | null
}

type Latch = { failoverPrimary: string | null, failoverEgress: string | null, failoverRecoverSince: number | null }
export type HealthReading = { value: EgressHealthT, failedRounds: number }
export const clearFailover: Latch = { failoverPrimary: null, failoverEgress: null, failoverRecoverSince: null }

export function plannedEgress(timing: Timing, at: number): ManagedRouteT['desired'] {
  const { schedule, override, defaultEgressId } = timing
  if (override && override.startsAt <= at && at < override.endsAt) {
    return { egressId: override.egressId, reason: override.createdBy.startsWith('rule:') ? 'rule' : 'override', until: override.endsAt }
  }
  const cell = schedule ? cellAt(schedule.grid, at, schedule.timezone) : null
  const next = schedule && nextChange(schedule.grid, defaultEgressId, at, schedule.timezone)
  return { egressId: cell ?? defaultEgressId, reason: cell === null ? 'default' : 'schedule', until: next?.at ?? null }
}

export function previewSegments(timing: Timing, from: number, to: number): RoutePreviewT['segments'] {
  const { schedule, defaultEgressId, override } = timing
  const planned = (start: number) => segments(schedule?.grid ?? null, defaultEgressId, start, to, schedule?.timezone ?? 'UTC')
    .map(({ fromSchedule, ...segment }) => ({ ...segment, reason: fromSchedule ? 'schedule' as const : 'default' as const }))
  if (!override || override.endsAt <= from) return planned(from)
  const end = Math.min(to, override.endsAt)
  const current = plannedEgress(timing, from)
  return [{ start: from, end, egressId: current.egressId, reason: current.reason }, ...planned(end)]
}

export function resolveEgress(timing: Timing, policy: FailoverPolicyT, previous: Latch, health: ReadonlyMap<string, HealthReading>,
  at: number, enabled: ReadonlySet<string>, actual?: string | null) {
  const planned = plannedEgress(timing, at)
  const primary = planned.egressId
  if (!policy.enabled) return { desired: planned, latch: clearFailover }
  if (planned.reason === 'override' || planned.reason === 'rule') {
    // An override interrupts the observed recovery interval.
    return { desired: planned, latch: { ...previous, failoverRecoverSince: null } }
  }
  const current = health.get(primary)
  const failed = !enabled.has(primary) || (current !== undefined && (
    (current.value.status === 'down' && current.failedRounds === 0) ||
    current.failedRounds >= policy.failThreshold ||
    (current.value.lossPct !== null && current.value.lossPct >= policy.lossPct)
  ))
  const onFallback = previous.failoverPrimary === primary && previous.failoverEgress !== null
  const healthySince = current?.value.status === 'healthy' && enabled.has(primary)
    ? Math.max(current.value.since ?? at, previous.failoverRecoverSince ?? at) : null
  const recoverAt = healthySince === null ? null : healthySince + policy.recoverMinutes * 60_000
  if (onFallback && recoverAt !== null && at >= recoverAt) {
    return { desired: { ...planned, reason: 'recover' as const }, latch: clearFailover }
  }
  if (failed || onFallback) {
    const fallback = policy.chain.find(id => id !== primary && enabled.has(id) && health.get(id)?.value.status === 'healthy')
    // During an active incident, hold the current fallback when there is no healthier choice.
    const held = onFallback && actual && enabled.has(actual) ? actual : null
    const egressId = fallback ?? held
    if (egressId) {
      const until = planned.until === null ? recoverAt : recoverAt === null ? planned.until : Math.min(planned.until, recoverAt)
      return {
        desired: { egressId, reason: 'failover' as const, until },
        latch: { failoverPrimary: primary, failoverEgress: fallback ?? previous.failoverEgress, failoverRecoverSince: healthySince },
      }
    }
  }
  return { desired: planned, latch: clearFailover }
}
