<script setup lang="ts">
import type { EgressT, EgressHistoryT } from '#shared/schemas/egress'
import { egressKindIcon, latencyColor } from '~/utils/egress'

const props = defineProps<{ egress: EgressT, big?: boolean }>()
defineEmits<{ open: [] }>()
const { t } = useI18n()
const fmt = useFormat()
const { data: hist } = useFetch<EgressHistoryT>(() => `/api/egresses/${props.egress.id}/history`, { query: { range: '1h' }, key: `eg-hist-1h-${props.egress.id}`, lazy: true })
const series = computed(() => hist.value?.samples.map(s => (s.status === 'down' ? null : s.latencyMs)) ?? [])
const kindLabel = computed(() => t(`egresses.kind.${props.egress.kind}`))
</script>

<template>
  <button type="button" class="uf-card uf-card-hover text-left w-full overflow-hidden group" @click="$emit('open')">
    <div class="h-1" :style="{ background: egress.color }" />
    <div class="p-4">
      <div class="flex items-start gap-3">
        <span class="size-9 rounded-lg flex items-center justify-center shrink-0" :style="{ background: `color-mix(in oklab, ${egress.color} 14%, transparent)`, color: egress.color }">
          <UIcon :name="egressKindIcon[egress.kind]" class="size-[18px]" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="text-[14px] font-semibold text-highlighted truncate">{{ egress.name }}</span>
            <UIcon v-if="!egress.enabled" name="i-lucide-pause" class="size-3.5 text-dimmed" />
          </div>
          <div class="text-[11.5px] text-dimmed">{{ kindLabel }}<template v-if="egress.wanGroup"> · {{ egress.wanGroup }}</template> · {{ t('egresses.routesN', { n: egress.routeCount }) }}</div>
        </div>
        <UBadge :color="egress.health.status === 'healthy' ? 'success' : egress.health.status === 'degraded' ? 'warning' : egress.health.status === 'down' ? 'error' : 'neutral'" variant="subtle" size="sm" class="gap-1.5">
          <StatusDot :status="egress.health.status" :size="6" pulse />{{ t(`health.${egress.health.status}`) }}
        </UBadge>
      </div>

      <div class="mt-4 flex items-end justify-between gap-3">
        <div>
          <div class="text-[26px] leading-none font-semibold tracking-tight uf-num" :style="{ color: egress.health.status === 'down' ? 'var(--color-ufred-500)' : 'var(--ui-text-highlighted)' }">
            {{ egress.health.status === 'down' ? '—' : (egress.health.latencyMs != null ? Math.round(egress.health.latencyMs) : '—') }}<span v-if="egress.health.status !== 'down' && egress.health.latencyMs != null" class="text-[13px] text-dimmed font-medium ml-0.5">ms</span>
          </div>
          <div class="mt-1 text-[11.5px] text-dimmed uf-num">
            {{ t('health.loss') }} {{ fmt.pct(egress.health.lossPct) }}<template v-if="egress.health.jitterMs != null"> · {{ t('health.jitter') }} {{ fmt.ms(egress.health.jitterMs) }}</template>
          </div>
        </div>
        <Sparkline :values="series" :width="120" :height="36" :color="latencyColor(egress.health.latencyMs)" />
      </div>

      <div class="mt-4 pt-3 border-t border-(--ui-border-muted) flex items-center gap-2 text-[12px]">
        <template v-if="egress.publicIp">
          <CountryFlag :code="egress.publicIp.country" :size="15" />
          <span class="uf-mono text-toned truncate">{{ egress.publicIp.ip }}</span>
          <UBadge v-if="egress.publicIp.changed" color="warning" variant="subtle" size="xs">{{ t('egresses.ipChanged') }}</UBadge>
          <span class="ml-auto text-dimmed"><TimeAgo :ts="egress.publicIp.checkedAt" /></span>
        </template>
        <template v-else>
          <UIcon name="i-lucide-radar" class="size-3.5 text-dimmed" />
          <span class="text-dimmed">{{ t('egresses.noIp') }}</span>
        </template>
        <UTooltip v-if="egress.probe.state !== 'ok'" :text="t(`egresses.probe.${egress.probe.state}`)">
          <UIcon name="i-lucide-radio-tower" class="size-3.5 ml-auto" :class="egress.probe.state === 'error' ? 'text-error' : 'text-dimmed'" />
        </UTooltip>
      </div>
    </div>
  </button>
</template>
