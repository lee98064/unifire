<script setup lang="ts">
import { VueFlow, useVueFlow, type Edge, type Node } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import '@vue-flow/core/dist/style.css'
import type { TopologyT, TopologyNodeT } from '#shared/schemas/infra'
import { layoutTopology, type Overlay } from '~/utils/topology'
import { speedColor } from '~/utils/devices'

const { t, te } = useI18n()
const fmt = useFormat()
const { data: topo, status, error, refresh } = useFetch<TopologyT>('/api/topology', { key: 'topology' })
const { byId: egressById } = useEgresses()
const { get: person } = usePeople()
const { get: device } = useDevices()
useIntervalFn(() => refresh(), 30_000)

const overlay = useLocalStorage<Overlay>('uf-topology-overlay', 'traffic')
const showVpn = useLocalStorage('uf-topology-vpn', false)
/** VPN client egresses are logical tunnels — hidden by default to keep the physical tree readable. */
const isVpn = (n: TopologyNodeT) => n.kind === 'egress' && !!n.egressId && egressById.value.get(n.egressId)?.kind !== 'wan'
const visibleNodes = computed(() => (topo.value?.nodes ?? []).filter(n => showVpn.value || !isVpn(n)))
const visibleIds = computed(() => new Set(visibleNodes.value.map(n => n.id)))
const vpnCount = computed(() => (topo.value?.nodes ?? []).filter(isVpn).length)
const saved = useLocalStorage<Record<string, { x: number, y: number }>>('uf-topology-pos', {})
const hovered = ref<string | null>(null)
const selectedId = ref<string | null>(null)
const focusEdge = ref<string | null>(null)

const nodeById = computed(() => new Map((topo.value?.nodes ?? []).map(n => [n.id, n])))
/** Path from the hovered node up to the gateway (and the hovered node's own subtree edge). */
const lit = computed(() => {
  const start = hovered.value ?? (focusEdge.value ? topo.value?.edges.find(e => e.id === focusEdge.value)?.target : null)
  if (!start) return null
  const ids = new Set<string>()
  let cur: TopologyNodeT | undefined = nodeById.value.get(start)
  while (cur) {
    ids.add(cur.id)
    cur = cur.parentId ? nodeById.value.get(cur.parentId) : undefined
  }
  return ids
})

const layout = computed(() => layoutTopology({ nodes: visibleNodes.value }))
const nodes = computed<Node[]>(() => visibleNodes.value.map(n => ({
  id: n.id,
  type: 'uf',
  position: saved.value[n.id] ?? layout.value.get(n.id) ?? { x: 0, y: 0 },
  data: {
    node: n,
    overlay: overlay.value,
    egress: n.egressId ? egressById.value.get(n.egressId) : undefined,
    highlighted: selectedId.value === n.id,
    dimmed: !!lit.value && !lit.value.has(n.id),
  },
  draggable: true,
  selectable: false,
})))
const edges = computed<Edge[]>(() => (topo.value?.edges ?? []).filter(e => visibleIds.value.has(e.source) && visibleIds.value.has(e.target)).map(e => ({
  id: e.id,
  // egress nodes sit left of the gateway: draw egress → gateway so the cable doesn't loop around
  source: e.medium === 'wan' || e.medium === 'vpn' ? e.target : e.source,
  target: e.medium === 'wan' || e.medium === 'vpn' ? e.source : e.target,
  type: 'uf',
  data: {
    edge: e,
    overlay: overlay.value,
    color: e.medium === 'wan' || e.medium === 'vpn' ? egressById.value.get(nodeById.value.get(e.target)?.egressId ?? '')?.color : undefined,
    highlighted: !!lit.value && lit.value.has(e.target),
    dimmed: !!lit.value && !lit.value.has(e.target),
  },
})))

const { fitView, onNodeDragStop, onNodeClick, onNodeMouseEnter, onNodeMouseLeave, onPaneReady } = useVueFlow('topology')
onPaneReady(() => setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50))
watch(() => visibleNodes.value.length, (n, old) => { if (n && n !== old) setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 80) })
onNodeDragStop(({ node }) => { saved.value = { ...saved.value, [node.id]: { x: node.position.x, y: node.position.y } } })
onNodeClick(({ node }) => { selectedId.value = node.id })
onNodeMouseEnter(({ node }) => { hovered.value = node.id })
onNodeMouseLeave(() => { hovered.value = null })
function resetLayout() {
  saved.value = {}
  setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50)
}

const selected = computed(() => (selectedId.value ? nodeById.value.get(selectedId.value) ?? null : null))
const selectedDevice = computed(() => device(selected.value?.mac))
const bottlenecks = computed(() => topo.value?.bottlenecks ?? [])
const msg = (k: string, p: Record<string, string>) => (te(k) ? t(k, p) : k)
const overlays: { value: Overlay, icon: string }[] = [
  { value: 'traffic', icon: 'i-lucide-activity' },
  { value: 'poe', icon: 'i-lucide-zap' },
  { value: 'health', icon: 'i-lucide-heart-pulse' },
  { value: 'people', icon: 'i-lucide-users' },
]
const stats = computed(() => {
  const n = topo.value?.nodes ?? []
  return {
    devices: n.filter(x => ['gateway', 'switch', 'ap', 'other'].includes(x.kind)).length,
    clients: n.filter(x => x.kind === 'client_group').reduce((s, x) => s + x.clients, 0),
  }
})
</script>

<template>
  <div>
    <PageHeader :title="t('nav.topology')" :description="t('topology.desc')" icon="i-lucide-network">
      <template #actions>
        <div class="inline-flex rounded-lg ring-1 ring-(--ui-border-muted) p-0.5 bg-(--uf-surface)">
          <UTooltip v-for="o in overlays" :key="o.value" :text="t(`topology.overlayHint.${o.value}`)">
            <button type="button" class="h-7 px-2.5 rounded-md text-[12px] font-medium flex items-center gap-1.5 transition" :class="overlay === o.value ? 'bg-primary text-white' : 'text-toned hover:bg-(--uf-hover)'" @click="overlay = o.value">
              <UIcon :name="o.icon" class="size-3.5" /><span class="hidden sm:inline">{{ t(`topology.overlay.${o.value}`) }}</span>
            </button>
          </UTooltip>
        </div>
        <UButton v-if="vpnCount" :color="showVpn ? 'primary' : 'neutral'" :variant="showVpn ? 'soft' : 'outline'" icon="i-lucide-shield" @click="showVpn = !showVpn">VPN ×{{ vpnCount }}</UButton>
        <UButton color="neutral" variant="outline" icon="i-lucide-scan" :aria-label="t('topology.fit')" @click="fitView({ padding: 0.15, duration: 300 })" />
        <UButton color="neutral" variant="outline" icon="i-lucide-layout-panel-left" @click="resetLayout">{{ t('topology.autoLayout') }}</UButton>
      </template>
    </PageHeader>

    <div class="grid xl:grid-cols-[1fr_300px] gap-4">
      <div class="uf-card relative overflow-hidden h-[calc(100dvh-230px)] min-h-[480px]">
        <div v-if="error && !topo" class="absolute inset-0 flex items-center justify-center"><EmptyState icon="i-lucide-network" :title="t('topology.unavailable')" :description="t('topology.unavailableDesc')" /></div>
        <div v-else-if="!topo && status === 'pending'" class="absolute inset-0 flex items-center justify-center"><UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-dimmed" /></div>
        <ClientOnly v-else>
          <VueFlow id="topology" :nodes="nodes" :edges="edges" :min-zoom="0.25" :max-zoom="2" :nodes-connectable="false" :elements-selectable="false" :zoom-on-double-click="false" class="uf-topology">
            <Background pattern-color="var(--uf-grid-line)" :gap="22" :size="1.2" />
            <template #node-uf="props">
              <TopologyNode :data="props.data" />
            </template>
            <template #edge-uf="props">
              <TopologyEdge v-bind="props" />
            </template>
          </VueFlow>
        </ClientOnly>
        <div class="absolute left-3 bottom-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted bg-(--uf-surface)/90 backdrop-blur rounded-lg px-2.5 py-1.5 ring-1 ring-(--ui-border-muted) pointer-events-none">
          <template v-if="overlay === 'traffic'">
            <span class="flex items-center gap-1"><span class="w-3 h-0.5 rounded bg-success" />{{ t('topology.legend.low') }}</span>
            <span class="flex items-center gap-1"><span class="w-3 h-0.5 rounded bg-warning" />50%+</span>
            <span class="flex items-center gap-1"><span class="w-3 h-0.5 rounded bg-error" />80%+</span>
          </template>
          <template v-else-if="overlay === 'poe'"><span class="flex items-center gap-1"><span class="w-3 h-1 rounded bg-warning" />{{ t('topology.legend.poe') }}</span></template>
          <template v-else>
            <span v-for="tier in (['slow', 'gig', 'multi', 'ten'] as const)" :key="tier" class="flex items-center gap-1"><span class="w-3 h-0.5 rounded" :style="{ background: speedColor[tier] }" />{{ t(`ports.legend.${tier}`) }}</span>
          </template>
          <span class="flex items-center gap-1"><span class="w-3 border-t border-dashed border-current" />{{ t('topology.legend.wireless') }}</span>
        </div>
      </div>

      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="uf-card p-3.5"><div class="uf-section-title">{{ t('nav.devices') }}</div><div class="text-xl font-semibold uf-num text-highlighted mt-1">{{ stats.devices }}</div></div>
          <div class="uf-card p-3.5"><div class="uf-section-title">{{ t('devices.kpi.clients') }}</div><div class="text-xl font-semibold uf-num text-highlighted mt-1">{{ stats.clients }}</div></div>
        </div>
        <UCard>
          <template #header>
            <div class="flex items-center gap-2"><UIcon name="i-lucide-gauge" class="size-4" :class="bottlenecks.length ? 'text-error' : 'text-success'" /><h2 class="text-sm font-semibold text-highlighted">{{ t('topology.bottlenecks') }}</h2></div>
          </template>
          <div v-if="bottlenecks.length" class="space-y-2 -m-1">
            <button
              v-for="(b, k) in bottlenecks"
              :key="k"
              type="button"
              class="w-full text-left rounded-lg px-2.5 py-2 transition ring-1"
              :class="focusEdge === b.edgeId ? 'ring-error/50 bg-error/8' : 'ring-transparent hover:bg-(--uf-hover)'"
              @click="focusEdge = focusEdge === b.edgeId ? null : b.edgeId"
            >
              <div class="flex items-start gap-2 text-[12.5px]">
                <UIcon name="i-lucide-triangle-alert" class="size-3.5 text-error mt-0.5 shrink-0" />
                <span class="text-highlighted">{{ msg(b.messageKey, b.messageParams) }}</span>
              </div>
              <div class="text-[11px] text-dimmed ml-5.5 mt-0.5">{{ t(`topology.bottleneck.kind.${b.kind}`) }}</div>
            </button>
          </div>
          <p v-else class="text-[12.5px] text-success flex items-center gap-1.5"><UIcon name="i-lucide-check-circle-2" class="size-4" />{{ t('topology.noBottlenecks') }}</p>
        </UCard>
        <p class="text-[11.5px] text-dimmed px-1">{{ t('topology.tip') }}</p>
      </div>
    </div>

    <USlideover :open="!!selected" :title="selected?.label" :description="selected ? t(`topology.kind.${selected.kind}`) : ''" @update:open="v => { if (!v) selectedId = null }">
      <template #body>
        <div v-if="selected" class="space-y-4">
          <template v-if="selectedDevice">
            <div class="flex items-center gap-3">
              <DeviceGlyph :type="selectedDevice.type" :model="selectedDevice.model" :state="selectedDevice.state" :size="48" />
              <div>
                <div class="text-[14px] font-semibold text-highlighted">{{ selectedDevice.name }}</div>
                <div class="text-[12px] text-dimmed">{{ selectedDevice.modelName ?? selectedDevice.model }} · {{ t(`devices.state.${selectedDevice.state}`) }}</div>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-2 text-center">
              <div class="rounded-md bg-(--uf-surface-2) py-2"><div class="text-[11px] text-dimmed">{{ t('devices.clients') }}</div><div class="font-semibold uf-num text-highlighted">{{ selectedDevice.clients ?? '—' }}</div></div>
              <div class="rounded-md bg-(--uf-surface-2) py-2"><div class="text-[11px] text-dimmed">{{ t('devices.cpu') }}</div><div class="font-semibold uf-num text-highlighted">{{ fmt.pct(selectedDevice.cpuPct) }}</div></div>
              <div class="rounded-md bg-(--uf-surface-2) py-2"><div class="text-[11px] text-dimmed">{{ t('devices.temp') }}</div><div class="font-semibold uf-num text-highlighted">{{ selectedDevice.tempC != null ? `${Math.round(selectedDevice.tempC)}°` : '—' }}</div></div>
            </div>
            <UButton :to="`/devices/${encodeURIComponent(selectedDevice.mac)}`" block icon="i-lucide-arrow-right">{{ t('topology.openDevice') }}</UButton>
          </template>
          <template v-else-if="selected.kind === 'client_group'">
            <div class="divide-y divide-(--ui-border-muted) -mx-1">
              <NuxtLink v-for="m in selected.members" :key="m.mac" :to="`/clients?mac=${m.mac}`" class="flex items-center gap-2.5 px-1 py-2 hover:bg-(--uf-hover) rounded-md">
                <PersonAvatar v-if="m.personId && person(m.personId)" :avatar="person(m.personId)!.avatar" :color="person(m.personId)!.color" :size="22" />
                <span v-else class="size-[22px] rounded-full bg-(--uf-surface-2) flex items-center justify-center"><UIcon :name="m.wired ? 'i-lucide-ethernet-port' : 'i-lucide-smartphone'" class="size-3 text-dimmed" /></span>
                <span class="text-[13px] text-highlighted truncate flex-1">{{ m.name }}</span>
                <span v-if="m.signal != null" class="text-[11.5px] uf-num" :class="m.signal < -75 ? 'text-warning' : 'text-dimmed'">{{ m.signal }} dBm</span>
                <span class="text-[11.5px] text-dimmed uf-num w-16 text-right">{{ fmt.bps((m.rxBps ?? 0) + (m.txBps ?? 0)) }}</span>
              </NuxtLink>
            </div>
          </template>
          <template v-else-if="selected.kind === 'egress' && selected.egressId">
            <UButton to="/egresses" block icon="i-lucide-globe">{{ t('topology.openEgresses') }}</UButton>
          </template>
        </div>
      </template>
    </USlideover>
  </div>
</template>

<style scoped>
.uf-topology :deep(.vue-flow__edge-path) { transition: stroke-opacity .2s, stroke .2s; }
.uf-topology :deep(.vue-flow__node) { transition: opacity .2s; }
</style>
