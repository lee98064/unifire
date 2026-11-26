<script setup lang="ts">
import type { PortViewT } from '#shared/schemas/infra'
import { portName, speedColor, speedLabel, speedTier } from '~/utils/devices'

/**
 * Front-panel rendering of a switch / gateway port table. RJ45 ports with ≥ 8 jacks are drawn
 * in two rows (odd on top, even below) like the hardware; SFP cages sit on the right.
 * Colour = negotiated speed, bolt = PoE, arrow = uplink, amber corner = port issue.
 */
const props = withDefaults(defineProps<{
  ports: PortViewT[]
  selected?: number | null
  /** Highlight ports that can take a PoE schedule (others are dimmed). */
  pickPoe?: boolean
  size?: 'sm' | 'md'
}>(), { selected: null, pickPoe: false, size: 'md' })
const emit = defineEmits<{ select: [idx: number] }>()
const { t } = useI18n()
const { get: person } = usePeople()

const isSfp = (p: PortViewT) => p.media !== 'rj45' && p.media !== 'unknown'
const rj45 = computed(() => props.ports.filter(p => !isSfp(p)).sort((a, b) => a.idx - b.idx))
const sfp = computed(() => props.ports.filter(isSfp).sort((a, b) => a.idx - b.idx))
const twoRows = computed(() => rj45.value.length >= 8)
const rows = computed(() => twoRows.value
  ? [rj45.value.filter((_, i) => i % 2 === 0), rj45.value.filter((_, i) => i % 2 === 1)]
  : [rj45.value])
const sfpRows = computed(() => sfp.value.length >= 4 && twoRows.value
  ? [sfp.value.filter((_, i) => i % 2 === 0), sfp.value.filter((_, i) => i % 2 === 1)]
  : [sfp.value])

const w = computed(() => (props.size === 'sm' ? 26 : props.ports.length <= 18 ? 40 : 34))

function tone(p: PortViewT) {
  return speedColor[speedTier(p.speedMbps, p.up && p.enabled)]
}
function poeState(p: PortViewT): 'on' | 'off' | 'idle' | null {
  if (!p.poe?.capable) return null
  if (p.poe.mode === 'off') return 'off'
  return (p.poe.powerW ?? 0) > 0 ? 'on' : 'idle'
}
/** Only powered or explicitly-off ports get a corner badge; idle PoE ports stay clean. */
const poeBadge = (p: PortViewT) => { const s = poeState(p); return s === 'idle' ? null : s }
function dimmed(p: PortViewT) {
  return props.pickPoe && !p.poeSafety.allowed
}
function tip(p: PortViewT) {
  const parts = [`${t('ports.port', { n: p.idx })}${portName(p) ? ` · ${portName(p)}` : ''}`]
  if (!p.enabled) parts.push(t('ports.disabled'))
  else if (!p.up) parts.push(t('ports.down'))
  else parts.push(`${speedLabel(p.speedMbps)}${p.fullDuplex === false ? ` ${t('ports.halfDuplex')}` : ''}`)
  if (p.peer?.name) parts.push(p.peer.count > 1 && p.peer.kind !== 'device' ? `${p.peer.name} +${p.peer.count - 1}` : p.peer.name)
  const pp = poeState(p)
  if (pp === 'on') parts.push(t('ports.poeOn', { w: (p.poe?.powerW ?? 0).toFixed(1) }))
  if (pp === 'off') parts.push(t('ports.poeOff'))
  if (p.isUplink) parts.push(t('ports.uplink'))
  for (const i of p.issues) parts.push(`⚠ ${t(`ports.issue.${i}`)}`)
  return parts.join(' · ')
}
</script>

<template>
  <div class="overflow-x-auto -mx-1 px-1 pb-1">
    <div
      class="inline-flex items-stretch gap-4 rounded-xl px-4 py-3 bg-[linear-gradient(180deg,var(--uf-surface-2),var(--uf-surface))] ring-1 ring-(--ui-border-accented) shadow-(--uf-shadow) min-w-max"
      role="group"
      :aria-label="t('ports.faceplate')"
    >
      <!-- RJ45 block -->
      <div v-if="rj45.length" class="flex flex-col gap-1.5">
        <div v-for="(row, ri) in rows" :key="ri">
          <div class="flex gap-1.5">
            <div v-for="p in row" :key="p.idx" class="flex flex-col items-center gap-0.5" :class="ri === 1 ? 'flex-col-reverse' : ''">
              <span class="text-[9.5px] leading-none uf-num" :class="selected === p.idx ? 'text-primary font-semibold' : 'text-dimmed'">{{ p.idx }}</span>
              <UTooltip :text="tip(p)" :delay-duration="150">
                <button
                  type="button"
                  class="relative rounded-[5px] transition focus-visible:outline-2 focus-visible:outline-primary"
                  :class="[selected === p.idx ? 'ring-2 ring-primary ring-offset-2 ring-offset-(--uf-surface) scale-105' : 'hover:-translate-y-px', dimmed(p) ? 'opacity-35' : '']"
                  :style="{ width: `${w}px`, height: `${w * 0.78}px` }"
                  :aria-label="tip(p)"
                  :aria-pressed="selected === p.idx"
                  @click="emit('select', p.idx)"
                >
                  <svg :viewBox="'0 0 34 26'" class="size-full" aria-hidden="true">
                    <rect x=".75" y=".75" width="32.5" height="24.5" rx="4" :fill="p.up && p.enabled ? `color-mix(in oklab, ${tone(p)} 22%, var(--uf-surface))` : 'var(--uf-surface-2)'" :stroke="p.up && p.enabled ? tone(p) : 'var(--ui-border-accented)'" stroke-width="1.5" :stroke-dasharray="p.enabled ? undefined : '3 2'" />
                    <!-- RJ45 jack silhouette (flipped on the bottom row like real hardware) -->
                    <path :d="ri === 1 ? 'M8 6h18v9h-3v4h-12v-4h-3z' : 'M8 20h18v-9h-3v-4h-12v4h-3z'" :fill="p.up && p.enabled ? `color-mix(in oklab, ${tone(p)} 55%, #000 10%)` : 'var(--ui-bg-accented)'" opacity=".9" />
                  </svg>
                  <span v-if="poeBadge(p)" class="absolute -top-1.5 -right-1.5 size-3.5 rounded-full flex items-center justify-center ring-2 ring-(--uf-surface)" :class="poeBadge(p) === 'on' ? 'bg-warning text-white' : 'bg-(--ui-bg-accented) text-dimmed'">
                    <UIcon :name="poeState(p) === 'off' ? 'i-lucide-zap-off' : 'i-lucide-zap'" class="size-2.5" />
                  </span>
                  <span v-if="p.isUplink" class="absolute -bottom-1.5 -right-1.5 size-3.5 rounded-full bg-primary text-white flex items-center justify-center ring-2 ring-(--uf-surface)">
                    <UIcon name="i-lucide-arrow-up" class="size-2.5" />
                  </span>
                  <span v-if="p.issues.length" class="absolute -top-1 -left-1 size-2.5 rounded-full bg-warning ring-2 ring-(--uf-surface) animate-pulse" />
                  <span v-if="p.peer?.personId && person(p.peer.personId)" class="absolute -bottom-1.5 -left-1.5">
                    <PersonAvatar :avatar="person(p.peer.personId)!.avatar" :color="person(p.peer.personId)!.color" :size="14" class="ring-2 ring-(--uf-surface) rounded-full" />
                  </span>
                </button>
              </UTooltip>
            </div>
          </div>
        </div>
      </div>

      <div v-if="rj45.length && sfp.length" class="w-px bg-(--ui-border-muted) my-1" />

      <!-- SFP block -->
      <div v-if="sfp.length" class="flex flex-col gap-1.5 justify-center">
        <div v-for="(row, ri) in sfpRows" :key="ri">
          <div class="flex gap-1.5">
            <div v-for="p in row" :key="p.idx" class="flex flex-col items-center gap-0.5" :class="ri === 1 ? 'flex-col-reverse' : ''">
              <span class="text-[9.5px] leading-none uf-num" :class="selected === p.idx ? 'text-primary font-semibold' : 'text-dimmed'">{{ p.idx }}</span>
              <UTooltip :text="tip(p)" :delay-duration="150">
                <button
                  type="button"
                  class="relative rounded-[3px] transition focus-visible:outline-2 focus-visible:outline-primary"
                  :class="[selected === p.idx ? 'ring-2 ring-primary ring-offset-2 ring-offset-(--uf-surface)' : 'hover:-translate-y-px', dimmed(p) ? 'opacity-35' : '']"
                  :style="{ width: `${w * 1.15}px`, height: `${w * 0.6}px` }"
                  :aria-label="tip(p)"
                  :aria-pressed="selected === p.idx"
                  @click="emit('select', p.idx)"
                >
                  <svg viewBox="0 0 40 20" class="size-full" aria-hidden="true">
                    <rect x=".75" y=".75" width="38.5" height="18.5" rx="2.5" fill="var(--uf-surface-2)" :stroke="p.up ? tone(p) : 'var(--ui-border-accented)'" stroke-width="1.5" />
                    <rect x="6" y="6" width="28" height="8" rx="1.2" :fill="p.up ? tone(p) : 'var(--ui-bg-accented)'" :opacity="p.up ? 0.85 : 1" />
                  </svg>
                  <span v-if="p.isUplink" class="absolute -bottom-1.5 -right-1.5 size-3.5 rounded-full bg-primary text-white flex items-center justify-center ring-2 ring-(--uf-surface)">
                    <UIcon name="i-lucide-arrow-up" class="size-2.5" />
                  </span>
                  <span v-if="p.issues.length" class="absolute -top-1 -left-1 size-2.5 rounded-full bg-warning ring-2 ring-(--uf-surface) animate-pulse" />
                </button>
              </UTooltip>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="size === 'md'" class="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 text-[11.5px] text-muted">
      <span v-for="tier in (['slow', 'gig', 'multi', 'ten'] as const)" :key="tier" class="flex items-center gap-1.5">
        <span class="size-2.5 rounded-sm" :style="{ background: speedColor[tier] }" />{{ t(`ports.legend.${tier}`) }}
      </span>
      <span class="flex items-center gap-1.5"><span class="size-2.5 rounded-sm ring-1 ring-(--ui-border-accented) bg-(--uf-surface-2)" />{{ t('ports.legend.down') }}</span>
      <span class="flex items-center gap-1.5"><UIcon name="i-lucide-zap" class="size-3 text-warning" />PoE</span>
      <span class="flex items-center gap-1.5"><UIcon name="i-lucide-arrow-up" class="size-3 text-primary" />{{ t('ports.uplink') }}</span>
    </div>
  </div>
</template>
