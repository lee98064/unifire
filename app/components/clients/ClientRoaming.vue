<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { ClientRoamsT, StickyClientT } from '#shared/schemas/infra'
import { identityPalette } from '~/utils/egress'

/** Wi-Fi roaming trail for one wireless client: signal over 24 h coloured per AP, time per AP, hops. */
const props = defineProps<{ mac: string, sticky?: StickyClientT | null }>()
const { t } = useI18n()
const fmt = useFormat()
const window_ = computed(() => ({ from: Date.now() - 86_400_000, to: Date.now() + 60_000 }))
const { data, error, status } = useFetch<ClientRoamsT>(() => `/api/clients/${props.mac}/roams`, { query: window_, key: `roams-${props.mac}`, watch: [() => props.mac] })

const apColor = computed(() => {
  const macs = [...new Set([...(data.value?.apDwell.map(a => a.apMac) ?? []), ...(data.value?.signal.map(s => s.apMac).filter((m): m is string => !!m) ?? [])])]
  return new Map(macs.map((m, i) => [m, identityPalette[i % identityPalette.length]!]))
})
const totalDwell = computed(() => (data.value?.apDwell ?? []).reduce((s, a) => s + a.minutes, 0) || 1)
const chart = computed<EChartsOption>(() => {
  const pts = data.value?.signal ?? []
  // one series per AP so the line changes colour where the client roamed
  const byAp = new Map<string, [number, number | null][]>()
  let last: string | null = null
  for (const p of pts) {
    const ap = p.apMac ?? 'none'
    if (!byAp.has(ap)) byAp.set(ap, [])
    if (last && last !== ap) byAp.get(last)!.push([p.ts, null])
    byAp.get(ap)!.push([p.ts, p.dbm])
    last = ap
  }
  return {
    grid: { top: 8, bottom: 4 },
    tooltip: { valueFormatter: (v: unknown) => (v == null ? '—' : `${v} dBm`) },
    xAxis: { type: 'time', min: window_.value.from, max: Date.now() },
    yAxis: { type: 'value', min: -95, max: -30, axisLabel: { formatter: '{value}' } },
    series: [...byAp.entries()].map(([ap, d]) => ({
      type: 'line', name: data.value?.apDwell.find(a => a.apMac === ap)?.apName ?? ap, showSymbol: false, connectNulls: false,
      lineStyle: { width: 1.6, color: apColor.value.get(ap) }, itemStyle: { color: apColor.value.get(ap) }, data: d,
      markLine: ap === [...byAp.keys()][0] ? { silent: true, symbol: 'none', lineStyle: { color: 'rgba(245,165,36,.6)', type: 'dashed' }, label: { show: false }, data: [{ yAxis: -75 }] } : undefined,
    })),
  }
})
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-2">
      <h3 class="text-[13px] font-semibold text-highlighted flex items-center gap-1.5"><UIcon name="i-lucide-route" class="size-4 text-dimmed" />{{ t('roaming.title') }}</h3>
      <UBadge v-if="sticky && sticky.status !== 'recovered'" color="warning" variant="soft" size="sm" icon="i-lucide-magnet">{{ t(`roaming.sticky.${sticky.status}`) }}</UBadge>
    </div>
    <UAlert v-if="sticky && sticky.status !== 'recovered'" color="warning" variant="subtle" icon="i-lucide-magnet" class="mb-3" :title="t('roaming.stickyTitle', { ap: sticky.apName, dbm: sticky.signal })" :description="t('roaming.stickyDesc', { n: sticky.otherAps, nudges: sticky.nudges24h })" />
    <p v-if="error" class="text-[12.5px] text-dimmed">{{ t('roaming.unavailable') }}</p>
    <USkeleton v-else-if="status === 'pending' && !data" class="h-32" />
    <template v-else-if="data">
      <UfChart v-if="data.signal.length > 1" :option="chart" height="130px" />
      <div v-if="data.apDwell.length" class="flex h-2 rounded-full overflow-hidden my-3">
        <UTooltip v-for="a in data.apDwell" :key="a.apMac" :text="`${a.apName} · ${fmt.minutes(a.minutes)}`">
          <span class="h-full" :style="{ width: `${(a.minutes / totalDwell) * 100}%`, background: apColor.get(a.apMac) }" />
        </UTooltip>
      </div>
      <div v-if="data.apDwell.length" class="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted mb-3">
        <span v-for="a in data.apDwell" :key="a.apMac" class="flex items-center gap-1.5"><span class="size-2 rounded-full" :style="{ background: apColor.get(a.apMac) }" />{{ a.apName }} <span class="text-dimmed uf-num">{{ fmt.minutes(a.minutes) }}</span></span>
      </div>
      <div v-if="data.events.length" class="space-y-1.5">
        <div v-for="(e, i) in [...data.events].reverse().slice(0, 8)" :key="i" class="flex items-center gap-2 text-[12px]">
          <span class="uf-num text-dimmed w-11 shrink-0">{{ fmt.time(e.ts) }}</span>
          <span class="truncate text-toned">{{ e.fromApName ?? '—' }}</span>
          <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed shrink-0" />
          <span class="truncate text-highlighted font-medium">{{ e.toApName ?? '—' }}</span>
          <span v-if="e.toSignal != null" class="ml-auto uf-num shrink-0" :class="e.toSignal < -75 ? 'text-warning' : 'text-dimmed'">{{ e.fromSignal ?? '?' }} → {{ e.toSignal }} dBm</span>
          <UBadge v-if="e.band" size="xs" variant="soft" color="neutral" class="shrink-0">{{ e.band }}G</UBadge>
        </div>
      </div>
      <p v-else class="text-[12.5px] text-dimmed">{{ t('roaming.noRoams') }}</p>
    </template>
  </div>
</template>
