<script setup lang="ts">
import type { EgressT, EgressHistoryT, SweepStatusT } from '#shared/schemas/egress'
import type { EChartsOption } from 'echarts'
import { egressKindIcon, identityPalette } from '~/utils/egress'

const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const { egresses, wans, vpns, refresh } = useEgresses()
const { data: sweep, refresh: refreshSweep } = useFetch<SweepStatusT>('/api/egresses/sweep', { key: 'sweep' })
const live = useLive()
live.on('sweep', () => refreshSweep())

async function startSweep() {
  sweep.value = await api.post<SweepStatusT>('/api/egresses/sweep', {}, { success: t('egresses.sweepStarted') })
}

/* detail slideover */
const selectedId = ref<string | null>(null)
const selected = computed(() => egresses.value.find(e => e.id === selectedId.value) ?? null)
const range = ref<'24h' | '7d' | '30d'>('24h')
const { data: hist, status: histStatus, execute: loadHist } = useFetch<EgressHistoryT>(() => `/api/egresses/${selectedId.value}/history`, { query: { range }, immediate: false, watch: false })
watch([selectedId, range], () => { if (selectedId.value) loadHist() })

const chart = computed<EChartsOption>(() => {
  const e = selected.value
  const samples = hist.value?.samples ?? []
  return {
    tooltip: { valueFormatter: (v: unknown) => (v == null ? '—' : `${Math.round(Number(v))} ms`) },
    xAxis: { type: 'time' },
    yAxis: [{ type: 'value', name: 'ms', nameTextStyle: { fontSize: 10 } }, { type: 'value', max: 100, axisLabel: { formatter: '{value}%' }, splitLine: { show: false } }],
    series: [
      {
        type: 'line', name: t('health.latency'), showSymbol: false, smooth: 0.25, connectNulls: false,
        lineStyle: { width: 1.75, color: e?.color }, itemStyle: { color: e?.color },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${e?.color ?? '#006FFF'}55` }, { offset: 1, color: `${e?.color ?? '#006FFF'}00` }] } },
        data: samples.map(s => [s.ts, s.status === 'down' ? null : s.latencyMs]),
        markArea: { silent: true, itemStyle: { color: 'rgba(240,58,62,0.12)' }, data: (hist.value?.incidents ?? []).filter(i => i.status === 'down').map(i => [{ xAxis: i.start }, { xAxis: i.end ?? Date.now() }]) as never },
      },
      { type: 'bar', name: t('health.loss'), yAxisIndex: 1, barMaxWidth: 4, itemStyle: { color: 'rgba(245,165,36,0.55)' }, data: samples.filter(s => (s.lossPct ?? 0) > 0).map(s => [s.ts, s.lossPct]) },
    ],
  }
})

async function patch(body: { color?: string, probeEnabled?: boolean }) {
  if (!selected.value) return
  await api.patch<EgressT>(`/api/egresses/${selected.value.id}`, body, { success: t('common.saved') })
  await refresh()
}
const sweepPct = computed(() => sweep.value && sweep.value.total ? Math.round((sweep.value.done / sweep.value.total) * 100) : 0)
</script>

<template>
  <div>
    <PageHeader :title="t('nav.egresses')" :description="t('egresses.desc')" icon="i-lucide-globe">
      <template #actions>
        <UButton to="/settings?tab=probes" color="neutral" variant="outline" icon="i-lucide-radio-tower">{{ t('egresses.probeRoutes') }}</UButton>
        <UButton icon="i-lucide-radar" :loading="sweep?.running" @click="startSweep">{{ sweep?.running ? t('egresses.sweeping', { done: sweep.done, total: sweep.total }) : t('egresses.sweep') }}</UButton>
      </template>
    </PageHeader>

    <!-- Sweep progress -->
    <Transition enter-from-class="opacity-0 -translate-y-2" enter-active-class="transition duration-300">
      <div v-if="sweep?.running" class="uf-card p-4 mb-4">
        <div class="flex items-center gap-3 mb-2">
          <UIcon name="i-lucide-radar" class="size-4 text-primary animate-spin [animation-duration:2.5s]" />
          <span class="text-[13px] font-medium text-highlighted">{{ t('egresses.sweepRunning') }}</span>
          <EgressChip v-if="sweep.current" :id="sweep.current" size="xs" />
          <span class="ml-auto text-[12px] text-dimmed uf-num">{{ sweep.done }}/{{ sweep.total }}</span>
        </div>
        <UProgress :model-value="sweepPct" size="sm" />
      </div>
    </Transition>

    <h2 class="uf-section-title mb-2.5">{{ t('egresses.wans') }}</h2>
    <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4 mb-7">
      <EgressCard v-for="e in wans" :key="e.id" :egress="e" big @open="selectedId = e.id" />
    </div>

    <h2 class="uf-section-title mb-2.5">{{ t('egresses.vpns') }}</h2>
    <div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <EgressCard v-for="e in vpns" :key="e.id" :egress="e" @open="selectedId = e.id" />
    </div>
    <div v-if="!egresses.length" class="uf-card"><EmptyState icon="i-lucide-globe" :title="t('egresses.empty')" :description="t('egresses.emptyDesc')" /></div>

    <USlideover :open="!!selected" :title="selected?.name" :description="selected ? t(`egresses.kind.${selected.kind}`) : ''" :ui="{ content: 'sm:max-w-2xl' }" @update:open="v => { if (!v) selectedId = null }">
      <template #body>
        <div v-if="selected" class="space-y-6">
          <div class="grid grid-cols-3 gap-3">
            <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
              <div class="uf-section-title">{{ t('health.latency') }}</div>
              <div class="mt-1 text-xl font-semibold text-highlighted uf-num">{{ fmt.ms(selected.health.latencyMs) }}</div>
            </div>
            <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
              <div class="uf-section-title">{{ t('health.loss') }}</div>
              <div class="mt-1 text-xl font-semibold text-highlighted uf-num">{{ fmt.pct(selected.health.lossPct) }}</div>
            </div>
            <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
              <div class="uf-section-title">{{ t('egresses.status') }}</div>
              <div class="mt-1.5 flex items-center gap-1.5 text-[14px] font-semibold text-highlighted"><StatusDot :status="selected.health.status" />{{ t(`health.${selected.health.status}`) }}</div>
              <div class="text-[11px] text-dimmed mt-0.5">{{ t('egresses.since') }} <TimeAgo :ts="selected.health.since" /></div>
            </div>
          </div>

          <div>
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-[13px] font-semibold text-highlighted">{{ t('egresses.history') }}</h3>
              <UTabs v-model="range" :content="false" size="xs" :items="[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]" />
            </div>
            <div class="rounded-lg ring-1 ring-(--ui-border-muted) p-2">
              <UfChart v-if="histStatus !== 'pending' || hist" :option="chart" height="240px" />
              <USkeleton v-else class="h-[240px]" />
            </div>
          </div>

          <div v-if="hist?.incidents.length">
            <h3 class="text-[13px] font-semibold text-highlighted mb-2">{{ t('egresses.incidents') }}</h3>
            <div class="space-y-1.5">
              <div v-for="(i, k) in hist.incidents.slice(0, 8)" :key="k" class="flex items-center gap-2 text-[12.5px] px-3 py-2 rounded-md bg-(--uf-surface-2)">
                <StatusDot :status="i.status" />
                <span class="text-toned uf-num">{{ fmt.dateTime(i.start) }}</span>
                <span class="text-dimmed">→ {{ i.end ? fmt.time(i.end) : t('egresses.ongoing') }}</span>
                <span v-if="i.end" class="ml-auto text-dimmed uf-num">{{ fmt.duration(i.end - i.start) }}</span>
              </div>
            </div>
          </div>

          <div>
            <h3 class="text-[13px] font-semibold text-highlighted mb-2">{{ t('egresses.publicIps') }}</h3>
            <div v-if="hist?.ipChecks.length" class="divide-y divide-(--ui-border-muted) rounded-lg ring-1 ring-(--ui-border-muted)">
              <div v-for="(c, k) in hist.ipChecks.slice(0, 6)" :key="k" class="flex items-center gap-2 px-3 py-2 text-[12.5px]">
                <CountryFlag :code="c.country" />
                <span class="uf-mono text-highlighted">{{ c.ip }}</span>
                <span v-if="c.colo" class="text-dimmed">· {{ c.colo }}</span>
                <UBadge v-if="c.changed" color="warning" variant="subtle" size="xs">{{ t('egresses.ipChanged') }}</UBadge>
                <span class="ml-auto text-dimmed">{{ fmt.dateTime(c.checkedAt) }}</span>
              </div>
            </div>
            <p v-else class="text-[12.5px] text-dimmed">{{ t('egresses.noIp') }}</p>
          </div>

          <div class="space-y-4 pt-2 border-t border-(--ui-border-muted)">
            <div>
              <div class="text-[13px] font-medium text-highlighted mb-2">{{ t('egresses.color') }}</div>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="c in identityPalette"
                  :key="c"
                  type="button"
                  class="size-7 rounded-full ring-2 ring-offset-2 ring-offset-(--uf-surface) transition"
                  :class="selected.color.toLowerCase() === c.toLowerCase() ? '' : 'ring-transparent hover:scale-110'"
                  :style="{ background: c, '--tw-ring-color': c }"
                  :aria-label="c"
                  @click="patch({ color: c })"
                />
              </div>
            </div>
            <div class="flex items-center justify-between gap-4">
              <div>
                <div class="text-[13px] font-medium text-highlighted">{{ t('egresses.probeEnable') }}</div>
                <div class="text-[12px] text-muted">{{ t('egresses.probeEnableHint') }}</div>
                <div v-if="selected.probe.ip" class="text-[11.5px] text-dimmed mt-1 flex items-center gap-1.5"><UIcon name="i-lucide-crosshair" class="size-3" />{{ t('egresses.probeTarget') }} <span class="uf-mono">{{ selected.probe.ip }}</span> · {{ t(`egresses.probe.${selected.probe.state}`) }}</div>
              </div>
              <USwitch :model-value="selected.probe.enabled" @update:model-value="patch({ probeEnabled: $event })" />
            </div>
            <div class="flex items-center gap-2 text-[11.5px] text-dimmed">
              <UIcon :name="egressKindIcon[selected.kind]" class="size-3.5" />UniFi ID <MacText :value="selected.id" copy />
            </div>
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>
