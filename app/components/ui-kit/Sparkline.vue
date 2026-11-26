<script setup lang="ts">
/** Lightweight SVG sparkline (no chart lib) — used in tables and cards. */
const props = withDefaults(defineProps<{ values: (number | null)[], width?: number, height?: number, color?: string, fill?: boolean, max?: number }>(), { width: 120, height: 32, color: 'var(--ui-primary)', fill: true })
const gid = useId()
const geo = computed(() => {
  const vals = props.values
  if (vals.length < 2) return null
  const nums = vals.filter((v): v is number => v != null)
  const max = props.max ?? Math.max(1, ...nums)
  const step = props.width / (vals.length - 1)
  const pts: string[] = []
  const gaps: { x: number }[] = []
  vals.forEach((v, i) => {
    const x = i * step
    if (v == null) { gaps.push({ x }); return }
    const y = props.height - 2 - (v / max) * (props.height - 4)
    pts.push(`${pts.length ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`)
  })
  const line = pts.join(' ')
  const area = `${line} L${props.width},${props.height} L0,${props.height} Z`
  return { line, area, gaps }
})
</script>

<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" class="overflow-visible" aria-hidden="true">
    <defs>
      <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" :stop-color="color" stop-opacity="0.28" />
        <stop offset="100%" :stop-color="color" stop-opacity="0" />
      </linearGradient>
    </defs>
    <template v-if="geo">
      <path v-if="fill" :d="geo.area" :fill="`url(#${gid})`" />
      <path :d="geo.line" fill="none" :stroke="color" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
      <line v-for="(g, i) in geo.gaps" :key="i" :x1="g.x" :x2="g.x" y1="2" :y2="height - 2" stroke="var(--color-ufred-500)" stroke-opacity="0.5" stroke-width="1.5" />
    </template>
    <line v-else x1="0" :x2="width" :y1="height / 2" :y2="height / 2" stroke="var(--ui-border-accented)" stroke-dasharray="3 3" />
  </svg>
</template>
