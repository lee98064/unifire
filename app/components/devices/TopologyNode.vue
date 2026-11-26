<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import type { DeviceTypeT, TopologyNodeT } from '#shared/schemas/infra'
import type { EgressT } from '#shared/schemas/egress'
import { egressKindIcon, latencyColor } from '~/utils/egress'
import type { Overlay } from '~/utils/topology'

const props = defineProps<{ data: { node: TopologyNodeT, overlay: Overlay, egress?: EgressT, highlighted?: boolean, dimmed?: boolean } }>()
const { t } = useI18n()
const fmt = useFormat()
const { get: person } = usePeople()
const n = computed(() => props.data.node)
const isDevice = computed(() => ['gateway', 'switch', 'ap', 'other'].includes(n.value.kind))
const ring = computed(() => {
  if (n.value.state === 'down') return 'ring-error/60'
  if (n.value.state === 'warning') return 'ring-warning/60'
  return 'ring-(--ui-border-muted)'
})
const people = computed(() => n.value.people.map(id => person(id)).filter(p => !!p).slice(0, 5))
const deviceState = computed(() => (n.value.state === 'down' ? 'offline' : n.value.state === 'ok' ? 'online' : n.value.state === 'warning' ? 'online' : 'unknown') as 'offline' | 'online' | 'unknown')
</script>

<template>
  <div class="relative transition-opacity" :class="data.dimmed ? 'opacity-30' : ''">
    <Handle type="target" :position="Position.Left" class="!opacity-0 !pointer-events-none" />
    <Handle type="source" :position="Position.Right" class="!opacity-0 !pointer-events-none" />

    <!-- egress -->
    <div
      v-if="n.kind === 'egress'"
      class="flex items-center gap-2 w-[190px] px-2.5 py-1.5 rounded-full bg-(--uf-surface) ring-1 shadow-(--uf-shadow)"
      :style="{ '--tw-ring-color': `color-mix(in oklab, ${data.egress?.color ?? 'var(--ui-border-accented)'} 45%, transparent)` }"
    >
      <span class="size-6 rounded-full flex items-center justify-center shrink-0" :style="{ background: `color-mix(in oklab, ${data.egress?.color ?? '#888'} 16%, transparent)`, color: data.egress?.color }">
        <UIcon :name="data.egress ? egressKindIcon[data.egress.kind] : 'i-lucide-globe'" class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1 leading-tight">
        <div class="text-[12px] font-medium text-highlighted truncate">{{ n.label }}</div>
        <div class="text-[10.5px] uf-num" :style="{ color: n.state === 'down' ? 'var(--color-ufred-500)' : latencyColor(data.egress?.health.latencyMs) }">
          {{ n.state === 'down' ? t('health.down') : fmt.ms(data.egress?.health.latencyMs) }}
        </div>
      </div>
    </div>

    <!-- device -->
    <div
      v-else-if="isDevice"
      class="w-[210px] rounded-xl bg-(--uf-surface) ring-1 shadow-(--uf-shadow) px-3 py-2.5 cursor-pointer hover:shadow-(--uf-shadow-lg) transition"
      :class="[ring, data.highlighted ? 'ring-2 ring-primary' : '']"
    >
      <div class="flex items-center gap-2.5">
        <DeviceGlyph :type="n.kind as DeviceTypeT" :model="n.model" :state="deviceState" :size="34" />
        <div class="min-w-0 flex-1">
          <div class="text-[12.5px] font-semibold text-highlighted truncate">{{ n.label }}</div>
          <div class="flex items-center gap-2 text-[10.5px] text-dimmed uf-num">
            <span class="flex items-center gap-0.5"><UIcon name="i-lucide-monitor-smartphone" class="size-3" />{{ n.clients }}</span>
            <span v-if="n.poeW != null" class="flex items-center gap-0.5" :class="data.overlay === 'poe' ? 'text-warning font-semibold' : ''"><UIcon name="i-lucide-zap" class="size-3" />{{ n.poeW.toFixed(1) }} W</span>
            <UIcon v-if="n.state === 'warning'" name="i-lucide-triangle-alert" class="size-3 text-warning" />
          </div>
        </div>
      </div>
      <div v-if="data.overlay === 'people' && people.length" class="flex -space-x-1.5 mt-2">
        <PersonAvatar v-for="p in people" :key="p!.id" :avatar="p!.avatar" :color="p!.color" :size="20" class="ring-2 ring-(--uf-surface) rounded-full" />
      </div>
    </div>

    <!-- client group -->
    <div
      v-else-if="n.kind === 'client_group'"
      class="flex items-center gap-2 w-[170px] px-2.5 py-1.5 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) cursor-pointer hover:ring-(--ui-border-accented) transition"
    >
      <UIcon :name="n.id.split(':').length > 2 ? 'i-lucide-ethernet-port' : 'i-lucide-wifi'" class="size-3.5 text-dimmed shrink-0" />
      <span class="text-[11.5px] text-toned uf-num">{{ t('topology.clientsN', { n: n.clients }) }}</span>
      <div v-if="people.length" class="flex -space-x-1.5 ml-auto">
        <PersonAvatar v-for="p in people.slice(0, 3)" :key="p!.id" :avatar="p!.avatar" :color="p!.color" :size="18" class="ring-2 ring-(--uf-surface-2) rounded-full" />
      </div>
    </div>
  </div>
</template>
