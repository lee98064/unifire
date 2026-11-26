<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { PortDetailT, SeriesRangeT } from '#shared/schemas/infra'
import type { SettingsT } from '#shared/schemas/system'
import { portName, speedColor, speedLabel, speedTier } from '~/utils/devices'

/** One port's history: link speed/up, traffic, errors, PoE draw, every device ever plugged in, events. */
const props = defineProps<{ mac: string, idx: number | null, deviceName: string }>()
const open = defineModel<boolean>('open', { required: true })
const { t, te } = useI18n()
const fmt = useFormat()
const api = useApi()
const { get: person } = usePeople()
const range = ref<SeriesRangeT>('24h')
const { data, status, error, execute } = useFetch<PortDetailT>(() => `/api/devices/${encodeURIComponent(props.mac)}/ports/${props.idx}`, { query: { range }, immediate: false, watch: false })
watch([open, () => props.idx, range], () => { if (open.value && props.idx) execute() }, { immediate: true })
const p = computed(() => data.value?.port ?? null)
const txt = (k: string, params: Record<string, string>) => (te(k) ? t(k, params) : k)

const chart = computed<EChartsOption>(() => {
  const pts = data.value?.series ?? []
  const few = pts.length < 3
  return {
    legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 4, textStyle: { fontSize: 11 } },
    grid: { top: 26 },
    tooltip: {},
    xAxis: { type: 'time' },
    yAxis: [{ type: 'value', axisLabel: { formatter: (v: number) => fmt.bps(v) } }, { type: 'value', splitLine: { show: false }, axisLabel: { formatter: (v: number) => speedLabel(v) } }],
    series: [
      { type: 'line', name: t('devices.chart.down'), showSymbol: few, smooth: 0.2, areaStyle: { opacity: 0.12 }, lineStyle: { width: 1.4 }, data: pts.map(x => [x.ts, x.rxBps]), tooltip: { valueFormatter: (v: unknown) => fmt.bps(Number(v)) } },
      { type: 'line', name: t('devices.chart.up'), showSymbol: few, smooth: 0.2, lineStyle: { width: 1.4 }, data: pts.map(x => [x.ts, x.txBps]), tooltip: { valueFormatter: (v: unknown) => fmt.bps(Number(v)) } },
      { type: 'line', name: t('ports.col.speed'), yAxisIndex: 1, step: 'end', showSymbol: few, lineStyle: { width: 1.2, type: 'dashed' }, data: pts.map(x => [x.ts, x.up === 0 ? 0 : x.speedMbps]), tooltip: { valueFormatter: (v: unknown) => speedLabel(Number(v)) } },
    ],
    color: ['#006FFF', '#8E59FF', '#38CC65'],
  }
})
const errChart = computed<EChartsOption>(() => {
  const pts = data.value?.series ?? []
  return {
    grid: { top: 10 },
    tooltip: {},
    xAxis: { type: 'time' },
    yAxis: [{ type: 'value', minInterval: 1 }, { type: 'value', splitLine: { show: false }, axisLabel: { formatter: '{value} W' } }],
    series: [
      { type: 'bar', name: t('ports.errors'), barMaxWidth: 6, itemStyle: { color: 'rgba(240,58,62,.7)' }, data: pts.map(x => [x.ts, x.errors]) },
      { type: 'bar', name: t('ports.drops'), barMaxWidth: 6, itemStyle: { color: 'rgba(245,165,36,.6)' }, data: pts.map(x => [x.ts, x.drops]) },
      ...(p.value?.poe?.capable ? [{ type: 'line' as const, name: 'PoE', yAxisIndex: 1, showSymbol: false, step: 'end' as const, lineStyle: { width: 1.2, color: '#F5A524' }, itemStyle: { color: '#F5A524' }, data: pts.map(x => [x.ts, x.poeW]) }] : []),
    ],
  }
})

const { data: settings, refresh: refreshSettings } = useFetch<SettingsT>('/api/settings', { key: 'settings', dedupe: 'defer' })
const ignored = computed(() => !!settings.value?.infra?.ignoredPorts.some(x => x.switchMac === props.mac && x.portIdx === props.idx))
async function toggleIgnore() {
  const cur = settings.value?.infra
  if (!cur || props.idx == null) return
  const ignoredPorts = ignored.value ? cur.ignoredPorts.filter(x => !(x.switchMac === props.mac && x.portIdx === props.idx)) : [...cur.ignoredPorts, { switchMac: props.mac, portIdx: props.idx }]
  await api.patch('/api/settings', { infra: { ...cur, ignoredPorts } }, { success: ignored.value ? t('ports.unignored') : t('ports.ignoredToast') })
  await refreshSettings()
}
async function ack(id: string) {
  await api.patch(`/api/ports/events/${id}`, { acknowledged: true })
  execute()
  refreshNuxtData(['device-detail', 'dashboard'])
}
</script>

<template>
  <USlideover v-model:open="open" :title="idx ? `${deviceName} · ${t('ports.port', { n: idx })}` : ''" :description="p ? (portName(p) ?? p.peer?.name ?? '') : ''" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <div v-if="error" class="py-6"><EmptyState icon="i-lucide-ethernet-port" :title="t('ports.historyUnavailable')" :description="t('ports.historyUnavailableDesc')" /></div>
      <USkeleton v-else-if="!data && status === 'pending'" class="h-64" />
      <div v-else-if="p" class="space-y-5">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
            <div class="text-[11px] text-dimmed">{{ t('ports.col.speed') }}</div>
            <div class="text-[15px] font-semibold uf-num" :style="{ color: speedColor[speedTier(p.speedMbps, p.up)] }">{{ p.up ? speedLabel(p.speedMbps) : t('ports.down') }}</div>
            <div class="text-[11px] text-dimmed uf-num">{{ t('ports.max', { s: speedLabel(p.maxSpeedMbps) }) }}<template v-if="p.baselineSpeedMbps"> · {{ t('ports.baseline', { s: speedLabel(p.baselineSpeedMbps) }) }}</template></div>
          </div>
          <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
            <div class="text-[11px] text-dimmed">{{ t('ports.errorRate') }}</div>
            <div class="text-[15px] font-semibold uf-num text-highlighted">{{ p.errorRatePct == null ? '—' : `${p.errorRatePct.toFixed(p.errorRatePct < 0.1 ? 3 : 2)}%` }}</div>
            <div class="text-[11px] text-dimmed">{{ t('ports.lastHour') }}</div>
          </div>
          <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
            <div class="text-[11px] text-dimmed">{{ t('ports.flaps') }}</div>
            <div class="text-[15px] font-semibold uf-num" :class="p.flaps1h ? 'text-warning' : 'text-highlighted'">{{ p.flaps1h }}</div>
            <div class="text-[11px] text-dimmed">{{ t('ports.lastHour') }}</div>
          </div>
          <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
            <div class="text-[11px] text-dimmed">PoE</div>
            <div class="text-[15px] font-semibold uf-num text-highlighted">{{ !p.poe?.capable ? '—' : p.poe.mode === 'off' ? t('ports.poeOffShort') : `${(p.poe.powerW ?? 0).toFixed(1)} W` }}</div>
            <div class="text-[11px] text-dimmed">{{ p.poe?.poeClass ?? (p.poe?.capable ? p.poe.mode : '') }}</div>
          </div>
        </div>

        <div class="flex items-center justify-between">
          <h3 class="text-[13px] font-semibold text-highlighted">{{ t('ports.history') }}</h3>
          <UTabs v-model="range" :content="false" size="xs" :items="(['24h', '7d', '30d'] as const).map(v => ({ value: v, label: v }))" />
        </div>
        <div class="rounded-lg ring-1 ring-(--ui-border-muted) p-2"><UfChart :option="chart" height="200px" /></div>
        <div class="rounded-lg ring-1 ring-(--ui-border-muted) p-2"><UfChart :option="errChart" height="120px" /></div>

        <div>
          <h3 class="text-[13px] font-semibold text-highlighted mb-2">{{ t('ports.peersHistory') }}</h3>
          <div v-if="data!.peers.length" class="divide-y divide-(--ui-border-muted) rounded-lg ring-1 ring-(--ui-border-muted)">
            <div v-for="peer in data!.peers" :key="peer.mac" class="flex items-center gap-2.5 px-3 py-2 text-[12.5px]">
              <PersonAvatar v-if="peer.personId && person(peer.personId)" :avatar="person(peer.personId)!.avatar" :color="person(peer.personId)!.color" :size="20" />
              <UIcon v-else name="i-lucide-monitor-smartphone" class="size-4 text-dimmed" />
              <span class="text-highlighted truncate">{{ peer.name ?? peer.mac }}</span>
              <span class="text-[11px] text-dimmed uf-mono hidden sm:inline">{{ peer.mac }}</span>
              <span class="ml-auto text-[11.5px] text-dimmed uf-num whitespace-nowrap">{{ speedLabel(peer.maxSpeedMbps) }} · <TimeAgo :ts="peer.lastSeen" /></span>
            </div>
          </div>
          <p v-else class="text-[12.5px] text-dimmed">{{ t('ports.noPeers') }}</p>
        </div>

        <div v-if="data!.events.length">
          <h3 class="text-[13px] font-semibold text-highlighted mb-2">{{ t('devices.tab.events') }}</h3>
          <div class="space-y-1.5">
            <div v-for="e in data!.events" :key="e.id" class="flex items-start gap-2.5 rounded-lg px-3 py-2 text-[12.5px]" :class="e.acknowledged ? 'bg-(--uf-surface-2)' : e.severity === 'error' ? 'bg-error/8' : e.severity === 'warning' ? 'bg-warning/8' : 'bg-(--uf-surface-2)'">
              <UIcon :name="e.kind === 'recovered' ? 'i-lucide-check-circle-2' : 'i-lucide-triangle-alert'" class="size-4 mt-0.5 shrink-0" :class="e.kind === 'recovered' ? 'text-success' : e.severity === 'error' ? 'text-error' : 'text-warning'" />
              <div class="min-w-0 flex-1">
                <div class="text-highlighted">{{ txt(e.messageKey, e.messageParams) }}</div>
                <div class="text-[11px] text-dimmed uf-num">{{ fmt.dateTime(e.ts) }}</div>
              </div>
              <UButton v-if="!e.acknowledged && e.kind !== 'recovered'" size="xs" color="neutral" variant="ghost" icon="i-lucide-check" @click="ack(e.id)">{{ t('ports.ack') }}</UButton>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap gap-2 pt-4 border-t border-(--ui-border-muted)">
          <UButton size="sm" color="neutral" variant="outline" :icon="ignored ? 'i-lucide-bell' : 'i-lucide-bell-off'" @click="toggleIgnore">{{ ignored ? t('ports.unignore') : t('ports.ignore') }}</UButton>
          <UButton v-if="p.poe?.capable && p.poeSafety.allowed" size="sm" color="neutral" variant="outline" icon="i-lucide-calendar-clock" :to="`/devices/poe?port=${encodeURIComponent(mac)}|${idx}`">{{ t('ports.schedulePoe') }}</UButton>
        </div>
      </div>
    </template>
  </USlideover>
</template>
