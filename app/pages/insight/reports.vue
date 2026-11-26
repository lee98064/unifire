<script setup lang="ts">
import type { IspReportT, UsageReportT, SpeedtestStatusT } from '#shared/schemas/insight'
import type { EChartsOption } from 'echarts'

const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const route = useRoute()
const router = useRouter()
const tab = computed({ get: () => (route.query.tab as string) || 'isp', set: v => router.replace({ query: { ...route.query, tab: v } }) })

const thisMonth = new Date().toISOString().slice(0, 7)
const month = ref(thisMonth)
const months = computed(() => Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); return d.toISOString().slice(0, 7) }))
const { data: isp, status: ispStatus } = useFetch<IspReportT>('/api/reports/isp', { query: { month }, key: 'report-isp' })
const usageRange = ref<'7d' | '30d' | 'month'>('7d')
const { data: usage } = useFetch<UsageReportT>('/api/reports/usage', { query: { range: usageRange }, key: 'report-usage', immediate: false, watch: [usageRange] })
watch(tab, v => { if (v === 'usage' && !usage.value) refreshNuxtData('report-usage') }, { immediate: true })
const { data: speed, refresh: refreshSpeed } = useFetch<SpeedtestStatusT>('/api/reports/speedtest', { key: 'speedtest' })
const { pause: stopPoll, resume: startPoll } = useIntervalFn(() => refreshSpeed(), 5000, { immediate: false })
watch(() => speed.value?.running, v => (v ? startPoll() : stopPoll()))
function printReport() { window.print() }
async function runSpeedtest() { speed.value = await api.post<SpeedtestStatusT>('/api/reports/speedtest', undefined, { success: t('reports.speedStarted') }) }

const { get: getEgress } = useEgresses()

const dailyChart = computed<EChartsOption>(() => ({
  legend: { bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { fontSize: 11 } },
  grid: { bottom: 32 },
  tooltip: { valueFormatter: (v: unknown) => (v == null ? '—' : `${Number(v).toFixed(2)}%`) },
  xAxis: { type: 'category', data: isp.value?.wans[0]?.daily.map(d => d.date.slice(5)) ?? [] },
  yAxis: { type: 'value', min: (v: { min: number }) => Math.max(0, Math.floor(v.min - 1)), max: 100, axisLabel: { formatter: '{value}%' } },
  series: (isp.value?.wans ?? []).map(w => ({ type: 'line', name: w.name, smooth: 0.2, showSymbol: false, lineStyle: { width: 2, color: getEgress(w.egressId)?.color }, itemStyle: { color: getEgress(w.egressId)?.color }, data: w.daily.map(d => d.uptimePct) })),
}))
const speedChart = computed<EChartsOption>(() => ({
  legend: { bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { fontSize: 11 } },
  grid: { bottom: 32 },
  tooltip: { valueFormatter: (v: unknown) => `${Number(v).toFixed(0)} Mbps` },
  xAxis: { type: 'time' },
  yAxis: { type: 'value', axisLabel: { formatter: '{value}' }, name: 'Mbps', nameTextStyle: { fontSize: 10 } },
  series: [
    { type: 'line', name: t('dashboard.download'), showSymbol: true, symbolSize: 5, lineStyle: { color: '#006FFF' }, itemStyle: { color: '#006FFF' }, data: isp.value?.speedtests.map(s => [s.ts, s.downMbps]) ?? [] },
    { type: 'line', name: t('dashboard.upload'), showSymbol: true, symbolSize: 5, lineStyle: { color: '#8E59FF' }, itemStyle: { color: '#8E59FF' }, data: isp.value?.speedtests.map(s => [s.ts, s.upMbps]) ?? [] },
  ],
}))
const usageDaily = computed<EChartsOption>(() => ({
  tooltip: { valueFormatter: (v: unknown) => fmt.bytes(Number(v)) },
  xAxis: { type: 'category', data: usage.value?.daily.map(d => d.date.slice(5)) ?? [] },
  yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmt.bytes(v, 0) } },
  series: [
    { type: 'bar', stack: 'u', name: t('dashboard.download'), barMaxWidth: 22, itemStyle: { color: '#006FFF' }, data: usage.value?.daily.map(d => d.rxBytes) ?? [] },
    { type: 'bar', stack: 'u', name: t('dashboard.upload'), barMaxWidth: 22, itemStyle: { color: '#8E59FF', borderRadius: [4, 4, 0, 0] }, data: usage.value?.daily.map(d => d.txBytes) ?? [] },
  ],
}))
const heatmap = computed<EChartsOption>(() => {
  const data: [number, number, number][] = []
  usage.value?.heatmap.forEach((row, d) => row.forEach((v, h) => data.push([h, d, v])))
  const max = Math.max(1, ...data.map(x => x[2]))
  return {
    tooltip: { trigger: 'item', formatter: (p: any) => `${fmt.weekday(p.value[1])} ${String(p.value[0]).padStart(2, '0')}:00<br/><b>${fmt.bytes(p.value[2])}</b>` },
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')), splitArea: { show: false } },
    yAxis: { type: 'category', data: Array.from({ length: 7 }, (_, d) => fmt.weekday(d)), inverse: true },
    visualMap: { show: false, min: 0, max, inRange: { color: ['rgba(0,111,255,0.06)', '#4797FF', '#006FFF', '#0047A3'] } },
    series: [{ type: 'heatmap', data, itemStyle: { borderRadius: 3, borderColor: 'transparent', borderWidth: 2 } }],
  }
})
const maxPersonBytes = computed(() => Math.max(1, ...(usage.value?.people.map(p => p.bytes) ?? [1])))
const { get: getPerson } = usePeople()
</script>

<template>
  <div>
    <PageHeader :title="t('nav.reports')" :description="t('reports.desc')" icon="i-lucide-chart-line">
      <template #actions>
        <UButton class="uf-no-print" color="neutral" variant="outline" icon="i-lucide-gauge" :loading="speed?.running" @click="runSpeedtest">{{ t('reports.speedtest') }}</UButton>
        <UButton class="uf-no-print" color="neutral" variant="outline" icon="i-lucide-printer" @click="printReport">{{ t('reports.print') }}</UButton>
      </template>
    </PageHeader>

    <UTabs v-model="tab" :content="false" variant="link" class="mb-5 uf-no-print" :items="[{ value: 'isp', label: t('reports.tabIsp'), icon: 'i-lucide-cable' }, { value: 'usage', label: t('reports.tabUsage'), icon: 'i-lucide-chart-column' }]" />

    <!-- ISP -->
    <div v-if="tab === 'isp'" class="space-y-4">
      <div class="flex items-center gap-3 uf-no-print">
        <USelect v-model="month" :items="months" class="w-36" size="sm" />
        <span v-if="speed?.last" class="text-[12px] text-dimmed">{{ t('reports.lastSpeed') }}: ↓ {{ speed.last.downMbps.toFixed(0) }} / ↑ {{ speed.last.upMbps.toFixed(0) }} Mbps · <TimeAgo :ts="speed.last.ts" /></span>
      </div>
      <div v-if="ispStatus === 'pending' && !isp" class="grid md:grid-cols-3 gap-4"><USkeleton v-for="i in 3" :key="i" class="h-56 rounded-xl" /></div>
      <template v-else-if="isp">
        <div class="grid md:grid-cols-3 gap-4">
          <div v-for="w in isp.wans" :key="w.egressId" class="uf-card p-5">
            <div class="flex items-center gap-2 mb-4">
              <span class="size-2.5 rounded-full" :style="{ background: getEgress(w.egressId)?.color }" />
              <h3 class="text-[14px] font-semibold text-highlighted">{{ w.name }}</h3>
            </div>
            <div class="flex items-end gap-1">
              <span class="text-[34px] leading-none font-semibold tracking-tight uf-num" :class="(w.uptimePct ?? 100) >= 99.9 ? 'text-success' : (w.uptimePct ?? 100) >= 99 ? 'text-highlighted' : 'text-warning'">{{ w.uptimePct?.toFixed(w.uptimePct >= 99.95 ? 2 : 2) ?? '—' }}</span>
              <span class="text-[15px] text-dimmed mb-0.5">%</span>
            </div>
            <div class="text-[12px] text-dimmed">{{ t('reports.uptime') }}</div>
            <dl class="mt-4 grid grid-cols-3 gap-2 text-[12px]">
              <div><dt class="text-dimmed">p50</dt><dd class="text-highlighted font-medium uf-num">{{ fmt.ms(w.latencyP50) }}</dd></div>
              <div><dt class="text-dimmed">p95</dt><dd class="text-highlighted font-medium uf-num">{{ fmt.ms(w.latencyP95) }}</dd></div>
              <div><dt class="text-dimmed">{{ t('health.loss') }}</dt><dd class="text-highlighted font-medium uf-num">{{ fmt.pct(w.lossPct, 2) }}</dd></div>
            </dl>
            <div class="mt-4 pt-3 border-t border-(--ui-border-muted)">
              <div class="text-[12px] text-dimmed mb-1.5">{{ t('reports.outagesN', { n: w.outages.length }) }}</div>
              <div class="space-y-1 max-h-28 overflow-y-auto">
                <div v-for="(o, i) in w.outages.slice(0, 10)" :key="i" class="flex justify-between text-[11.5px]">
                  <span class="text-toned uf-num">{{ fmt.dateTime(o.start) }}</span><span class="text-error uf-num">{{ fmt.minutes(o.durationSec / 60) }}</span>
                </div>
              </div>
            </div>
            <div v-if="w.publicIps.length" class="mt-3 text-[11.5px] text-dimmed">{{ t('reports.ips') }}: <span class="uf-mono text-toned">{{ w.publicIps.map(p => p.ip).join(', ') }}</span></div>
          </div>
        </div>
        <div class="grid lg:grid-cols-2 gap-4">
          <UCard><template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.dailyUptime') }}</h3></template><UfChart :option="dailyChart" height="240px" /></UCard>
          <UCard><template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.speedTrend') }}</h3></template>
            <UfChart v-if="isp.speedtests.length" :option="speedChart" height="240px" />
            <EmptyState v-else icon="i-lucide-gauge" :title="t('reports.noSpeedtests')" />
          </UCard>
        </div>
        <UCard v-if="isp.vpns.length" :ui="{ body: 'p-0 sm:p-0' }">
          <template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.vpnSummary') }}</h3></template>
          <div class="divide-y divide-(--ui-border-muted)">
            <div v-for="v in isp.vpns" :key="v.egressId" class="flex items-center gap-3 px-5 py-2.5">
              <EgressChip :id="v.egressId" size="sm" />
              <div class="flex-1"><UProgress :model-value="v.uptimePct ?? 0" size="xs" :color="(v.uptimePct ?? 0) >= 99 ? 'success' : 'warning'" /></div>
              <span class="w-16 text-right text-[12.5px] text-highlighted uf-num">{{ fmt.pct(v.uptimePct, 1) }}</span>
              <span class="w-16 text-right text-[12px] text-dimmed uf-num">{{ fmt.ms(v.latencyP50) }}</span>
            </div>
          </div>
        </UCard>
      </template>
    </div>

    <!-- Usage -->
    <div v-else class="space-y-4">
      <UTabs v-model="usageRange" :content="false" size="sm" class="uf-no-print w-fit" :items="[{ value: '7d', label: t('reports.r7d') }, { value: '30d', label: t('reports.r30d') }, { value: 'month', label: t('reports.rMonth') }]" />
      <template v-if="usage">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiTile :label="t('dashboard.download')" :value="fmt.bytes(usage.totals.rxBytes)" icon="i-lucide-arrow-down" />
          <KpiTile :label="t('dashboard.upload')" :value="fmt.bytes(usage.totals.txBytes)" icon="i-lucide-arrow-up" tone="vpn" />
          <KpiTile :label="t('reports.topClient')" :value="usage.topClients[0]?.name ?? '—'" icon="i-lucide-trophy" tone="warning" :hint="fmt.bytes(usage.topClients[0]?.bytes)" />
          <KpiTile :label="t('reports.avgDaily')" :value="fmt.bytes((usage.totals.rxBytes + usage.totals.txBytes) / Math.max(1, usage.daily.length))" icon="i-lucide-calendar-days" tone="success" />
        </div>
        <div class="grid lg:grid-cols-[1.4fr_1fr] gap-4">
          <UCard><template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.dailyUsage') }}</h3></template><UfChart :option="usageDaily" height="260px" /></UCard>
          <UCard><template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.whenBusy') }}</h3></template><UfChart :option="heatmap" height="260px" /></UCard>
        </div>
        <div class="grid lg:grid-cols-2 gap-4">
          <UCard :ui="{ body: 'p-0 sm:p-0' }">
            <template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.topClients') }}</h3></template>
            <div class="divide-y divide-(--ui-border-muted)">
              <div v-for="(c, i) in usage.topClients.slice(0, 10)" :key="c.mac" class="flex items-center gap-3 px-5 py-2.5">
                <span class="w-5 text-[12px] text-dimmed uf-num">{{ i + 1 }}</span>
                <div class="min-w-0 flex-1"><div class="text-[13px] text-highlighted truncate">{{ c.name }}</div><div class="text-[11px] text-dimmed">{{ fmt.minutes(c.activeMinutes) }}</div></div>
                <PersonAvatar v-if="getPerson(c.personId)" :avatar="getPerson(c.personId)!.avatar" :color="getPerson(c.personId)!.color" :size="20" />
                <span class="text-[12.5px] text-toned uf-num w-20 text-right">{{ fmt.bytes(c.bytes) }}</span>
              </div>
            </div>
          </UCard>
          <UCard>
            <template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.byPerson') }}</h3></template>
            <div class="space-y-3">
              <div v-for="p in usage.people" :key="p.personId" class="flex items-center gap-3">
                <PersonAvatar :avatar="getPerson(p.personId)?.avatar ?? '?'" :color="getPerson(p.personId)?.color ?? '#888'" :size="28" />
                <div class="flex-1 min-w-0">
                  <div class="flex justify-between text-[12.5px] mb-1"><span class="text-highlighted">{{ p.name }}</span><span class="text-toned uf-num">{{ fmt.bytes(p.bytes) }} · {{ fmt.minutes(p.activeMinutes) }}</span></div>
                  <div class="h-2 rounded-full bg-(--ui-bg-accented) overflow-hidden"><div class="h-full rounded-full transition-[width] duration-700" :style="{ width: `${(p.bytes / maxPersonBytes) * 100}%`, background: getPerson(p.personId)?.color }" /></div>
                </div>
              </div>
            </div>
          </UCard>
        </div>
      </template>
      <USkeleton v-else class="h-80 rounded-xl" />
    </div>
  </div>
</template>
