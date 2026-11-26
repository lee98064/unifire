<script setup lang="ts">
import type { DeviceStateT, DeviceTypeT } from '#shared/schemas/infra'
import { healthColor } from '~/utils/egress'
import { busyStates, deviceDot, glyphShape } from '~/utils/devices'

/**
 * Small product-silhouette illustration for a UniFi device (rack gateway, switch, flex switch,
 * ceiling AP disc, Express cube). The status LED takes the device state colour.
 */
const props = withDefaults(defineProps<{ type: DeviceTypeT, model?: string | null, state: DeviceStateT, size?: number }>(), { size: 48, model: null })
const shape = computed(() => glyphShape({ type: props.type, model: props.model }))
const led = computed(() => healthColor[deviceDot(props.state)])
const busy = computed(() => busyStates.includes(props.state))
const off = computed(() => props.state === 'offline')
// Unique per instance: a shared id breaks when the first SVG on the page is hidden (display:none).
const gid = `uf-glyph-${useId()}`
const body = `url(#${gid})`
</script>

<template>
  <div
    class="relative shrink-0 rounded-xl bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) flex items-center justify-center overflow-hidden"
    :class="off ? 'opacity-70 grayscale' : ''"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <svg viewBox="0 0 56 56" :width="size * 0.86" :height="size * 0.86" aria-hidden="true">
      <defs>
        <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--uf-surface)" />
          <stop offset="1" stop-color="var(--uf-surface-2)" />
        </linearGradient>
      </defs>

      <!-- 1U rack gateway (UDM Pro): display + port block -->
      <g v-if="shape === 'rack'">
        <rect x="3" y="19" width="50" height="18" rx="3" :fill="body" stroke="var(--ui-border-accented)" />
        <rect x="7" y="23" width="12" height="10" rx="1.5" fill="var(--ui-bg-inverted)" opacity="0.85" />
        <rect x="9" y="25.5" width="6" height="1.4" rx=".7" fill="var(--ui-primary)" opacity=".9" />
        <rect x="9" y="28.5" width="4" height="1.4" rx=".7" fill="var(--ui-text-dimmed)" />
        <g fill="var(--ui-text-dimmed)" opacity=".55">
          <rect v-for="i in 8" :key="i" :x="22 + (i - 1) * 3.4" y="24.5" width="2.6" height="2.6" rx=".5" />
          <rect v-for="i in 8" :key="`b${i}`" :x="22 + (i - 1) * 3.4" y="29" width="2.6" height="2.6" rx=".5" />
        </g>
        <circle cx="50" cy="23" r="1.3" :fill="led" />
      </g>

      <!-- rack switch: two rows of ports + SFP cages -->
      <g v-else-if="shape === 'switch'">
        <rect x="3" y="20" width="50" height="16" rx="3" :fill="body" stroke="var(--ui-border-accented)" />
        <g fill="var(--ui-text-dimmed)" opacity=".55">
          <rect v-for="i in 8" :key="i" :x="7 + (i - 1) * 4" y="23.5" width="3" height="3" rx=".5" />
          <rect v-for="i in 8" :key="`b${i}`" :x="7 + (i - 1) * 4" y="28.5" width="3" height="3" rx=".5" />
        </g>
        <rect x="41" y="24" width="4" height="7" rx=".8" fill="none" stroke="var(--ui-text-dimmed)" opacity=".7" />
        <rect x="46" y="24" width="4" height="7" rx=".8" fill="none" stroke="var(--ui-text-dimmed)" opacity=".7" />
        <circle cx="49" cy="33.5" r="1.1" :fill="led" />
      </g>

      <!-- desktop flex switch -->
      <g v-else-if="shape === 'flex'">
        <rect x="10" y="20" width="36" height="17" rx="4" :fill="body" stroke="var(--ui-border-accented)" />
        <g fill="var(--ui-text-dimmed)" opacity=".6">
          <rect v-for="i in 5" :key="i" :x="14 + (i - 1) * 5.4" y="26" width="4" height="4" rx=".6" />
        </g>
        <circle cx="41" cy="23.5" r="1.1" :fill="led" />
      </g>

      <!-- ceiling AP disc with LED ring -->
      <g v-else-if="shape === 'disc'">
        <circle cx="28" cy="28" r="21" :fill="body" stroke="var(--ui-border-accented)" />
        <circle cx="28" cy="28" r="13" fill="none" :stroke="led" stroke-width="1.6" opacity=".9" :class="busy ? 'uf-glyph-spin' : ''" :stroke-dasharray="busy ? '18 64' : undefined" />
        <circle cx="28" cy="28" r="3" fill="var(--ui-text-dimmed)" opacity=".35" />
      </g>

      <!-- Express cube with little screen -->
      <g v-else-if="shape === 'cube'">
        <rect x="13" y="12" width="30" height="32" rx="7" :fill="body" stroke="var(--ui-border-accented)" />
        <rect x="18" y="18" width="20" height="13" rx="2" fill="var(--ui-bg-inverted)" opacity=".85" />
        <rect x="21" y="22" width="9" height="1.4" rx=".7" fill="var(--ui-primary)" />
        <rect x="21" y="25.5" width="6" height="1.4" rx=".7" fill="var(--ui-text-dimmed)" />
        <rect x="22" y="38" width="12" height="1.6" rx=".8" :fill="led" />
      </g>

      <g v-else>
        <rect x="12" y="14" width="32" height="28" rx="5" :fill="body" stroke="var(--ui-border-accented)" />
        <circle cx="38" cy="20" r="1.3" :fill="led" />
      </g>
    </svg>
    <span
      v-if="busy"
      class="absolute right-1 top-1 size-3.5 rounded-full border-2 border-(--ui-warning) border-t-transparent animate-spin"
    />
  </div>
</template>

<style scoped>
.uf-glyph-spin { transform-origin: 28px 28px; animation: uf-glyph-rot 1.4s linear infinite; }
@keyframes uf-glyph-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .uf-glyph-spin { animation: none; } }
</style>
