<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { DeviceEventsT, DeviceSeriesT, InfraDeviceDetailT, InfraDeviceT, PortViewT, RoomT, SeriesRangeT } from '#shared/schemas/infra'
import type { SettingsT } from '#shared/schemas/system'
import { portName, speedColor, speedLabel, speedTier, uptimeShort } from '~/utils/devices'

const route = useRoute()
const { t, te } = useI18n()
const fmt = useFormat()
const api = useApi()
const confirm = useConfirm()
const mac = computed(() => String(route.params.mac).toLowerCase())

const { data: dev, status, error, refresh } = useFetch<InfraDeviceDetailT>(() => `/api/devices/${encodeURIComponent(mac.value)}`, { key: 'device-detail' })
const { data: settings } = useFetch<SettingsT>('/api/settings', { key: 'settings', dedupe: 'defer' })
const range = ref<SeriesRangeT>('24h')
const { data: series, status: seriesStatus } = useFetch<DeviceSeriesT>(() => `/api/devices/${encodeURIComponent(mac.value)}/series`, { key: 'device-series', query: { range } })
const eventsWindow = { from: Date.now() - 30 * 86_400_000, to: Date.now() + 86_400_000 }
const { data: events } = useFetch<DeviceEventsT>(() => `/api/devices/${encodeURIComponent(mac.value)}/events`, { key: 'device-events', query: eventsWindow })
useIntervalFn(() => refresh(), 60_000)

useHead(() => ({ title: dev.value?.name ?? t('nav.devices') }))

const thresholds = computed(() => ({
  temp: settings.value?.infra?.tempWarnC ?? 80,
  cpu: settings.value?.infra?.cpuWarnPct ?? 90,
  mem: settings.value?.infra?.memWarnPct ?? 90,
}))
const offline = computed(() => dev.value?.state === 'offline')
const issueText = (k: string, p: Record<string, string>) => (te(k) ? t(k, p) : k)

/* ── room (APs) ── */
const { data: rooms } = useFetch<RoomT[]>('/api/rooms', { key: 'rooms', default: () => [], dedupe: 'defer' })
const roomItems = computed(() => [{ label: t('rooms.none'), value: '__none' }, ...rooms.value.map(r => ({ label: r.floor ? `${r.name} · ${r.floor}` : r.name, value: r.id, icon: `i-lucide-${r.icon ?? 'house'}` }))])
async function setRoom(v: string) {
  await api.patch<InfraDeviceT>(`/api/devices/${encodeURIComponent(mac.value)}`, { roomId: v === '__none' ? null : v }, { success: t('common.saved') })
  await refresh()
  refreshNuxtData(['rooms', 'devices'])
}

/* ── tabs ── */
const tabs = computed(() => {
  const d = dev.value
  const items = [{ value: 'overview', label: t('devices.tab.overview'), icon: 'i-lucide-activity' }]
  if (d?.ports.length) items.push({ value: 'ports', label: t('devices.tab.ports'), icon: 'i-lucide-ethernet-port' })
  if (d?.radios.length) items.push({ value: 'wireless', label: t('devices.tab.wireless'), icon: 'i-lucide-wifi' })
  items.push({ value: 'events', label: t('devices.tab.events'), icon: 'i-lucide-list-tree' })
  if (d?.poe) items.push({ value: 'energy', label: t('devices.tab.energy'), icon: 'i-lucide-zap' })
  return items
})
const tab = computed({
  get: () => (tabs.value.some(x => x.value === route.query.tab) ? String(route.query.tab) : 'overview'),
  set: v => navigateTo({ query: { ...route.query, tab: v === 'overview' ? undefined : v } }, { replace: true }),
})

/* ── actions ── */
const locating = ref(false)
async function toggleLocate() {
  if (!dev.value) return
  locating.value = true
  try {
    const on = !dev.value.locating
    await api.post<InfraDeviceT>(`/api/devices/${encodeURIComponent(mac.value)}/locate`, { on, minutes: 5 }, { success: on ? t('devices.locateStarted', { name: dev.value.name, n: 5 }) : t('devices.locateStopped') })
    await refresh()
  }
  finally { locating.value = false }
}
const restarting = ref(false)
async function restart() {
  const d = dev.value
  if (!d) return
  const gateway = d.type === 'gateway'
  const ok = await confirm({
    title: t('devices.restartTitle', { name: d.name }),
    description: gateway ? t('devices.restartGatewayDesc') : t('devices.restartDesc', { n: d.clients ?? 0, down: d.downstream.length }),
    confirmLabel: t('devices.restart'),
    color: gateway ? 'error' : 'warning',
    icon: 'i-lucide-rotate-cw',
  })
  if (!ok) return
  if (gateway && !(await confirm({ title: t('devices.restartGatewayAgain'), description: t('devices.restartGatewayAgainDesc'), confirmLabel: t('devices.restartGatewayConfirm'), color: 'error', icon: 'i-lucide-triangle-alert' }))) return
  restarting.value = true
  try {
    await api.post(`/api/devices/${encodeURIComponent(mac.value)}/restart`, { confirmGateway: gateway }, { success: t('devices.restartSent') })
    await refresh()
  }
  finally { restarting.value = false }
}

/* ── charts ── */
const rangeMs: Record<SeriesRangeT, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 }
const xAxis = computed(() => ({ type: 'time' as const, min: Date.now() - rangeMs[range.value], max: Date.now() }))
const few = computed(() => (series.value?.points.length ?? 0) < 3)
const onlineAreas = computed(() => {
  const pts = series.value?.points ?? []
  const bucket = (series.value?.bucketSec ?? 300) * 1000
  return pts.filter(p => p.online != null && p.online < 0.999).map(p => [{ xAxis: p.ts }, { xAxis: p.ts + bucket }])
})
const loadChart = computed<EChartsOption>(() => {
  const pts = series.value?.points ?? []
  return {
    legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 4, textStyle: { fontSize: 11 } },
    grid: { top: 28 },
    tooltip: { valueFormatter: (v: unknown) => (v == null ? '—' : `${Math.round(Number(v))}`) },
    xAxis: xAxis.value,
    yAxis: [{ type: 'value', max: 100, axisLabel: { formatter: '{value}%' } }, { type: 'value', axisLabel: { formatter: '{value}°' }, splitLine: { show: false }, scale: true }],
    series: [
      { type: 'line', name: t('devices.cpu'), showSymbol: few.value, smooth: 0.25, lineStyle: { width: 1.6 }, data: pts.map(p => [p.ts, p.cpuPct]), markArea: { silent: true, itemStyle: { color: 'rgba(240,58,62,0.10)' }, data: onlineAreas.value as never } },
      { type: 'line', name: t('devices.mem'), showSymbol: few.value, smooth: 0.25, lineStyle: { width: 1.6 }, data: pts.map(p => [p.ts, p.memPct]) },
      { type: 'line', name: t('devices.temp'), yAxisIndex: 1, showSymbol: few.value, smooth: 0.25, lineStyle: { width: 1.4, type: 'dashed' }, data: pts.map(p => [p.ts, p.tempC]) },
    ],
    color: ['#006FFF', '#8E59FF', '#F5A524'],
  }
})
const trafficChart = computed<EChartsOption>(() => {
  const pts = series.value?.points ?? []
  return {
    legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 4, textStyle: { fontSize: 11 } },
    grid: { top: 28 },
    tooltip: { valueFormatter: (v: unknown) => (v == null ? '—' : String(v)) },
    xAxis: xAxis.value,
    yAxis: [{ type: 'value', axisLabel: { formatter: (v: number) => fmt.bps(v) } }, { type: 'value', splitLine: { show: false }, minInterval: 1 }],
    series: [
      { type: 'line', name: t('devices.chart.down'), showSymbol: few.value, smooth: 0.25, lineStyle: { width: 1.5 }, areaStyle: { opacity: 0.12 }, data: pts.map(p => [p.ts, p.rxBps]), tooltip: { valueFormatter: (v: unknown) => fmt.bps(Number(v)) } },
      { type: 'line', name: t('devices.chart.up'), showSymbol: few.value, smooth: 0.25, lineStyle: { width: 1.5 }, areaStyle: { opacity: 0.08 }, data: pts.map(p => [p.ts, p.txBps]), tooltip: { valueFormatter: (v: unknown) => fmt.bps(Number(v)) } },
      { type: 'line', name: t('devices.clients'), yAxisIndex: 1, step: 'end', showSymbol: few.value, lineStyle: { width: 1.2, type: 'dotted' }, data: pts.map(p => [p.ts, p.clients]) },
    ],
    color: ['#006FFF', '#8E59FF', '#38CC65'],
  }
})

/* ── ports ── */
const selectedPort = ref<number | null>(Number(route.query.port) || null)
const portDrawer = ref(false)
const port = computed<PortViewT | null>(() => dev.value?.ports.find(p => p.idx === selectedPort.value) ?? null)
const portsSorted = computed(() => [...(dev.value?.ports ?? [])].sort((a, b) => a.idx - b.idx))
const { get: person } = usePeople()

/* ── events timeline (merged) ── */
const timeline = computed(() => {
  const transitions = (events.value?.transitions ?? dev.value?.transitions ?? []).map(x => ({ ts: x.ts, kind: 'transition' as const, x }))
  const firmware = (events.value?.firmware ?? dev.value?.firmwareHistory ?? []).map(x => ({ ts: x.ts, kind: 'firmware' as const, x }))
  const ports = (events.value?.portEvents ?? dev.value?.portEvents ?? []).map(x => ({ ts: x.ts, kind: 'port' as const, x }))
  return [...transitions, ...firmware, ...ports].sort((a, b) => b.ts - a.ts).slice(0, 200)
})
const transitionIcon: Record<string, { icon: string, tone: string }> = {
  unexpected_reboot: { icon: 'i-lucide-rotate-ccw', tone: 'text-error bg-error/10' },
  unifire_restart: { icon: 'i-lucide-rotate-cw', tone: 'text-primary bg-primary/10' },
  upgrade: { icon: 'i-lucide-package-check', tone: 'text-vpn bg-vpn/10' },
  offline: { icon: 'i-lucide-server-off', tone: 'text-error bg-error/10' },
  online: { icon: 'i-lucide-server', tone: 'text-success bg-success/10' },
  state: { icon: 'i-lucide-circle-dot', tone: 'text-toned bg-(--uf-hover)' },
  adopted: { icon: 'i-lucide-badge-check', tone: 'text-success bg-success/10' },
}

const uplinkTier = computed(() => speedTier(dev.value?.uplink?.speedMbps))
const poePorts = computed(() => (dev.value?.ports ?? []).filter(p => p.poe?.capable).sort((a, b) => (b.poe?.powerW ?? 0) - (a.poe?.powerW ?? 0)))
const poeMax = computed(() => Math.max(1, ...poePorts.value.map(p => p.poe?.powerW ?? 0)))
</script>

<template>
  <div>
    <UButton to="/devices" color="neutral" variant="link" icon="i-lucide-arrow-left" class="-ml-2.5 mb-2" size="sm">{{ t('nav.devices') }}</UButton>

    <div v-if="error && !dev" class="uf-card">
      <EmptyState icon="i-lucide-server-off" :title="t('devices.notFound')" :description="t('devices.notFoundDesc')" />
    </div>
    <USkeleton v-else-if="!dev" class="h-40 rounded-xl" />

    <template v-else>
      <!-- header -->
      <div class="flex flex-col lg:flex-row lg:items-center gap-4 mb-5">
        <div class="flex items-center gap-4 min-w-0 flex-1">
          <DeviceGlyph :type="dev.type" :model="dev.model" :state="dev.state" :size="64" />
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h1 class="text-xl sm:text-[22px] font-semibold tracking-tight text-highlighted truncate">{{ dev.name }}</h1>
              <UBadge :color="offline ? 'error' : dev.state === 'online' ? 'success' : 'warning'" variant="subtle">{{ t(`devices.state.${dev.state}`) }}</UBadge>
              <UBadge v-if="dev.locating" color="primary" variant="soft" icon="i-lucide-locate-fixed" class="animate-pulse">{{ t('devices.locating') }}</UBadge>
            </div>
            <div class="text-[13px] text-muted mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>{{ dev.modelName ?? dev.model }}</span>
              <span class="text-dimmed">·</span>
              <span>{{ t(`devices.type.${dev.type}`) }}</span>
              <template v-if="dev.ip"><span class="text-dimmed">·</span><span class="uf-mono">{{ dev.ip }}</span></template>
              <span class="text-dimmed">·</span><MacText :value="dev.mac" copy />
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <USelectMenu v-if="dev.type === 'ap' && rooms.length" :model-value="dev.roomId ?? '__none'" :items="roomItems" value-key="value" icon="i-lucide-door-open" class="w-44" @update:model-value="setRoom" />
          <UButton :color="dev.locating ? 'primary' : 'neutral'" :variant="dev.locating ? 'soft' : 'outline'" icon="i-lucide-locate-fixed" :loading="locating" :disabled="offline" @click="toggleLocate">
            {{ dev.locating ? t('devices.stopLocate') : t('devices.locate') }}
          </UButton>
          <UButton color="neutral" variant="outline" icon="i-lucide-rotate-cw" :loading="restarting" :disabled="offline" @click="restart">{{ t('devices.restart') }}</UButton>
        </div>
      </div>

      <!-- issues -->
      <div v-if="dev.issues.length" class="flex flex-col gap-2 mb-4">
        <UAlert
          v-for="(i, k) in dev.issues"
          :key="k"
          :color="i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info'"
          variant="subtle"
          :icon="i.severity === 'error' ? 'i-lucide-circle-alert' : i.severity === 'warning' ? 'i-lucide-triangle-alert' : 'i-lucide-info'"
          :title="issueText(i.messageKey, i.messageParams)"
        />
      </div>

      <!-- KPIs -->
      <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
        <div class="uf-card p-3.5">
          <div class="uf-section-title">{{ offline ? t('devices.lastSeen') : t('devices.uptime') }}</div>
          <div class="mt-1 text-lg font-semibold text-highlighted uf-num">{{ offline ? fmt.ago(dev.lastSeen) : uptimeShort(dev.uptimeSec, t) }}</div>
          <div v-if="dev.lastReboot" class="text-[11.5px] mt-0.5" :class="dev.lastReboot.unexpected ? 'text-error' : 'text-dimmed'">
            {{ dev.lastReboot.unexpected ? t('devices.unexpectedReboot') : t('devices.lastReboot') }} <TimeAgo :ts="dev.lastReboot.ts" />
          </div>
        </div>
        <div class="uf-card p-3.5 space-y-2.5">
          <MiniMeter :label="t('devices.cpu')" :value="dev.cpuPct" :warn="thresholds.cpu * 0.8" :crit="thresholds.cpu" />
          <MiniMeter :label="t('devices.mem')" :value="dev.memPct" :warn="thresholds.mem * 0.9" :crit="thresholds.mem" />
        </div>
        <div class="uf-card p-3.5">
          <div class="uf-section-title">{{ t('devices.temp') }}</div>
          <div class="mt-1 text-lg font-semibold uf-num" :class="dev.tempC != null && dev.tempC >= thresholds.temp ? 'text-error' : 'text-highlighted'">{{ dev.tempC == null ? '—' : `${Math.round(dev.tempC)} °C` }}</div>
          <div class="text-[11.5px] text-dimmed mt-0.5">{{ t('devices.tempWarnAt', { n: thresholds.temp }) }}</div>
        </div>
        <div class="uf-card p-3.5">
          <div class="uf-section-title">{{ t('devices.clients') }}</div>
          <div class="mt-1 text-lg font-semibold text-highlighted uf-num">{{ dev.clients ?? '—' }}</div>
          <div class="text-[11.5px] text-dimmed mt-0.5 uf-num">↓ {{ fmt.bps(dev.rxBps) }} · ↑ {{ fmt.bps(dev.txBps) }}</div>
        </div>
        <div class="uf-card p-3.5">
          <div class="uf-section-title">{{ t('devices.availability') }}</div>
          <div class="mt-1 text-lg font-semibold text-highlighted uf-num">{{ dev.availability24h == null ? '—' : fmt.pct(dev.availability24h * 100, dev.availability24h < 1 ? 2 : 0) }}</div>
          <div class="text-[11.5px] text-dimmed mt-0.5">{{ dev.availability24h == null ? t('devices.noData') : t('devices.last24h') }}</div>
        </div>
        <div class="uf-card p-3.5">
          <div class="uf-section-title">{{ t('devices.firmware') }}</div>
          <div class="mt-1 text-[15px] font-semibold text-highlighted uf-mono truncate">{{ dev.firmware ?? '—' }}</div>
          <div class="text-[11.5px] mt-0.5" :class="dev.upgradeTo ? 'text-primary' : 'text-dimmed'">{{ dev.upgradeTo ? t('devices.upgradeTo', { v: dev.upgradeTo }) : t('devices.upToDate') }}</div>
        </div>
      </div>

      <UTabs v-model="tab" :items="tabs" :content="false" class="mb-4" />

      <!-- overview -->
      <div v-if="tab === 'overview'" class="grid xl:grid-cols-[1fr_340px] gap-4">
        <div class="space-y-4 min-w-0">
          <UCard>
            <template #header>
              <div class="flex items-center gap-2">
                <h2 class="text-sm font-semibold text-highlighted">{{ t('devices.chart.load') }}</h2>
                <UTabs v-model="range" :content="false" size="xs" class="ml-auto" :items="(['24h', '7d', '30d', '90d'] as const).map(v => ({ value: v, label: v }))" />
              </div>
            </template>
            <UfChart v-if="series || seriesStatus !== 'pending'" :option="loadChart" height="230px" />
            <USkeleton v-else class="h-[230px]" />
          </UCard>
          <UCard>
            <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('devices.chart.traffic') }}</h2></template>
            <UfChart v-if="series || seriesStatus !== 'pending'" :option="trafficChart" height="230px" />
            <USkeleton v-else class="h-[230px]" />
          </UCard>
        </div>

        <div class="space-y-4">
          <UCard>
            <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('devices.uplink') }}</h2></template>
            <div v-if="dev.type === 'gateway'" class="flex items-center gap-3 text-[13px]">
              <span class="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center"><UIcon name="i-lucide-globe" class="size-4.5" /></span>
              <div>
                <div class="font-medium text-highlighted">{{ t('devices.internet') }}</div>
                <NuxtLink to="/egresses" class="text-[12px] text-primary hover:underline">{{ t('devices.seeEgresses') }}</NuxtLink>
              </div>
            </div>
            <div v-else-if="dev.uplink" class="space-y-3">
              <NuxtLink v-if="dev.uplink.mac" :to="`/devices/${encodeURIComponent(dev.uplink.mac)}`" class="flex items-center gap-3 rounded-lg p-2 -m-2 hover:bg-(--uf-hover) transition">
                <span class="size-9 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) flex items-center justify-center">
                  <UIcon :name="dev.uplink.type === 'wireless' ? 'i-lucide-wifi' : 'i-lucide-ethernet-port'" class="size-4.5 text-toned" />
                </span>
                <div class="min-w-0">
                  <div class="text-[13px] font-medium text-highlighted truncate">{{ dev.uplink.name ?? dev.uplink.mac }}</div>
                  <div class="text-[12px] text-dimmed">{{ dev.uplink.remotePort ? t('ports.port', { n: dev.uplink.remotePort }) : t(dev.uplink.type === 'wireless' ? 'devices.mesh' : 'devices.wired') }}</div>
                </div>
                <UIcon name="i-lucide-chevron-right" class="size-4 text-dimmed ml-auto" />
              </NuxtLink>
              <div class="grid grid-cols-2 gap-2 text-[12px]">
                <div class="rounded-md bg-(--uf-surface-2) px-2.5 py-2">
                  <div class="text-dimmed">{{ t('devices.linkSpeed') }}</div>
                  <div class="font-semibold uf-num" :style="{ color: dev.uplink.type === 'wireless' ? undefined : speedColor[uplinkTier] }">
                    {{ dev.uplink.type === 'wireless' ? (dev.uplink.signal != null ? `${dev.uplink.signal} dBm` : '—') : speedLabel(dev.uplink.speedMbps) }}
                    <span v-if="dev.uplink.fullDuplex === false" class="text-warning text-[11px]">{{ t('ports.halfDuplex') }}</span>
                  </div>
                </div>
                <div class="rounded-md bg-(--uf-surface-2) px-2.5 py-2">
                  <div class="text-dimmed">{{ t('devices.linkTraffic') }}</div>
                  <div class="font-semibold uf-num text-toned">↓ {{ fmt.bps(dev.uplink.rxBps) }} ↑ {{ fmt.bps(dev.uplink.txBps) }}</div>
                </div>
              </div>
            </div>
            <p v-else class="text-[12.5px] text-dimmed">{{ t('devices.unknownUplink') }}</p>
          </UCard>

          <UCard v-if="dev.downstream.length">
            <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('devices.downstream') }}</h2></template>
            <div class="space-y-1 -m-1">
              <NuxtLink v-for="d in dev.downstream" :key="d.mac" :to="`/devices/${encodeURIComponent(d.mac)}`" class="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-(--uf-hover) transition text-[13px]">
                <UIcon :name="d.type === 'ap' ? 'i-lucide-wifi' : d.type === 'switch' ? 'i-lucide-ethernet-port' : 'i-lucide-box'" class="size-4 text-toned" />
                <span class="text-highlighted truncate">{{ d.name }}</span>
                <span v-if="d.viaPort" class="ml-auto text-[11.5px] text-dimmed uf-num">#{{ d.viaPort }}</span>
              </NuxtLink>
            </div>
          </UCard>

          <UCard v-if="dev.roams24h">
            <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('devices.roams') }}</h2></template>
            <div class="grid grid-cols-2 gap-2 text-center">
              <div class="rounded-md bg-(--uf-surface-2) py-2.5"><div class="text-lg font-semibold uf-num text-success">{{ dev.roams24h.in }}</div><div class="text-[11.5px] text-dimmed">{{ t('devices.roamsIn') }}</div></div>
              <div class="rounded-md bg-(--uf-surface-2) py-2.5"><div class="text-lg font-semibold uf-num text-toned">{{ dev.roams24h.out }}</div><div class="text-[11.5px] text-dimmed">{{ t('devices.roamsOut') }}</div></div>
            </div>
          </UCard>
        </div>
      </div>

      <!-- ports -->
      <div v-else-if="tab === 'ports'" class="space-y-4">
        <UCard>
          <SwitchFaceplate :ports="dev.ports" :selected="selectedPort" @select="i => (selectedPort = selectedPort === i ? null : i)" />
          <Transition enter-from-class="opacity-0 -translate-y-1" enter-active-class="transition duration-200">
            <div v-if="port" class="mt-4 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3.5 grid sm:grid-cols-4 gap-3 text-[12.5px]">
              <div>
                <div class="text-dimmed">{{ t('ports.port', { n: port.idx }) }}</div>
                <div class="font-semibold text-highlighted truncate">{{ portName(port) ?? '—' }}</div>
              </div>
              <div>
                <div class="text-dimmed">{{ t('ports.col.peer') }}</div>
                <div class="font-medium text-highlighted truncate flex items-center gap-1.5">
                  <PersonAvatar v-if="port.peer?.personId && person(port.peer.personId)" :avatar="person(port.peer.personId)!.avatar" :color="person(port.peer.personId)!.color" :size="16" />
                  {{ port.peer?.name ?? (port.up ? t('ports.unknownPeer') : '—') }}
                  <span v-if="(port.peer?.count ?? 0) > 1 && port.peer?.kind !== 'device'" class="text-dimmed">+{{ port.peer!.count - 1 }}</span>
                </div>
              </div>
              <div>
                <div class="text-dimmed">{{ t('ports.col.speed') }}</div>
                <div class="font-medium uf-num" :style="{ color: speedColor[speedTier(port.speedMbps, port.up)] }">
                  {{ port.up ? speedLabel(port.speedMbps) : t('ports.down') }}
                  <span v-if="port.maxSpeedMbps" class="text-dimmed font-normal"> / {{ speedLabel(port.maxSpeedMbps) }}</span>
                </div>
              </div>
              <div>
                <div class="text-dimmed">PoE</div>
                <div class="font-medium uf-num text-toned">{{ !port.poe?.capable ? '—' : port.poe.mode === 'off' ? t('ports.poeOff') : `${(port.poe.powerW ?? 0).toFixed(1)} W` }}</div>
              </div>
              <div class="sm:col-span-4 flex flex-wrap items-center gap-1.5">
                <UBadge v-for="i in port.issues" :key="i" color="warning" variant="soft" size="sm" icon="i-lucide-triangle-alert">{{ t(`ports.issue.${i}`) }}</UBadge>
                <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-chart-line" class="ml-auto" @click="portDrawer = true">{{ t('ports.viewHistory') }}</UButton>
              </div>
            </div>
          </Transition>
        </UCard>

        <UCard :ui="{ body: 'p-0 sm:p-0' }">
          <div class="overflow-x-auto">
            <table class="w-full text-[12.5px]">
              <thead class="text-left text-[11.5px] text-dimmed border-b border-(--ui-border-muted)">
                <tr>
                  <th class="px-4 py-2.5 font-medium w-12">#</th>
                  <th class="px-3 py-2.5 font-medium">{{ t('ports.col.peer') }}</th>
                  <th class="px-3 py-2.5 font-medium">{{ t('ports.col.speed') }}</th>
                  <th class="px-3 py-2.5 font-medium">PoE</th>
                  <th class="px-3 py-2.5 font-medium">{{ t('ports.col.traffic') }}</th>
                  <th class="px-3 py-2.5 font-medium">{{ t('ports.col.health') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in portsSorted"
                  :key="p.idx"
                  class="border-b border-(--ui-border-muted) last:border-0 cursor-pointer transition"
                  :class="selectedPort === p.idx ? 'bg-primary/5' : 'hover:bg-(--uf-hover)'"
                  @click="selectedPort = p.idx"
                >
                  <td class="px-4 py-2 uf-num text-toned">
                    <div class="flex items-center gap-1.5">{{ p.idx }}<UIcon v-if="p.isUplink" name="i-lucide-arrow-up" class="size-3 text-primary" /></div>
                  </td>
                  <td class="px-3 py-2 min-w-[180px]">
                    <div class="flex items-center gap-1.5 text-highlighted">
                      <PersonAvatar v-if="p.peer?.personId && person(p.peer.personId)" :avatar="person(p.peer.personId)!.avatar" :color="person(p.peer.personId)!.color" :size="16" />
                      <UIcon v-else-if="p.peer?.kind === 'device'" name="i-lucide-server" class="size-3.5 text-dimmed" />
                      <span class="truncate max-w-[220px]">{{ p.peer?.name ?? (p.up ? t('ports.unknownPeer') : '—') }}</span>
                      <span v-if="(p.peer?.count ?? 0) > 1 && p.peer?.kind !== 'device'" class="text-dimmed">+{{ p.peer!.count - 1 }}</span>
                    </div>
                    <div v-if="portName(p)" class="text-[11px] text-dimmed truncate max-w-[220px]">{{ portName(p) }}</div>
                  </td>
                  <td class="px-3 py-2 uf-num whitespace-nowrap">
                    <span v-if="!p.enabled" class="text-dimmed">{{ t('ports.disabled') }}</span>
                    <span v-else-if="!p.up" class="text-dimmed">{{ t('ports.down') }}</span>
                    <span v-else class="font-medium" :style="{ color: speedColor[speedTier(p.speedMbps)] }">{{ speedLabel(p.speedMbps) }}</span>
                    <span v-if="p.baselineSpeedMbps && p.up && (p.speedMbps ?? 0) < p.baselineSpeedMbps" class="text-warning text-[11px]"> ({{ t('ports.wasSpeed', { s: speedLabel(p.baselineSpeedMbps) }) }})</span>
                  </td>
                  <td class="px-3 py-2 uf-num whitespace-nowrap">
                    <span v-if="!p.poe?.capable" class="text-dimmed">—</span>
                    <span v-else-if="p.poe.mode === 'off'" class="text-dimmed flex items-center gap-1"><UIcon name="i-lucide-zap-off" class="size-3" />{{ t('ports.poeOffShort') }}</span>
                    <span v-else class="flex items-center gap-1" :class="(p.poe.powerW ?? 0) > 0 ? 'text-warning' : 'text-dimmed'"><UIcon name="i-lucide-zap" class="size-3" />{{ (p.poe.powerW ?? 0).toFixed(1) }} W</span>
                  </td>
                  <td class="px-3 py-2 uf-num text-toned whitespace-nowrap">{{ p.up ? `↓ ${fmt.bps(p.rxBps)} ↑ ${fmt.bps(p.txBps)}` : '—' }}</td>
                  <td class="px-3 py-2">
                    <div class="flex flex-wrap gap-1">
                      <UBadge v-for="i in p.issues" :key="i" color="warning" variant="soft" size="xs">{{ t(`ports.issue.${i}`) }}</UBadge>
                      <span v-if="!p.issues.length && p.up" class="text-success text-[11.5px] flex items-center gap-1"><UIcon name="i-lucide-check" class="size-3" />{{ t('ports.healthy') }}</span>
                      <span v-if="p.flaps1h" class="text-[11px] text-dimmed uf-num">{{ t('ports.flapsN', { n: p.flaps1h }) }}</span>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>
      </div>

      <PortDrawer v-model:open="portDrawer" :mac="dev.mac" :idx="selectedPort" :device-name="dev.name" />

      <!-- wireless -->
      <div v-else-if="tab === 'wireless'" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        <UCard v-for="r in dev.radios" :key="r.radio ?? r.band">
          <div class="flex items-center gap-3 mb-4">
            <span class="size-10 rounded-xl flex items-center justify-center font-semibold text-[13px] uf-num" :class="r.band === '2.4' ? 'bg-warning/10 text-warning' : r.band === '5' ? 'bg-primary/10 text-primary' : 'bg-vpn/10 text-vpn'">{{ r.band }}</span>
            <div>
              <div class="text-[14px] font-semibold text-highlighted">{{ t('devices.radio.band', { band: r.band }) }}</div>
              <div class="text-[12px] text-dimmed uf-num">{{ t('devices.radio.channel', { ch: r.channel ?? '—' }) }}<template v-if="r.widthMhz"> · {{ r.widthMhz }} MHz</template><template v-if="r.txPowerDbm != null"> · {{ r.txPowerDbm }} dBm</template></div>
            </div>
            <div class="ml-auto text-right">
              <div class="text-lg font-semibold uf-num text-highlighted">{{ r.clients ?? '—' }}</div>
              <div class="text-[11px] text-dimmed">{{ t('devices.clients') }}</div>
            </div>
          </div>
          <div class="space-y-3">
            <MiniMeter :label="t('devices.radio.utilization')" :value="r.utilizationPct" :warn="50" :crit="75" />
            <MiniMeter :label="t('devices.radio.interference')" :value="r.interferencePct" :warn="20" :crit="40" />
            <MiniMeter :label="t('devices.radio.retries')" :value="r.retriesPct" :warn="10" :crit="25" />
          </div>
        </UCard>
      </div>

      <!-- events -->
      <UCard v-else-if="tab === 'events'">
        <div v-if="!timeline.length"><EmptyState icon="i-lucide-list-tree" :title="t('devices.noEvents')" :description="t('devices.noEventsDesc')" /></div>
        <ol v-else class="relative ml-3 border-l border-(--ui-border-muted) space-y-4 py-1">
          <li v-for="(e, k) in timeline" :key="k" class="pl-5 relative">
            <template v-if="e.kind === 'transition'">
              <span class="absolute -left-3.5 top-0 size-7 rounded-full flex items-center justify-center ring-4 ring-(--uf-surface)" :class="transitionIcon[e.x.reason ?? 'state']?.tone">
                <UIcon :name="transitionIcon[e.x.reason ?? 'state']?.icon ?? 'i-lucide-circle-dot'" class="size-3.5" />
              </span>
              <div class="text-[13px] font-medium text-highlighted">{{ t(`devices.reason.${e.x.reason ?? 'state'}`) }}<span class="text-dimmed font-normal"> · {{ t(`devices.state.${e.x.to}`) }}</span></div>
              <div class="text-[12px] text-dimmed uf-num">{{ fmt.dateTime(e.ts) }}<template v-if="e.x.downSec"> · {{ t('devices.downFor', { d: fmt.duration(e.x.downSec * 1000) }) }}</template></div>
            </template>
            <template v-else-if="e.kind === 'firmware'">
              <span class="absolute -left-3.5 top-0 size-7 rounded-full flex items-center justify-center ring-4 ring-(--uf-surface) bg-vpn/10 text-vpn"><UIcon name="i-lucide-package" class="size-3.5" /></span>
              <div class="text-[13px] font-medium text-highlighted">{{ t('devices.firmwareChange') }} <span class="uf-mono text-[12px] text-toned">{{ e.x.from ?? '?' }} → {{ e.x.to }}</span></div>
              <div class="text-[12px] text-dimmed uf-num">{{ fmt.dateTime(e.ts) }}</div>
            </template>
            <template v-else>
              <span class="absolute -left-3.5 top-0 size-7 rounded-full flex items-center justify-center ring-4 ring-(--uf-surface)" :class="e.x.kind === 'recovered' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'"><UIcon name="i-lucide-cable" class="size-3.5" /></span>
              <div class="text-[13px] font-medium text-highlighted">{{ issueText(e.x.messageKey, e.x.messageParams) }}</div>
              <div class="text-[12px] text-dimmed uf-num">{{ fmt.dateTime(e.ts) }} · {{ t('ports.port', { n: e.x.portIdx }) }}</div>
            </template>
          </li>
        </ol>
      </UCard>

      <!-- energy -->
      <div v-else-if="tab === 'energy'" class="grid lg:grid-cols-[300px_1fr] gap-4">
        <div class="space-y-3">
          <div class="uf-card p-4">
            <div class="uf-section-title">{{ t('devices.energy.now') }}</div>
            <div class="mt-1 text-2xl font-semibold text-highlighted uf-num">{{ dev.poe?.usedW != null ? `${dev.poe.usedW.toFixed(1)} W` : '—' }}</div>
            <div v-if="dev.poe?.budgetW" class="mt-2">
              <div class="h-1.5 rounded-full bg-(--ui-bg-accented) overflow-hidden"><div class="h-full rounded-full bg-warning" :style="{ width: `${Math.min(100, ((dev.poe.usedW ?? 0) / dev.poe.budgetW) * 100)}%` }" /></div>
              <div class="text-[11.5px] text-dimmed mt-1">{{ t('devices.energy.budget', { w: dev.poe.budgetW }) }}</div>
            </div>
          </div>
          <div class="uf-card p-4 grid grid-cols-2 gap-3">
            <div><div class="uf-section-title">{{ t('devices.energy.today') }}</div><div class="mt-1 font-semibold uf-num text-highlighted">{{ dev.energy ? `${(dev.energy.todayWh / 1000).toFixed(2)} kWh` : '—' }}</div></div>
            <div><div class="uf-section-title">{{ t('devices.energy.month') }}</div><div class="mt-1 font-semibold uf-num text-highlighted">{{ dev.energy ? `${(dev.energy.monthWh / 1000).toFixed(1)} kWh` : '—' }}</div></div>
          </div>
          <UButton to="/devices/poe" color="neutral" variant="outline" block icon="i-lucide-calendar-clock">{{ t('devices.energy.manage') }}</UButton>
        </div>
        <UCard>
          <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('devices.energy.byPort') }}</h2></template>
          <div class="space-y-2">
            <div v-for="p in poePorts" :key="p.idx" class="grid grid-cols-[44px_1fr_80px] items-center gap-3 text-[12.5px]">
              <span class="uf-num text-dimmed">#{{ p.idx }}</span>
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 text-toned truncate">{{ p.peer?.name ?? p.name ?? '—' }}<UIcon v-if="p.poe?.mode === 'off'" name="i-lucide-zap-off" class="size-3 text-dimmed" /></div>
                <div class="h-1.5 mt-1 rounded-full bg-(--ui-bg-accented) overflow-hidden"><div class="h-full rounded-full bg-warning transition-[width] duration-700" :style="{ width: `${((p.poe?.powerW ?? 0) / poeMax) * 100}%` }" /></div>
              </div>
              <span class="text-right uf-num font-medium" :class="(p.poe?.powerW ?? 0) > 0 ? 'text-highlighted' : 'text-dimmed'">{{ (p.poe?.powerW ?? 0).toFixed(1) }} W</span>
            </div>
          </div>
        </UCard>
      </div>
    </template>
  </div>
</template>
