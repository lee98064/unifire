<script setup lang="ts">
import type { InfraDeviceT } from '#shared/schemas/infra'
import { speedColor, speedLabel, speedTier, uptimeShort } from '~/utils/devices'

const props = defineProps<{ device: InfraDeviceT, thresholds: { temp: number, cpu: number, mem: number } }>()
const { t, te } = useI18n()
const fmt = useFormat()
const d = computed(() => props.device)
const offline = computed(() => d.value.state === 'offline')
const issues = computed(() => d.value.issues.filter(i => i.severity !== 'info'))
const issueText = (k: string, p: Record<string, string>) => (te(k) ? t(k, p) : k)
const throughput = computed(() => (d.value.rxBps ?? 0) + (d.value.txBps ?? 0))
const uplinkTier = computed(() => speedTier(d.value.uplink?.speedMbps))
</script>

<template>
  <NuxtLink
    :to="`/devices/${encodeURIComponent(d.mac)}`"
    class="uf-card uf-card-hover group flex flex-col p-4 gap-3.5 min-w-0 focus-visible:outline-2 focus-visible:outline-primary"
    :class="offline ? 'ring-1 ring-error/30' : ''"
  >
    <div class="flex items-start gap-3 min-w-0">
      <DeviceGlyph :type="d.type" :model="d.model" :state="d.state" :size="46" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-[14px] font-semibold text-highlighted truncate">{{ d.name }}</span>
          <UIcon v-if="d.locating" name="i-lucide-locate-fixed" class="size-3.5 text-primary animate-pulse shrink-0" />
        </div>
        <div class="text-[12px] text-dimmed truncate">{{ d.modelName ?? d.model ?? t(`devices.type.${d.type}`) }}<template v-if="d.ip"> · <span class="uf-mono">{{ d.ip }}</span></template></div>
      </div>
      <UBadge :color="offline ? 'error' : d.state === 'online' ? 'success' : 'warning'" variant="subtle" size="sm" class="shrink-0">
        {{ t(`devices.state.${d.state}`) }}
      </UBadge>
    </div>

    <div class="grid grid-cols-3 gap-3">
      <MiniMeter :label="t('devices.cpu')" :value="d.cpuPct" :warn="thresholds.cpu * 0.8" :crit="thresholds.cpu" />
      <MiniMeter :label="t('devices.mem')" :value="d.memPct" :warn="thresholds.mem * 0.9" :crit="thresholds.mem" />
      <MiniMeter :label="t('devices.temp')" :value="d.tempC" unit="°" :warn="thresholds.temp - 10" :crit="thresholds.temp" />
    </div>

    <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
      <div class="flex items-center gap-1.5 text-toned min-w-0">
        <UIcon name="i-lucide-timer" class="size-3.5 text-dimmed shrink-0" />
        <span class="uf-num truncate">{{ offline ? t('devices.offlineSince', { ago: fmt.ago(d.lastSeen) }) : uptimeShort(d.uptimeSec, t) }}</span>
      </div>
      <div class="flex items-center gap-1.5 text-toned">
        <UIcon name="i-lucide-monitor-smartphone" class="size-3.5 text-dimmed shrink-0" />
        <span class="uf-num">{{ d.clients ?? '—' }}</span>
      </div>
      <div v-if="d.poe" class="flex items-center gap-1.5 text-toned">
        <UIcon name="i-lucide-zap" class="size-3.5 text-warning shrink-0" />
        <span class="uf-num">{{ d.poe.usedW != null ? d.poe.usedW.toFixed(1) : '—' }}<span class="text-dimmed"> / {{ d.poe.budgetW ?? '—' }} W</span></span>
      </div>
      <div v-else-if="d.bands.length" class="flex items-center gap-1.5 text-toned">
        <UIcon name="i-lucide-radio" class="size-3.5 text-dimmed shrink-0" />
        <span class="uf-num">{{ d.bands.map(b => `${b}G`).join(' · ') }}</span>
      </div>
      <div class="flex items-center gap-1.5 text-toned min-w-0">
        <UIcon name="i-lucide-arrow-down-up" class="size-3.5 text-dimmed shrink-0" />
        <span class="uf-num truncate">{{ fmt.bps(throughput) }}</span>
      </div>
    </div>

    <div v-if="d.uplink && d.type !== 'gateway'" class="flex items-center gap-1.5 text-[12px] text-muted min-w-0">
      <UIcon :name="d.uplink.type === 'wireless' ? 'i-lucide-wifi' : 'i-lucide-corner-down-right'" class="size-3.5 text-dimmed shrink-0" />
      <span class="truncate">
        {{ d.uplink.name ?? t('devices.unknownUplink') }}<template v-if="d.uplink.remotePort"> · #{{ d.uplink.remotePort }}</template>
      </span>
      <span
        v-if="d.uplink.type === 'wireless'"
        class="ml-auto shrink-0 uf-num text-[11px] px-1.5 rounded bg-vpn/10 text-vpn"
      >{{ d.uplink.signal != null ? `${d.uplink.signal} dBm` : t('devices.mesh') }}</span>
      <span
        v-else-if="d.uplink.speedMbps"
        class="ml-auto shrink-0 uf-num text-[11px] font-medium px-1.5 rounded"
        :style="{ color: speedColor[uplinkTier], background: `color-mix(in oklab, ${speedColor[uplinkTier]} 14%, transparent)` }"
      >{{ speedLabel(d.uplink.speedMbps) }}</span>
    </div>

    <div class="mt-auto pt-3 border-t border-(--ui-border-muted) flex items-center gap-2 text-[11.5px] min-w-0">
      <span class="text-dimmed shrink-0">{{ t('devices.firmware') }}</span>
      <span class="uf-mono text-toned truncate">{{ d.firmware ?? '—' }}</span>
      <UBadge v-if="d.upgradeTo" color="primary" variant="soft" size="xs" icon="i-lucide-arrow-up-circle" class="shrink-0">{{ d.upgradeTo }}</UBadge>
      <span class="ml-auto shrink-0 flex items-center gap-1.5" :title="t('devices.availability')">
        <span class="w-10 h-1 rounded-full bg-(--ui-bg-accented) overflow-hidden">
          <span v-if="d.availability24h != null" class="block h-full rounded-full" :class="(d.availability24h ?? 1) >= 0.999 ? 'bg-success' : (d.availability24h ?? 1) >= 0.98 ? 'bg-warning' : 'bg-error'" :style="{ width: `${Math.max(4, (d.availability24h ?? 0) * 100)}%` }" />
        </span>
        <span class="uf-num text-dimmed">{{ d.availability24h == null ? '—' : fmt.pct(d.availability24h * 100, d.availability24h < 1 ? 1 : 0) }}</span>
      </span>
    </div>

    <div v-if="issues.length" class="flex flex-wrap gap-1.5 -mt-1">
      <UBadge
        v-for="(i, k) in issues.slice(0, 3)"
        :key="k"
        :color="i.severity === 'error' ? 'error' : 'warning'"
        variant="soft"
        size="sm"
        :icon="i.severity === 'error' ? 'i-lucide-circle-alert' : 'i-lucide-triangle-alert'"
        class="max-w-full"
      ><span class="truncate">{{ issueText(i.messageKey, i.messageParams) }}</span></UBadge>
    </div>
  </NuxtLink>
</template>
