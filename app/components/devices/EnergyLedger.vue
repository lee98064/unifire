<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { EnergyPeriodT, EnergyReportT } from '#shared/schemas/infra'
import type { SettingsT } from '#shared/schemas/system'
import { identityPalette } from '~/utils/egress'

/** PoE energy ledger: kWh per period, cost, top consumers and what the PoE schedules saved. */
const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const period = ref<EnergyPeriodT>('month')
const anchor = ref(Date.now())
const { data: report, status, refresh } = useFetch<EnergyReportT>('/api/energy', { key: 'energy', query: { period, at: anchor } })
const { data: settings, refresh: refreshSettings } = useFetch<SettingsT>('/api/settings', { key: 'settings', dedupe: 'defer' })

function shift(dir: -1 | 1) {
  const r = report.value
  if (!r) return
  anchor.value = dir < 0 ? r.from - 1 : r.to + 1
}
const isCurrent = computed(() => !!report.value && report.value.to >= Date.now())
watch(period, () => { anchor.value = Date.now() })

const label = computed(() => {
  const r = report.value
  if (!r) return ''
  if (period.value === 'day') return fmt.date(r.from)
  if (period.value === 'year') return new Intl.DateTimeFormat(undefined, { year: 'numeric', timeZone: r.timezone }).format(r.from)
  if (period.value === 'month') return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', timeZone: r.timezone }).format(r.from)
  return `${fmt.date(r.from)} – ${fmt.date(r.to - 1)}`
})
const kwh = (wh: number | null | undefined) => (wh == null ? '—' : wh >= 100_000 ? (wh / 1000).toFixed(0) : (wh / 1000).toFixed(wh < 10_000 ? 2 : 1))
const delta = computed(() => {
  const r = report.value
  if (!r?.previousTotalWh) return null
  return ((r.totalWh - r.previousTotalWh) / r.previousTotalWh) * 100
})
const deviceColor = computed(() => new Map((report.value?.byDevice ?? []).map((d, i) => [d.mac, identityPalette[i % identityPalette.length]!])))
const chart = computed<EChartsOption>(() => {
  const r = report.value
  const devices = r?.byDevice ?? []
  const barWidth = period.value === 'day' ? '60%' : '55%'
  return {
    legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 4, textStyle: { fontSize: 11 } },
    grid: { top: 28 },
    tooltip: { valueFormatter: (v: unknown) => `${(Number(v) / 1000).toFixed(3)} kWh` },
    xAxis: { type: 'time' },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v / 1000).toFixed(v < 1000 ? 2 : 1)}` }, name: 'kWh', nameTextStyle: { fontSize: 10 } },
    series: devices.map(d => ({
      type: 'bar', name: d.name, stack: 'e', barWidth, itemStyle: { color: deviceColor.value.get(d.mac), borderRadius: 2 },
      data: (r?.series ?? []).map(p => [p.ts, p.byDevice[d.mac] ?? 0]),
    })),
  }
})
const topPorts = computed(() => (report.value?.byDevice ?? []).flatMap(d => d.ports.map(p => ({ ...p, device: d.name, mac: d.mac }))).sort((a, b) => b.wh - a.wh).slice(0, 10))
const topMax = computed(() => Math.max(1, ...topPorts.value.map(p => p.wh)))
const savedWh = computed(() => (report.value?.savings ?? []).reduce((s, x) => s + x.wh, 0))

/* inline electricity price */
const rateOpen = ref(false)
const rateForm = reactive({ rate: null as number | null, currency: 'TWD' })
watch(rateOpen, (v) => { if (v) Object.assign(rateForm, { rate: settings.value?.energy?.ratePerKwh ?? null, currency: settings.value?.energy?.currency ?? 'TWD' }) })
async function saveRate() {
  await api.patch('/api/settings', { energy: { ratePerKwh: rateForm.rate, currency: rateForm.currency } }, { success: t('common.saved') })
  rateOpen.value = false
  await Promise.all([refreshSettings(), refresh()])
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <UTabs v-model="period" :content="false" size="sm" :items="(['day', 'week', 'month', 'year'] as const).map(v => ({ value: v, label: t(`energy.period.${v}`) }))" />
      <div class="flex items-center gap-1 ml-auto">
        <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-chevron-left" :aria-label="t('energy.prev')" @click="shift(-1)" />
        <span class="text-[13px] font-medium text-highlighted min-w-32 text-center uf-num">{{ label }}</span>
        <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-chevron-right" :aria-label="t('energy.next')" :disabled="isCurrent" @click="shift(1)" />
      </div>
      <UPopover v-model:open="rateOpen">
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-receipt">{{ settings?.energy?.ratePerKwh != null ? t('energy.rate', { rate: settings.energy.ratePerKwh, currency: settings.energy.currency }) : t('energy.setRate') }}</UButton>
        <template #content>
          <div class="p-3 w-64 space-y-3">
            <UFormField :label="t('energy.ratePerKwh')" :hint="t('energy.rateHint')"><UInputNumber v-model="rateForm.rate" :min="0" :step="0.1" :format-options="{ maximumFractionDigits: 2 }" class="w-full" /></UFormField>
            <UFormField :label="t('energy.currency')"><UInput v-model="rateForm.currency" class="w-full" /></UFormField>
            <UButton block size="sm" @click="saveRate">{{ t('common.save') }}</UButton>
          </div>
        </template>
      </UPopover>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiTile :label="t('energy.total')" :value="`${kwh(report?.totalWh)} kWh`" icon="i-lucide-zap" tone="warning">
        <span v-if="delta != null" class="text-[12px] uf-num font-medium" :class="delta > 0 ? 'text-error' : 'text-success'">{{ delta > 0 ? '▲' : '▼' }} {{ Math.abs(delta).toFixed(0) }}%</span>
      </KpiTile>
      <KpiTile :label="t('energy.cost')" :value="report?.cost != null ? `${report.currency} ${report.cost.toFixed(report.cost < 100 ? 1 : 0)}` : '—'" icon="i-lucide-receipt" :hint="report?.ratePerKwh == null ? t('energy.noRate') : undefined" />
      <KpiTile :label="t('energy.saved')" :value="`${kwh(savedWh)} kWh`" icon="i-lucide-leaf" tone="success" :hint="t('energy.savedHint')" />
      <KpiTile :label="t('energy.live')" :value="report?.liveW != null ? `${report.liveW.toFixed(1)} W` : '—'" icon="i-lucide-activity" tone="neutral" :hint="report && report.coverage < 0.95 ? t('energy.coverage', { pct: Math.round(report.coverage * 100) }) : undefined" />
    </div>

    <UCard>
      <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('energy.byTime') }}</h2></template>
      <UfChart v-if="report || status !== 'pending'" :option="chart" height="260px" />
      <USkeleton v-else class="h-[260px]" />
    </UCard>

    <div class="grid lg:grid-cols-2 gap-4">
      <UCard>
        <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('energy.top') }}</h2></template>
        <div v-if="topPorts.length" class="space-y-2.5">
          <div v-for="p in topPorts" :key="`${p.mac}-${p.idx}`" class="grid grid-cols-[1fr_90px] items-center gap-3 text-[12.5px]">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="size-2 rounded-full shrink-0" :style="{ background: deviceColor.get(p.mac) }" />
                <span class="text-highlighted truncate">{{ p.peerName ?? p.name ?? t('ports.port', { n: p.idx }) }}</span>
                <span class="text-dimmed shrink-0">· {{ p.device }} #{{ p.idx }}</span>
              </div>
              <div class="h-1.5 mt-1 rounded-full bg-(--ui-bg-accented) overflow-hidden"><div class="h-full rounded-full" :style="{ width: `${(p.wh / topMax) * 100}%`, background: deviceColor.get(p.mac) }" /></div>
            </div>
            <span class="text-right uf-num font-medium text-highlighted">{{ kwh(p.wh) }} kWh</span>
          </div>
        </div>
        <EmptyState v-else icon="i-lucide-zap" :title="t('energy.empty')" :description="t('energy.emptyDesc')" />
      </UCard>
      <UCard>
        <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('energy.savings') }}</h2></template>
        <div v-if="report?.savings.length" class="divide-y divide-(--ui-border-muted)">
          <div v-for="s in report.savings" :key="s.scheduleId" class="flex items-center gap-3 py-2.5 text-[12.5px]">
            <span class="size-7 rounded-md bg-success/10 text-success flex items-center justify-center shrink-0"><UIcon name="i-lucide-leaf" class="size-3.5" /></span>
            <span class="text-highlighted truncate flex-1">{{ s.name }}</span>
            <span class="uf-num text-toned">{{ kwh(s.wh) }} kWh</span>
            <span v-if="s.cost != null" class="uf-num text-success w-20 text-right">{{ report.currency }} {{ s.cost.toFixed(1) }}</span>
          </div>
        </div>
        <EmptyState v-else icon="i-lucide-leaf" :title="t('energy.noSavings')" :description="t('energy.noSavingsDesc')" />
      </UCard>
    </div>
  </div>
</template>
