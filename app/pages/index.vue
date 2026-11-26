<script setup lang="ts">
import type { DashboardSummaryT } from '#shared/schemas/system'
import type { ManagedRouteT } from '#shared/schemas/routes'
import type { ClientT } from '#shared/schemas/access'
import { compareDevices } from '~/utils/devices'

const { t, te } = useI18n()
const fmt = useFormat()
const { user } = useUserSession()
const { data: summary, status } = useFetch<DashboardSummaryT>('/api/dashboard', { key: 'dashboard' })
const { data: routes } = useFetch<ManagedRouteT[]>('/api/managed-routes', { key: 'managed-routes', default: () => [] })
const { data: clients } = useFetch<ClientT[]>('/api/clients', { key: 'clients', default: () => [] })
const { egresses } = useEgresses()
const { people } = usePeople()
const { devices } = useDevices()
const incidentTitle = (k: string, p: Record<string, string>) => (te(k) ? t(k, p) : k)
const infra = computed(() => summary.value?.infra)
const infraDots = computed(() => [...devices.value].sort(compareDevices).slice(0, 12))

// keep the "next switch" countdown & dashboard fresh even without events
useIntervalFn(() => refreshNuxtData('dashboard'), 60_000)

const greeting = computed(() => {
  const h = Number(fmt.time(Date.now(), { hour: 'numeric', hour12: false }))
  return h < 5 ? t('dashboard.hiNight') : h < 12 ? t('dashboard.hiMorning') : h < 18 ? t('dashboard.hiAfternoon') : t('dashboard.hiEvening')
})

const wanUp = computed(() => summary.value?.wans.filter(w => w.status === 'healthy').length ?? 0)
const throughputRx = computed(() => summary.value?.throughput.map(p => p.rxBps) ?? [])
const throughputTx = computed(() => summary.value?.throughput.map(p => p.txBps) ?? [])
const lastRx = computed(() => summary.value?.throughput.at(-1)?.rxBps ?? null)
const lastTx = computed(() => summary.value?.throughput.at(-1)?.txBps ?? null)
</script>

<template>
  <div>
    <div class="flex flex-col sm:flex-row sm:items-end gap-2 mb-6">
      <div class="flex-1 min-w-0">
        <p class="text-[13px] text-muted">{{ greeting }}，{{ user?.displayName }}</p>
        <h1 class="text-[22px] sm:text-2xl font-semibold tracking-tight text-highlighted">{{ t('dashboard.title') }}</h1>
      </div>
      <div class="flex items-center gap-2 text-[12px] text-dimmed">
        <UIcon name="i-lucide-refresh-cw" class="size-3.5" :class="status === 'pending' ? 'animate-spin' : ''" />
        {{ t('dashboard.updated') }} <TimeAgo :ts="summary?.generatedAt" />
      </div>
    </div>

    <!-- open incidents -->
    <div v-if="summary?.incidents?.length" class="space-y-2 mb-4">
      <NuxtLink
        v-for="i in summary.incidents"
        :key="i.id"
        :to="`/insight/incidents/${i.id}`"
        class="flex items-center gap-3 rounded-xl px-4 py-3 ring-1 transition hover:-translate-y-px"
        :class="i.severity === 'critical' ? 'bg-error/8 ring-error/30' : 'bg-warning/8 ring-warning/30'"
      >
        <span class="relative flex size-8 items-center justify-center rounded-lg shrink-0" :class="i.severity === 'critical' ? 'bg-error/15 text-error' : 'bg-warning/15 text-warning'">
          <span class="absolute inset-0 rounded-lg animate-ping opacity-30" :class="i.severity === 'critical' ? 'bg-error' : 'bg-warning'" />
          <UIcon name="i-lucide-siren" class="size-4 relative" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-[13.5px] font-semibold text-highlighted truncate">{{ incidentTitle(i.titleKey, i.titleParams) }}</div>
          <div class="text-[12px] text-muted">{{ t('dashboard.incidentSince') }} <TimeAgo :ts="i.openedAt" /> · {{ t('dashboard.incidentImpact', { devices: i.impact.devices.length, clients: i.impact.clients }) }}</div>
        </div>
        <UIcon name="i-lucide-chevron-right" class="size-4 text-dimmed shrink-0" />
      </NuxtLink>
    </div>

    <!-- KPI row -->
    <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
      <KpiTile :label="t('dashboard.kpiWan')" :value="`${wanUp}/${summary?.wans.length ?? 0}`" icon="i-lucide-cable" :tone="wanUp === (summary?.wans.length ?? 0) ? 'success' : 'warning'" to="/egresses">
        <div class="flex gap-1">
          <StatusDot v-for="w in summary?.wans ?? []" :key="w.egressId" :status="w.status" :size="7" />
        </div>
      </KpiTile>
      <KpiTile :label="t('dashboard.kpiEgress')" :value="summary?.egresses.healthy ?? 0" icon="i-lucide-shield" tone="vpn" :hint="t('dashboard.kpiEgressHint', { down: summary?.egresses.down ?? 0, degraded: summary?.egresses.degraded ?? 0 })" to="/egresses" />
      <KpiTile :label="t('dashboard.kpiClients')" :value="summary?.clients.online ?? 0" icon="i-lucide-monitor-smartphone" :hint="t('dashboard.kpiClientsHint', { known: summary?.clients.known ?? 0, blocked: summary?.clients.blocked ?? 0 })" to="/clients">
        <UBadge v-if="summary?.clients.pendingApproval" color="error" variant="solid" size="sm" class="rounded-full">{{ t('dashboard.pendingN', { n: summary.clients.pendingApproval }) }}</UBadge>
      </KpiTile>
      <KpiTile :label="t('dashboard.kpiHome')" :value="`${summary?.people.home ?? 0}/${summary?.people.total ?? 0}`" icon="i-lucide-house" tone="success" :hint="summary?.people.paused ? t('dashboard.pausedN', { n: summary.people.paused }) : t('dashboard.nobodyPaused')" to="/insight/presence">
        <div class="flex -space-x-1.5">
          <PersonAvatar v-for="p in people.filter(p => p.presence.home).slice(0, 4)" :key="p.id" :avatar="p.avatar" :color="p.color" :size="22" class="ring-2 ring-(--uf-surface) rounded-full" />
        </div>
      </KpiTile>
      <KpiTile :label="t('dashboard.kpiRoutes')" :value="summary?.routes.managed ?? 0" icon="i-lucide-waypoints" :tone="summary?.routes.drift ? 'warning' : 'primary'" :hint="t('dashboard.kpiRoutesHint', { total: summary?.routes.unifiTotal ?? 0, overrides: summary?.routes.overrides ?? 0 })" to="/routes" class="col-span-2 lg:col-span-1" />
    </div>

    <!-- infrastructure strip -->
    <NuxtLink v-if="infra && infra.total" to="/devices" class="uf-card uf-card-hover flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 mb-4">
      <div class="flex items-center gap-2.5 min-w-0">
        <span class="size-7 rounded-md flex items-center justify-center shrink-0" :class="infra.offline ? 'bg-error/10 text-error' : 'bg-success/10 text-success'"><UIcon name="i-lucide-server" class="size-4" /></span>
        <span class="text-[13px] font-semibold text-highlighted">{{ t('dashboard.infra.title') }}</span>
      </div>
      <div class="flex items-center gap-1.5">
        <UTooltip v-for="d in infraDots" :key="d.mac" :text="`${d.name} · ${t(`devices.state.${d.state}`)}`">
          <StatusDot :status="d.state === 'online' ? (d.issues.some(i => i.severity !== 'info') ? 'degraded' : 'healthy') : d.state === 'offline' ? 'down' : 'degraded'" :size="9" />
        </UTooltip>
        <span class="text-[12.5px] uf-num text-toned ml-1">{{ t('dashboard.infra.online', { online: infra.online, total: infra.total }) }}</span>
      </div>
      <span v-if="infra.withIssues" class="flex items-center gap-1.5 text-[12.5px] text-warning"><UIcon name="i-lucide-triangle-alert" class="size-3.5" />{{ t('dashboard.infra.issues', { n: infra.withIssues }) }}</span>
      <span v-if="infra.portEvents" class="flex items-center gap-1.5 text-[12.5px] text-warning"><UIcon name="i-lucide-cable" class="size-3.5" />{{ t('dashboard.infra.portEvents', { n: infra.portEvents }) }}</span>
      <span v-if="infra.openIncidents" class="flex items-center gap-1.5 text-[12.5px] text-error"><UIcon name="i-lucide-siren" class="size-3.5" />{{ t('dashboard.infra.incidents', { n: infra.openIncidents }) }}</span>
      <span v-if="!infra.withIssues && !infra.portEvents && !infra.openIncidents && !infra.offline" class="flex items-center gap-1.5 text-[12.5px] text-success"><UIcon name="i-lucide-check-circle-2" class="size-3.5" />{{ t('dashboard.infra.allGood') }}</span>
      <span v-if="infra.poeWatts != null" class="sm:ml-auto flex items-center gap-1.5 text-[12.5px] text-toned uf-num"><UIcon name="i-lucide-zap" class="size-3.5 text-warning" />{{ infra.poeWatts.toFixed(1) }} W</span>
    </NuxtLink>

    <div class="grid xl:grid-cols-[1fr_340px] gap-4">
      <!-- Constellation -->
      <UCard :ui="{ body: 'p-4 sm:p-6' }">
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-orbit" class="size-4 text-primary" />
            <h2 class="text-sm font-semibold text-highlighted">{{ t('dashboard.constellation') }}</h2>
            <span class="text-[12px] text-dimmed hidden sm:inline">· {{ t('dashboard.constellationHint') }}</span>
            <UButton to="/routes" size="xs" color="neutral" variant="ghost" trailing-icon="i-lucide-arrow-right" class="ml-auto">{{ t('common.manage') }}</UButton>
          </div>
        </template>
        <EgressConstellation :routes="routes" :egresses="egresses" :people="people" :clients="clients" />
      </UCard>

      <div class="space-y-4">
        <UCard>
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-calendar-clock" class="size-4 text-primary" />
              <h2 class="text-sm font-semibold text-highlighted">{{ t('dashboard.upcoming') }}</h2>
            </div>
          </template>
          <UpcomingSwitches :items="summary?.upcoming.slice(0, 5) ?? []" />
        </UCard>

        <UCard>
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-activity" class="size-4 text-primary" />
              <h2 class="text-sm font-semibold text-highlighted">{{ t('dashboard.throughput') }}</h2>
              <span class="ml-auto text-[11px] text-dimmed">{{ t('dashboard.last60') }}</span>
            </div>
          </template>
          <div class="flex items-end justify-between mb-3">
            <div>
              <div class="flex items-center gap-1.5 text-[11.5px] text-dimmed"><span class="size-2 rounded-full bg-primary" />{{ t('dashboard.download') }}</div>
              <div class="text-lg font-semibold text-highlighted uf-num">{{ fmt.bps(lastRx) }}</div>
            </div>
            <div class="text-right">
              <div class="flex items-center justify-end gap-1.5 text-[11.5px] text-dimmed"><span class="size-2 rounded-full bg-vpn" />{{ t('dashboard.upload') }}</div>
              <div class="text-lg font-semibold text-highlighted uf-num">{{ fmt.bps(lastTx) }}</div>
            </div>
          </div>
          <div class="relative h-16">
            <Sparkline :values="throughputRx" :width="300" :height="64" class="absolute inset-0 w-full" />
            <Sparkline :values="throughputTx" :width="300" :height="64" color="var(--color-ufpurple-500)" :fill="false" class="absolute inset-0 w-full" />
          </div>
        </UCard>
      </div>
    </div>

    <div class="grid lg:grid-cols-2 gap-4 mt-4">
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-arrow-right-left" class="size-4 text-primary" />
            <h2 class="text-sm font-semibold text-highlighted">{{ t('dashboard.recentSwitches') }}</h2>
            <UButton to="/routes?tab=log" size="xs" color="neutral" variant="ghost" trailing-icon="i-lucide-arrow-right" class="ml-auto">{{ t('common.viewAll') }}</UButton>
          </div>
        </template>
        <div v-if="summary?.recentSwitches.length" class="divide-y divide-(--ui-border-muted) -my-2">
          <div v-for="s in summary.recentSwitches.slice(0, 6)" :key="s.id" class="flex items-center gap-3 py-2.5">
            <span class="text-[12px] text-dimmed uf-num w-11 shrink-0">{{ fmt.time(s.ts) }}</span>
            <div class="min-w-0 flex-1">
              <div class="text-[13px] text-highlighted truncate">{{ s.routeName }}</div>
              <div class="text-[11.5px] text-dimmed">{{ t(`routes.reason.${s.reason}`) }}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <EgressChip v-if="s.fromEgressId" :id="s.fromEgressId" size="xs" class="hidden sm:inline-flex" />
              <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed hidden sm:block" />
              <EgressChip :id="s.toEgressId" size="xs" />
            </div>
            <UTooltip :text="s.error ?? (s.dryRun ? 'dry-run' : s.verified ? t('routes.verified') : t('routes.unverified'))">
              <UIcon :name="s.error ? 'i-lucide-circle-x' : s.dryRun ? 'i-lucide-flask-conical' : s.verified ? 'i-lucide-badge-check' : 'i-lucide-circle-dashed'" class="size-4" :class="s.error ? 'text-error' : s.dryRun ? 'text-warning' : s.verified ? 'text-success' : 'text-dimmed'" />
            </UTooltip>
          </div>
        </div>
        <div v-else class="text-[13px] text-dimmed py-6 text-center">{{ t('dashboard.noSwitches') }}</div>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-scroll-text" class="size-4 text-primary" />
            <h2 class="text-sm font-semibold text-highlighted">{{ t('dashboard.activity') }}</h2>
            <UButton to="/insight/audit" size="xs" color="neutral" variant="ghost" trailing-icon="i-lucide-arrow-right" class="ml-auto">{{ t('common.viewAll') }}</UButton>
          </div>
        </template>
        <div v-if="summary?.recentAudit.length" class="space-y-3.5">
          <AuditItem v-for="ev in summary.recentAudit.slice(0, 6)" :key="ev.id" :event="ev" compact />
        </div>
        <div v-else class="text-[13px] text-dimmed py-6 text-center">{{ t('dashboard.noActivity') }}</div>
      </UCard>
    </div>
  </div>
</template>
