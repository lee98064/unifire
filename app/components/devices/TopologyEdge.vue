<script setup lang="ts">
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Position } from '@vue-flow/core'
import type { TopologyEdgeT } from '#shared/schemas/infra'
import { speedColor, speedLabel, speedTier } from '~/utils/devices'
import { packetCount, utilColor, type Overlay } from '~/utils/topology'

const props = defineProps<{
  id: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: Position
  targetPosition: Position
  data: { edge: TopologyEdgeT, overlay: Overlay, color?: string, highlighted?: boolean, dimmed?: boolean }
}>()
const fmt = useFormat()
const reduceMotion = usePreferredReducedMotion()
const path = computed(() => getBezierPath({ ...props, curvature: 0.35 }))
const e = computed(() => props.data.edge)
const bottleneck = computed(() => e.value.bottlenecks.length > 0)
const color = computed(() => {
  if (props.data.color) return props.data.color
  if (props.data.overlay === 'health') return bottleneck.value ? 'var(--color-ufred-500)' : 'var(--color-ufgreen-500)'
  if (props.data.overlay === 'poe') return e.value.poeW ? 'var(--color-ufamber-500)' : 'var(--ui-border-accented)'
  if (props.data.overlay === 'traffic' && e.value.utilizationPct != null) return utilColor(e.value.utilizationPct)
  return e.value.medium === 'wireless' ? 'var(--color-ufviolet-500, #8E59FF)' : speedColor[speedTier(e.value.speedMbps)]
})
const width = computed(() => {
  if (props.data.overlay === 'poe' && e.value.poeW) return Math.min(5, 1.5 + e.value.poeW / 6)
  if (props.data.overlay === 'traffic') return 1.4 + Math.min(3, (e.value.utilizationPct ?? 0) / 25)
  return 1.6
})
const dashed = computed(() => e.value.medium === 'wireless' || e.value.medium === 'vpn')
const packets = computed(() => (reduceMotion.value === 'reduce' || props.data.dimmed ? 0 : packetCount(e.value)))
const dur = computed(() => {
  const bps = Math.max(e.value.downBps ?? 0, e.value.upBps ?? 0)
  return Math.max(1.2, 4 - Math.log10(Math.max(bps, 1)) / 3)
})
const label = computed(() => {
  const parts: string[] = []
  if (props.data.overlay === 'poe') return e.value.poeW ? `⚡ ${e.value.poeW.toFixed(1)} W` : ''
  if (e.value.medium === 'wireless') parts.push(e.value.signal != null ? `${e.value.signal} dBm` : 'Mesh')
  else if (e.value.speedMbps) parts.push(speedLabel(e.value.speedMbps))
  if (props.data.overlay === 'traffic' && (e.value.downBps || e.value.upBps)) parts.push(`↓${fmt.bps(e.value.downBps)}`)
  return parts.join(' · ')
})
const showLabel = computed(() => !!label.value && !e.value.target.startsWith('clients:'))
</script>

<template>
  <BaseEdge :id="id" :path="path[0]" :style="{ stroke: color, strokeWidth: width, strokeOpacity: data.dimmed ? 0.15 : data.highlighted ? 1 : 0.6, strokeDasharray: dashed ? '6 5' : undefined }" />
  <circle v-for="i in packets" :key="i" r="2.4" :fill="color" :opacity="data.dimmed ? 0 : 0.9">
    <animateMotion :dur="`${dur}s`" :begin="`-${(dur / packets) * (i - 1)}s`" repeatCount="indefinite" :path="path[0]" />
  </circle>
  <EdgeLabelRenderer v-if="showLabel || bottleneck">
    <div
      class="absolute pointer-events-none nodrag nopan flex items-center gap-1"
      :style="{ transform: `translate(-50%, -50%) translate(${path[1]}px, ${path[2]}px)` }"
    >
      <span v-if="showLabel" class="px-1.5 py-px rounded-md text-[10px] font-medium uf-num bg-(--uf-surface) ring-1 ring-(--ui-border-muted) text-toned whitespace-nowrap" :class="data.dimmed ? 'opacity-30' : ''">{{ label }}</span>
      <span v-if="bottleneck && !data.dimmed" class="size-4 rounded-full bg-error text-white flex items-center justify-center ring-2 ring-(--uf-surface) animate-pulse"><UIcon name="i-lucide-triangle-alert" class="size-2.5" /></span>
    </div>
  </EdgeLabelRenderer>
</template>
