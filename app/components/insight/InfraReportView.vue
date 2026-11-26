<script setup lang="ts">
import type { InfraReportT } from '#shared/schemas/infra'
import { deviceTypeIcon } from '~/utils/devices'

/** Monthly infrastructure report: per-device availability, reboots, load; incident stats. Printable. */
const props = defineProps<{ months: string[] }>()
const { t, te } = useI18n()
const fmt = useFormat()
const month = ref(props.months[0]!)
const { data: report, status, error } = useFetch<InfraReportT>('/api/reports/infra', { query: { month }, key: 'report-infra' })
const title = (k: string, p: Record<string, string>) => (te(k) ? t(k, p) : k)
const availClass = (a: number | null) => (a == null ? 'text-dimmed' : a >= 0.999 ? 'text-success' : a >= 0.99 ? 'text-highlighted' : 'text-warning')
const sorted = computed(() => [...(report.value?.devices ?? [])].sort((a, b) => (a.availability ?? 1) - (b.availability ?? 1)))
const maxRoot = computed(() => Math.max(1, ...(report.value?.incidents.byRoot.map(r => r.count) ?? [1])))
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3 uf-no-print">
      <USelect v-model="month" :items="months" class="w-36" size="sm" />
      <span v-if="report && report.coverage < 0.98" class="text-[12px] text-warning flex items-center gap-1"><UIcon name="i-lucide-info" class="size-3.5" />{{ t('reports.infra.coverage', { pct: Math.round(report.coverage * 100) }) }}</span>
    </div>
    <div v-if="error && !report" class="uf-card"><EmptyState icon="i-lucide-server" :title="t('reports.infra.unavailable')" :description="t('reports.infra.unavailableDesc')" /></div>
    <USkeleton v-else-if="status === 'pending' && !report" class="h-72 rounded-xl" />
    <template v-else-if="report">
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile :label="t('reports.infra.incidents')" :value="report.incidents.count" icon="i-lucide-siren" :tone="report.incidents.critical ? 'error' : report.incidents.count ? 'warning' : 'success'" :hint="t('reports.infra.criticalN', { n: report.incidents.critical })" />
        <KpiTile :label="t('reports.infra.mttr')" :value="report.incidents.mttrSec == null ? '—' : fmt.duration(report.incidents.mttrSec * 1000)" icon="i-lucide-timer-reset" tone="neutral" :hint="t('reports.infra.mttrHint')" />
        <KpiTile :label="t('reports.infra.downtime')" :value="fmt.duration(report.incidents.totalSec * 1000)" icon="i-lucide-clock-alert" tone="warning" />
        <KpiTile :label="t('reports.infra.energy')" :value="report.energyWh == null ? '—' : `${(report.energyWh / 1000).toFixed(1)} kWh`" icon="i-lucide-zap" tone="warning" to="/devices/poe?tab=energy" />
      </div>

      <UCard :ui="{ body: 'p-0 sm:p-0' }">
        <template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.infra.devices') }}</h3></template>
        <div class="overflow-x-auto">
          <table class="w-full text-[12.5px]">
            <thead class="text-left text-[11.5px] text-dimmed border-b border-(--ui-border-muted)">
              <tr>
                <th class="px-5 py-2.5 font-medium">{{ t('devices.col.device') }}</th>
                <th class="px-3 py-2.5 font-medium text-right">{{ t('reports.infra.availability') }}</th>
                <th class="px-3 py-2.5 font-medium text-right">{{ t('reports.infra.outages') }}</th>
                <th class="px-3 py-2.5 font-medium text-right">{{ t('reports.infra.reboots') }}</th>
                <th class="px-3 py-2.5 font-medium text-right">{{ t('reports.infra.load') }}</th>
                <th class="px-3 py-2.5 font-medium text-right">{{ t('reports.infra.tempMax') }}</th>
                <th class="px-3 py-2.5 font-medium text-right">{{ t('reports.infra.portEvents') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in sorted" :key="d.mac" class="border-b border-(--ui-border-muted) last:border-0">
                <td class="px-5 py-2.5">
                  <NuxtLink :to="`/devices/${encodeURIComponent(d.mac)}`" class="flex items-center gap-2 hover:text-primary">
                    <UIcon :name="deviceTypeIcon[d.type]" class="size-4 text-dimmed" />
                    <span class="text-highlighted font-medium">{{ d.name }}</span>
                    <span class="text-dimmed text-[11px]">{{ d.model }}</span>
                  </NuxtLink>
                </td>
                <td class="px-3 py-2.5 text-right uf-num font-semibold" :class="availClass(d.availability)">{{ d.availability == null ? '—' : `${(d.availability * 100).toFixed(d.availability < 1 ? 3 : 0)}%` }}</td>
                <td class="px-3 py-2.5 text-right uf-num text-toned">{{ d.outages }}<span v-if="d.downtimeSec" class="text-dimmed text-[11px]"> · {{ fmt.duration(d.downtimeSec * 1000) }}</span></td>
                <td class="px-3 py-2.5 text-right uf-num" :class="d.unexpectedReboots ? 'text-error font-medium' : 'text-toned'">{{ d.unexpectedReboots }}</td>
                <td class="px-3 py-2.5 text-right uf-num text-toned">{{ d.cpuAvg == null ? '—' : `${Math.round(d.cpuAvg)}%` }} / {{ d.memAvg == null ? '—' : `${Math.round(d.memAvg)}%` }}</td>
                <td class="px-3 py-2.5 text-right uf-num text-toned">{{ d.tempMax == null ? '—' : `${Math.round(d.tempMax)}°` }}</td>
                <td class="px-3 py-2.5 text-right uf-num" :class="d.portEvents ? 'text-warning' : 'text-toned'">{{ d.portEvents }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UCard>

      <div class="grid lg:grid-cols-2 gap-4">
        <UCard>
          <template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.infra.byRoot') }}</h3></template>
          <div v-if="report.incidents.byRoot.length" class="space-y-2.5">
            <div v-for="r in report.incidents.byRoot" :key="r.kind" class="grid grid-cols-[130px_1fr_32px] items-center gap-3 text-[12.5px]">
              <span class="text-toned truncate">{{ t(`incidents.kind.${r.kind}`) }}</span>
              <div class="h-2 rounded-full bg-(--ui-bg-accented) overflow-hidden"><div class="h-full rounded-full bg-error/70" :style="{ width: `${(r.count / maxRoot) * 100}%` }" /></div>
              <span class="text-right uf-num text-highlighted">{{ r.count }}</span>
            </div>
          </div>
          <p v-else class="text-[12.5px] text-success flex items-center gap-1.5"><UIcon name="i-lucide-shield-check" class="size-4" />{{ t('reports.infra.noIncidents') }}</p>
        </UCard>
        <UCard>
          <template #header><h3 class="text-[13px] font-semibold text-highlighted">{{ t('reports.infra.longest') }}</h3></template>
          <div v-if="report.incidents.longest.length" class="divide-y divide-(--ui-border-muted) -my-2">
            <NuxtLink v-for="i in report.incidents.longest" :key="i.id" :to="`/insight/incidents/${i.id}`" class="flex items-center gap-3 py-2.5 hover:text-primary">
              <span class="size-2 rounded-full shrink-0" :class="i.severity === 'critical' ? 'bg-error' : 'bg-warning'" />
              <div class="min-w-0 flex-1"><div class="text-[12.5px] text-highlighted truncate">{{ title(i.titleKey, i.titleParams) }}</div><div class="text-[11px] text-dimmed uf-num">{{ fmt.dateTime(i.openedAt) }}</div></div>
              <span class="text-[12px] uf-num text-error">{{ fmt.duration((i.resolvedAt ?? Date.now()) - i.openedAt) }}</span>
            </NuxtLink>
          </div>
          <p v-else class="text-[12.5px] text-dimmed">{{ t('reports.infra.noIncidents') }}</p>
        </UCard>
      </div>
    </template>
  </div>
</template>
