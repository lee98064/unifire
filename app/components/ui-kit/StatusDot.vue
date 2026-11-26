<script setup lang="ts">
import type { HealthStatusT } from '#shared/schemas/egress'
import { healthColor } from '~/utils/egress'

const props = withDefaults(defineProps<{ status: HealthStatusT | 'online' | 'offline', pulse?: boolean, size?: number }>(), { pulse: false, size: 8 })
const color = computed(() => {
  if (props.status === 'online') return healthColor.healthy
  if (props.status === 'offline') return healthColor.unknown
  return healthColor[props.status]
})
const animate = computed(() => props.pulse && (props.status === 'healthy' || props.status === 'online' || props.status === 'down'))
</script>

<template>
  <span class="relative inline-flex shrink-0" :style="{ width: `${size}px`, height: `${size}px` }">
    <span v-if="animate" class="absolute inset-0 rounded-full opacity-50 animate-ping" :style="{ background: color, animationDuration: status === 'down' ? '1.2s' : '2.4s' }" />
    <span class="relative inline-flex rounded-full size-full" :style="{ background: color }" />
  </span>
</template>
