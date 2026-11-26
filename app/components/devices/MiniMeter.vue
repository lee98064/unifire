<script setup lang="ts">
/** Compact labelled bar for CPU / memory / temperature. `max` scales the bar (temperature uses 100 °C). */
const props = withDefaults(defineProps<{ label: string, value: number | null | undefined, unit?: string, max?: number, warn: number, crit: number }>(), { unit: '%', max: 100 })
const pct = computed(() => props.value == null ? 0 : Math.max(2, Math.min(100, (props.value / props.max) * 100)))
const color = computed(() => {
  if (props.value == null) return 'var(--ui-border-accented)'
  if (props.value >= props.crit) return 'var(--color-ufred-500)'
  if (props.value >= props.warn) return 'var(--color-ufamber-500)'
  return 'var(--ui-primary)'
})
</script>

<template>
  <div class="min-w-0">
    <div class="flex items-baseline justify-between gap-1 text-[11px] leading-none mb-1">
      <span class="text-dimmed truncate">{{ label }}</span>
      <span class="uf-num font-medium" :class="value == null ? 'text-dimmed' : 'text-toned'">{{ value == null ? '—' : `${Math.round(value)}${unit}` }}</span>
    </div>
    <div class="h-1 rounded-full bg-(--ui-bg-accented) overflow-hidden">
      <div class="h-full rounded-full transition-[width] duration-700 ease-(--ease-uf)" :style="{ width: `${pct}%`, background: color }" />
    </div>
  </div>
</template>
