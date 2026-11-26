<script setup lang="ts">
/** Circular progress ring for quotas (Apple-Watch-like). */
const props = withDefaults(defineProps<{ pct: number, size?: number, stroke?: number, state?: 'ok' | 'warning' | 'exceeded', label?: string, sub?: string }>(), { size: 64, stroke: 7, state: 'ok' })
const r = computed(() => (props.size - props.stroke) / 2)
const c = computed(() => 2 * Math.PI * r.value)
const clamped = computed(() => Math.max(0, Math.min(100, props.pct)))
const color = computed(() => props.state === 'exceeded' ? 'var(--color-ufred-500)' : props.state === 'warning' ? 'var(--color-ufamber-500)' : 'var(--ui-primary)')
const text = computed(() => props.label ?? `${Math.round(props.pct)}%`)
// Shrink long labels ("1 小時 12 分", "18.6 GB") so they stay inside the ring: estimate width in em
// (CJK ≈ 1em, digits/latin ≈ 0.58em, spaces ≈ 0.3em) against the inner diameter.
const labelSize = computed(() => {
  const ems = [...text.value].reduce((w, ch) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : ch === ' ' ? 0.3 : 0.58), 0)
  const inner = (props.size - props.stroke * 2) * 0.82
  return Math.min(props.size * 0.22, inner / Math.max(ems, 1))
})
</script>

<template>
  <div class="relative inline-flex items-center justify-center shrink-0" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg :width="size" :height="size" class="-rotate-90">
      <circle :cx="size / 2" :cy="size / 2" :r="r" fill="none" stroke="var(--ui-bg-accented)" :stroke-width="stroke" />
      <circle
        :cx="size / 2" :cy="size / 2" :r="r" fill="none" :stroke="color" :stroke-width="stroke" stroke-linecap="round"
        :stroke-dasharray="c" :stroke-dashoffset="c * (1 - clamped / 100)"
        class="transition-[stroke-dashoffset] duration-700 ease-(--ease-uf)"
      />
    </svg>
    <div class="absolute inset-0 flex flex-col items-center justify-center leading-none text-center">
      <span class="font-semibold text-highlighted uf-num whitespace-nowrap" :style="{ fontSize: `${labelSize}px` }">{{ text }}</span>
      <span v-if="sub" class="text-dimmed mt-0.5" :style="{ fontSize: `${Math.max(9, size * 0.13)}px` }">{{ sub }}</span>
    </div>
  </div>
</template>
