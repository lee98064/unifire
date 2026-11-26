<script setup lang="ts">
import type { ManagedRouteT, UnifiRouteT, SwitchLogEntryT } from '#shared/schemas/routes'
import type { TableColumn } from '@nuxt/ui'
import { wallClock } from '#shared/utils/schedule'

const { t, te } = useI18n()
const msg = useMsg()
const matchLabel = (v: string) => (te(`routes.match.${v}`) ? t(`routes.match.${v}`) : v)
const fmt = useFormat()
const route = useRoute()
const router = useRouter()

const tab = computed({
  get: () => (route.query.tab as string) || 'managed',
  set: v => router.replace({ query: { ...route.query, tab: v } }),
})
const { data: managed, status: mStatus } = useFetch<ManagedRouteT[]>('/api/managed-routes', { key: 'managed-routes', default: () => [] })
const { data: unifi } = useFetch<UnifiRouteT[]>('/api/routes', { key: 'routes', default: () => [] })
const { data: log } = useFetch<{ items: SwitchLogEntryT[], nextCursor: string | null }>('/api/switch-log', { key: 'switch-log', query: { limit: 100 }, default: () => ({ items: [], nextCursor: null }) })
const { get: getEgress } = useEgresses()

const addOpen = ref(false)
const adoptPreselect = ref<string | null>(null)
function adopt(id: string) { adoptPreselect.value = id; addOpen.value = true }

const search = ref('')
const ownershipFilter = ref<string>('all')
const filteredUnifi = computed(() => unifi.value.filter(r =>
  (ownershipFilter.value === 'all' || r.ownership === ownershipFilter.value)
  && (!search.value || r.description.toLowerCase().includes(search.value.toLowerCase())),
))

const ownershipUi: Record<string, { color: 'primary' | 'neutral' | 'warning' | 'secondary' | 'success' | 'error', icon: string }> = {
  managed: { color: 'primary', icon: 'i-lucide-flame' },
  probe: { color: 'secondary', icon: 'i-lucide-radar' },
  external: { color: 'neutral', icon: 'i-lucide-circle-dashed' },
  excluded: { color: 'error', icon: 'i-lucide-ban' },
  object: { color: 'warning', icon: 'i-lucide-box' },
  predefined: { color: 'neutral', icon: 'i-lucide-lock' },
}

const unifiColumns: TableColumn<UnifiRouteT>[] = [
  { accessorKey: 'description', header: () => t('routes.name') },
  { id: 'match', header: () => t('routes.matching') },
  { id: 'egress', header: () => t('routes.egress') },
  { id: 'ownership', header: () => t('routes.ownership') },
  { id: 'actions', header: '' },
]
const logColumns: TableColumn<SwitchLogEntryT>[] = [
  { id: 'ts', header: () => t('common.time') },
  { accessorKey: 'routeName', header: () => t('routes.name') },
  { id: 'change', header: () => t('routes.change') },
  { id: 'reason', header: () => t('routes.reasonCol') },
  { id: 'result', header: () => t('routes.result') },
]

const stateUi: Record<string, { color: 'success' | 'warning' | 'error' | 'neutral', label: string }> = {
  active: { color: 'success', label: 'routes.state.active' },
  paused: { color: 'neutral', label: 'routes.state.paused' },
  drift: { color: 'warning', label: 'routes.state.drift' },
  error: { color: 'error', label: 'routes.state.error' },
  pending: { color: 'neutral', label: 'routes.state.pending' },
}
</script>

<template>
  <div>
    <PageHeader :title="t('nav.routes')" :description="t('routes.desc')" icon="i-lucide-waypoints">
      <template #actions>
        <UButton icon="i-lucide-plus" @click="adoptPreselect = null; addOpen = true">{{ t('routes.add') }}</UButton>
      </template>
    </PageHeader>

    <UTabs
      v-model="tab"
      :items="[
        { value: 'managed', label: t('routes.tabManaged'), icon: 'i-lucide-flame', badge: managed.length || undefined },
        { value: 'unifi', label: t('routes.tabUnifi'), icon: 'i-lucide-list', badge: unifi.length || undefined },
        { value: 'log', label: t('routes.tabLog'), icon: 'i-lucide-history' },
      ]"
      :content="false"
      variant="link"
      class="mb-5"
    />

    <!-- Managed -->
    <div v-if="tab === 'managed'">
      <div v-if="mStatus === 'pending' && !managed.length" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        <USkeleton v-for="i in 3" :key="i" class="h-52 rounded-xl" />
      </div>
      <div v-else-if="managed.length" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        <NuxtLink v-for="r in managed" :key="r.id" :to="`/routes/${r.id}`" class="uf-card uf-card-hover p-5 flex flex-col gap-4 group">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <h3 class="text-[15px] font-semibold text-highlighted truncate">{{ r.name }}</h3>
                <UBadge :color="stateUi[r.state]!.color" variant="subtle" size="sm">{{ t(stateUi[r.state]!.label) }}</UBadge>
              </div>
              <p class="text-[12px] text-dimmed mt-0.5 truncate">{{ matchLabel(r.matchingTarget) }} · {{ t('routes.sourcesN', { n: r.targets.length }) }}<template v-if="r.killSwitch"> · Kill switch</template></p>
            </div>
            <UIcon name="i-lucide-chevron-right" class="size-4 text-dimmed group-hover:text-highlighted group-hover:translate-x-0.5 transition" />
          </div>

          <div class="flex items-center gap-3 p-3 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted)">
            <div class="min-w-0 flex-1">
              <div class="uf-section-title mb-1">{{ t('routes.current') }}</div>
              <EgressChip :id="r.actualEgressId ?? r.desired.egressId" size="md" show-health />
            </div>
            <div v-if="r.next" class="text-right min-w-0">
              <div class="uf-section-title mb-1">{{ t('routes.next') }} · {{ fmt.time(r.next.at) }}</div>
              <EgressChip :id="r.next.egressId" size="sm" />
            </div>
          </div>

          <!-- mini schedule strip (today) -->
          <div v-if="r.schedule" class="flex gap-[2px] h-2.5">
            <span
              v-for="(cell, h) in r.schedule.grid[wallClock(Date.now(), r.schedule.timezone).day]"
              :key="h"
              class="flex-1 rounded-[2px]"
              :style="{ background: getEgress(cell ?? r.defaultEgressId)?.color ?? 'var(--ui-bg-accented)', opacity: cell ? 1 : 0.35 }"
            />
          </div>
          <div v-else class="text-[12px] text-dimmed flex items-center gap-1.5"><UIcon name="i-lucide-calendar-off" class="size-3.5" />{{ t('routes.noSchedule') }}</div>

          <div class="flex items-center gap-3 text-[11.5px] text-dimmed mt-auto">
            <span v-if="r.failover.enabled" class="flex items-center gap-1"><UIcon name="i-lucide-life-buoy" class="size-3.5 text-success" />{{ t('routes.failoverOn') }}</span>
            <span v-if="r.activeOverride" class="flex items-center gap-1 text-vpn"><UIcon name="i-lucide-timer" class="size-3.5" />{{ t('routes.overrideUntil', { time: fmt.time(r.activeOverride.endsAt) }) }}</span>
            <span class="ml-auto">{{ t('routes.lastSwitch') }} <TimeAgo :ts="r.lastSwitchAt" /></span>
          </div>
        </NuxtLink>
      </div>
      <div v-else class="uf-card">
        <EmptyState icon="i-lucide-waypoints" :title="t('routes.emptyTitle')" :description="t('routes.emptyDesc')">
          <UButton icon="i-lucide-plus" @click="addOpen = true">{{ t('routes.add') }}</UButton>
          <UButton color="neutral" variant="outline" icon="i-lucide-hand-helping" @click="tab = 'unifi'">{{ t('routes.browseUnifi') }}</UButton>
        </EmptyState>
      </div>
    </div>

    <!-- All UniFi routes -->
    <UCard v-else-if="tab === 'unifi'" :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="flex flex-col sm:flex-row gap-2">
          <UInput v-model="search" icon="i-lucide-search" :placeholder="t('common.search')" class="sm:w-64" size="sm" />
          <USelect
            v-model="ownershipFilter"
            size="sm"
            class="sm:w-48"
            :items="[{ value: 'all', label: t('routes.allOwnership') }, ...Object.keys(ownershipUi).map(k => ({ value: k, label: t(`routes.own.${k}`) }))]"
          />
          <p class="sm:ml-auto text-[12px] text-dimmed self-center">{{ t('routes.ownershipHint') }}</p>
        </div>
      </template>
      <UTable :data="filteredUnifi" :columns="unifiColumns" class="min-w-0">
        <template #description-cell="{ row }">
          <div class="min-w-0">
            <div class="font-medium text-highlighted truncate max-w-[280px]" :class="row.original.enabled ? '' : 'opacity-50'">{{ row.original.description || t('routes.unnamed') }}</div>
            <div class="text-[11.5px] text-dimmed truncate max-w-[280px]">{{ row.original.destinations.slice(0, 3).join(', ') }}</div>
          </div>
        </template>
        <template #match-cell="{ row }">
          <span class="text-[12.5px] text-toned">{{ matchLabel(row.original.matchingTarget) }}</span>
          <UBadge v-if="!row.original.enabled" color="neutral" variant="outline" size="xs" class="ml-1.5">{{ t('common.disabled') }}</UBadge>
        </template>
        <template #egress-cell="{ row }"><EgressChip :id="row.original.egressId" size="xs" /></template>
        <template #ownership-cell="{ row }">
          <div class="flex items-center gap-1.5">
            <UBadge :color="ownershipUi[row.original.ownership]!.color" variant="subtle" size="sm" :icon="ownershipUi[row.original.ownership]!.icon">{{ t(`routes.own.${row.original.ownership}`) }}</UBadge>
            <UTooltip v-if="row.original.suspectedAutomation" :text="t('routes.suspectedAutomationHint')">
              <UBadge color="warning" variant="outline" size="sm" icon="i-lucide-bot">{{ t('routes.suspectedAutomation') }}</UBadge>
            </UTooltip>
          </div>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end">
            <UButton v-if="row.original.ownership === 'managed' && row.original.managedRouteId" size="xs" color="neutral" variant="ghost" trailing-icon="i-lucide-arrow-right" :to="`/routes/${row.original.managedRouteId}`">{{ t('common.open') }}</UButton>
            <UButton v-else-if="row.original.ownership === 'external' && !row.original.suspectedAutomation" size="xs" color="neutral" variant="outline" icon="i-lucide-hand-helping" @click="adopt(row.original.id)">{{ t('routes.adopt') }}</UButton>
          </div>
        </template>
      </UTable>
    </UCard>

    <!-- Switch log -->
    <UCard v-else :ui="{ body: 'p-0 sm:p-0' }">
      <UTable :data="log.items" :columns="logColumns" :empty="t('dashboard.noSwitches')">
        <template #ts-cell="{ row }"><span class="uf-num text-toned text-[12.5px]">{{ fmt.dateTime(row.original.ts) }}</span></template>
        <template #routeName-cell="{ row }"><NuxtLink :to="`/routes/${row.original.managedRouteId}`" class="font-medium text-highlighted hover:text-primary">{{ row.original.routeName }}</NuxtLink></template>
        <template #change-cell="{ row }">
          <div class="flex items-center gap-1.5">
            <EgressChip v-if="row.original.fromEgressId" :id="row.original.fromEgressId" size="xs" />
            <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed" />
            <EgressChip :id="row.original.toEgressId" size="xs" />
          </div>
        </template>
        <template #reason-cell="{ row }"><span class="text-[12.5px] text-toned">{{ t(`routes.reason.${row.original.reason}`) }}</span></template>
        <template #result-cell="{ row }">
          <UBadge v-if="row.original.error" color="error" variant="subtle" size="sm" icon="i-lucide-circle-x">{{ msg(row.original.error) }}</UBadge>
          <UBadge v-else-if="row.original.dryRun" color="warning" variant="subtle" size="sm" icon="i-lucide-flask-conical">dry-run</UBadge>
          <UBadge v-else-if="row.original.verified" color="success" variant="subtle" size="sm" icon="i-lucide-badge-check">{{ t('routes.verified') }} · {{ row.original.durationMs }} ms</UBadge>
          <UBadge v-else color="neutral" variant="subtle" size="sm">{{ t('routes.unverified') }}</UBadge>
        </template>
      </UTable>
    </UCard>

    <AddRouteModal v-model:open="addOpen" :unifi-routes="unifi" :preselect="adoptPreselect" />
  </div>
</template>
