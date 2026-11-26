<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { InfraDeviceT, DeviceTypeT } from '#shared/schemas/infra'
import type { SettingsT } from '#shared/schemas/system'
import { compareDevices, deviceTypeOrder, speedLabel, uptimeShort } from '~/utils/devices'

const { t } = useI18n()
const fmt = useFormat()
const route = useRoute()
const router = useRouter()
const { devices, status } = useDevices()
const { data: settings } = useFetch<SettingsT>('/api/settings', { key: 'settings', dedupe: 'defer' })
const thresholds = computed(() => ({
  temp: settings.value?.infra?.tempWarnC ?? 80,
  cpu: settings.value?.infra?.cpuWarnPct ?? 90,
  mem: settings.value?.infra?.memWarnPct ?? 90,
}))

type Filter = 'all' | 'offline' | 'issues' | 'firmware'
const filter = computed<Filter>({
  get: () => (['offline', 'issues', 'firmware'].includes(route.query.f as string) ? route.query.f as Filter : 'all'),
  set: v => router.replace({ query: { ...route.query, f: v === 'all' ? undefined : v } }),
})
const view = useLocalStorage<'cards' | 'table'>('uf-devices-view', 'cards')

const hasIssue = (d: InfraDeviceT) => d.issues.some(i => i.severity !== 'info')
const matches = (d: InfraDeviceT, f: Filter) =>
  f === 'all' || (f === 'offline' && d.state === 'offline') || (f === 'issues' && hasIssue(d)) || (f === 'firmware' && !!d.upgradeTo)

const rows = computed(() => devices.value.filter(d => matches(d, filter.value)).sort(compareDevices))
const groups = computed(() => deviceTypeOrder
  .map(type => ({ type, items: rows.value.filter(d => d.type === type) }))
  .filter(g => g.items.length))

const counts = computed(() => ({
  all: devices.value.length,
  offline: devices.value.filter(d => d.state === 'offline').length,
  issues: devices.value.filter(hasIssue).length,
  firmware: devices.value.filter(d => d.upgradeTo).length,
}))
const online = computed(() => devices.value.filter(d => d.state === 'online').length)
const clientsTotal = computed(() => devices.value.filter(d => d.type !== 'gateway').reduce((s, d) => s + (d.clients ?? 0), 0))
const poe = computed(() => {
  const src = devices.value.filter(d => d.poe)
  return { used: src.reduce((s, d) => s + (d.poe?.usedW ?? 0), 0), budget: src.reduce((s, d) => s + (d.poe?.budgetW ?? 0), 0), any: src.length > 0 }
})

const filterItems = computed(() => (['all', 'offline', 'issues', 'firmware'] as Filter[]).map(f => ({
  value: f, label: t(`devices.filter.${f}`), count: counts.value[f],
})))

const groupIcon: Record<DeviceTypeT, string> = { gateway: 'i-lucide-router', switch: 'i-lucide-ethernet-port', ap: 'i-lucide-wifi', other: 'i-lucide-box' }

const columns: TableColumn<InfraDeviceT>[] = [
  { accessorKey: 'name', header: () => t('devices.col.device') },
  { id: 'state', header: () => t('devices.col.state') },
  { id: 'ip', header: 'IP' },
  { id: 'uplink', header: () => t('devices.uplink') },
  { id: 'load', header: () => t('devices.col.load') },
  { id: 'clients', header: () => t('devices.clients') },
  { id: 'uptime', header: () => t('devices.uptime') },
  { id: 'firmware', header: () => t('devices.firmware') },
]
function open(d: InfraDeviceT) { navigateTo(`/devices/${encodeURIComponent(d.mac)}`) }
</script>

<template>
  <div>
    <PageHeader :title="t('nav.devices')" :description="t('devices.desc')" icon="i-lucide-server">
      <template #actions>
        <UButton to="/devices/topology" color="neutral" variant="outline" icon="i-lucide-network">{{ t('nav.topology') }}</UButton>
        <UTabs
          v-model="view"
          :content="false"
          size="sm"
          :items="[{ value: 'cards', icon: 'i-lucide-layout-grid', label: t('devices.view.cards') }, { value: 'table', icon: 'i-lucide-rows-3', label: t('devices.view.table') }]"
        />
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      <KpiTile :label="t('devices.kpi.online')" :value="`${online}/${devices.length}`" icon="i-lucide-server" :tone="counts.offline ? 'error' : 'success'" :hint="counts.offline ? t('devices.kpi.offlineN', { n: counts.offline }) : t('devices.kpi.allOnline')" />
      <KpiTile :label="t('devices.kpi.clients')" :value="clientsTotal" icon="i-lucide-monitor-smartphone" to="/clients" :hint="t('devices.kpi.clientsHint')" />
      <KpiTile :label="t('devices.kpi.poe')" :value="poe.any ? `${poe.used.toFixed(1)} W` : '—'" icon="i-lucide-zap" tone="warning" :hint="poe.budget ? t('devices.kpi.poeHint', { budget: poe.budget }) : undefined" to="/devices/poe">
        <div v-if="poe.budget" class="w-16 h-1.5 rounded-full bg-(--ui-bg-accented) overflow-hidden mb-1">
          <div class="h-full rounded-full bg-warning" :style="{ width: `${Math.min(100, (poe.used / poe.budget) * 100)}%` }" />
        </div>
      </KpiTile>
      <KpiTile :label="t('devices.kpi.issues')" :value="counts.issues" icon="i-lucide-stethoscope" :tone="counts.issues ? 'warning' : 'neutral'" :hint="counts.firmware ? t('devices.kpi.firmwareN', { n: counts.firmware }) : t('devices.kpi.firmwareNone')" />
    </div>

    <div class="flex items-center gap-1.5 mb-4 overflow-x-auto -mx-1 px-1 pb-1">
      <button
        v-for="f in filterItems"
        :key="f.value"
        type="button"
        class="h-8 px-3 rounded-full text-[12.5px] font-medium ring-1 transition flex items-center gap-1.5 shrink-0"
        :class="filter === f.value ? 'bg-primary/10 text-primary ring-primary/30' : 'ring-(--ui-border-muted) text-toned hover:ring-(--ui-border-accented)'"
        @click="filter = f.value"
      >
        {{ f.label }}
        <span class="uf-num text-[11px] px-1.5 rounded-full" :class="filter === f.value ? 'bg-primary/15' : 'bg-(--uf-hover) text-dimmed'">{{ f.count }}</span>
      </button>
    </div>

    <template v-if="status === 'pending' && !devices.length">
      <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
        <USkeleton v-for="i in 6" :key="i" class="h-56 rounded-xl" />
      </div>
    </template>

    <div v-else-if="!devices.length" class="uf-card">
      <EmptyState icon="i-lucide-server" :title="t('devices.empty')" :description="t('devices.emptyDesc')" />
    </div>

    <div v-else-if="!rows.length" class="uf-card">
      <EmptyState icon="i-lucide-filter-x" :title="t('devices.noMatch')" :description="t('devices.noMatchDesc')" />
    </div>

    <template v-else-if="view === 'cards'">
      <section v-for="g in groups" :key="g.type" class="mb-7">
        <h2 class="uf-section-title mb-2.5 flex items-center gap-1.5">
          <UIcon :name="groupIcon[g.type]" class="size-3.5" />{{ t(`devices.group.${g.type}`) }}
          <span class="text-dimmed font-normal normal-case tracking-normal">· {{ g.items.length }}</span>
        </h2>
        <div class="grid sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          <DeviceCard v-for="d in g.items" :key="d.mac" :device="d" :thresholds="thresholds" />
        </div>
      </section>
    </template>

    <UCard v-else :ui="{ body: 'p-0 sm:p-0' }">
      <UTable :data="rows" :columns="columns" class="cursor-pointer" :ui="{ tr: 'hover:bg-(--uf-hover)' }" @select="(_e: Event, row: any) => open(row.original)">
        <template #name-cell="{ row }">
          <div class="flex items-center gap-3 min-w-0">
            <DeviceGlyph :type="row.original.type" :model="row.original.model" :state="row.original.state" :size="34" />
            <div class="min-w-0">
              <div class="font-medium text-highlighted truncate max-w-[220px]">{{ row.original.name }}</div>
              <div class="text-[11.5px] text-dimmed truncate max-w-[220px]">{{ row.original.modelName ?? row.original.model }}</div>
            </div>
          </div>
        </template>
        <template #state-cell="{ row }">
          <div class="flex items-center gap-1.5 text-[12.5px]">
            <StatusDot :status="row.original.state === 'online' ? 'healthy' : row.original.state === 'offline' ? 'down' : 'degraded'" />
            <span class="text-toned">{{ t(`devices.state.${row.original.state}`) }}</span>
            <UIcon v-if="row.original.issues.some(i => i.severity !== 'info')" name="i-lucide-triangle-alert" class="size-3.5 text-warning" />
          </div>
        </template>
        <template #ip-cell="{ row }">
          <div class="uf-mono text-toned text-[12.5px]">{{ row.original.ip ?? '—' }}</div>
          <div class="text-[11px] text-dimmed uf-mono">{{ row.original.mac }}</div>
        </template>
        <template #uplink-cell="{ row }">
          <div v-if="row.original.uplink && row.original.type !== 'gateway'" class="text-[12px] text-toned truncate max-w-[180px]">
            {{ row.original.uplink.name ?? '—' }}<span v-if="row.original.uplink.remotePort" class="text-dimmed"> #{{ row.original.uplink.remotePort }}</span>
          </div>
          <div class="text-[11px] text-dimmed uf-num">{{ row.original.uplink?.type === 'wireless' ? `${t('devices.mesh')} ${row.original.uplink.signal ?? ''} dBm` : speedLabel(row.original.uplink?.speedMbps) }}</div>
        </template>
        <template #load-cell="{ row }">
          <div class="grid grid-cols-3 gap-2 w-44">
            <MiniMeter :label="t('devices.cpu')" :value="row.original.cpuPct" :warn="thresholds.cpu * 0.8" :crit="thresholds.cpu" />
            <MiniMeter :label="t('devices.mem')" :value="row.original.memPct" :warn="thresholds.mem * 0.9" :crit="thresholds.mem" />
            <MiniMeter :label="t('devices.temp')" :value="row.original.tempC" unit="°" :warn="thresholds.temp - 10" :crit="thresholds.temp" />
          </div>
        </template>
        <template #clients-cell="{ row }">
          <span class="uf-num text-toned">{{ row.original.clients ?? '—' }}</span>
        </template>
        <template #uptime-cell="{ row }">
          <span class="uf-num text-toned text-[12.5px]">{{ row.original.state === 'offline' ? fmt.ago(row.original.lastSeen) : uptimeShort(row.original.uptimeSec, t) }}</span>
        </template>
        <template #firmware-cell="{ row }">
          <div class="uf-mono text-[12px] text-toned">{{ row.original.firmware ?? '—' }}</div>
          <UBadge v-if="row.original.upgradeTo" color="primary" variant="soft" size="xs" icon="i-lucide-arrow-up-circle">{{ row.original.upgradeTo }}</UBadge>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
