<script setup lang="ts">
import type { RoutePreviewT } from '#shared/schemas/routes'
import { onColor } from '~/utils/egress'

/** 48h horizontal timeline of resolved egress segments with a "now" marker and day ticks. */
const props = defineProps<{ preview: RoutePreviewT | null }>()
const { t } = useI18n()
const fmt = useFormat()
const { get } = useEgresses()
const now = useClock(30_000)

const range = computed(() => {
  const segs = props.preview?.segments ?? []
  if (!segs.length) return null
  return { from: segs[0]!.start, to: segs.at(-1)!.end }
})
const pos = (ts: number) => range.value ? ((ts - range.value.from) / (range.value.to - range.value.from)) * 100 : 0
const ticks = computed(() => {
  if (!range.value) return []
  const out: { ts: number, label: string, major: boolean }[] = []
  const step = 3 * 3600_000
  let ts = Math.ceil(range.value.from / step) * step
  for (; ts < range.value.to; ts += step) {
    const hh = fmt.time(ts, { hour: '2-digit', hour12: false })
    out.push({ ts, label: hh === '00' ? fmt.time(ts, { month: 'numeric', day: 'numeric' }) : `${hh}`, major: hh === '00' })
  }
  return out
})
const reasonIcon: Record<string, string> = { schedule: 'i-lucide-calendar-clock', default: 'i-lucide-circle', override: 'i-lucide-timer', failover: 'i-lucide-life-buoy', recover: 'i-lucide-undo-2', manual: 'i-lucide-hand', rule: 'i-lucide-workflow', initial: 'i-lucide-play' }
</script>

<template>
  <div v-if="preview && range">
    <div class="relative h-12 rounded-lg overflow-hidden ring-1 ring-(--ui-border-muted) bg-(--ui-bg-accented)">
      <UTooltip v-for="(s, i) in preview.segments" :key="i" :content="{ side: 'top' }">
        <template #content>
          <div class="text-xs space-y-0.5">
            <div class="font-semibold">{{ get(s.egressId)?.name ?? s.egressId }}</div>
            <div class="opacity-80">{{ fmt.dateTime(s.start) }} – {{ fmt.time(s.end) }}</div>
            <div class="opacity-80">{{ t(`routes.reason.${s.reason}`) }}</div>
          </div>
        </template>
        <div
          class="absolute inset-y-0 flex items-center px-2 text-[11px] font-semibold overflow-hidden border-r border-black/10 transition-[filter] hover:brightness-110"
          :style="{
            left: `${pos(s.start)}%`, width: `${pos(s.end) - pos(s.start)}%`,
            background: s.reason === 'default' ? `repeating-linear-gradient(135deg, color-mix(in oklab, ${get(s.egressId)?.color ?? '#888'} 30%, transparent) 0 5px, color-mix(in oklab, ${get(s.egressId)?.color ?? '#888'} 14%, transparent) 5px 10px)` : (get(s.egressId)?.color ?? '#888'),
            color: s.reason === 'default' ? 'var(--ui-text-toned)' : onColor(get(s.egressId)?.color ?? '#888888'),
          }"
        >
          <UIcon v-if="s.reason !== 'schedule' && s.reason !== 'default'" :name="reasonIcon[s.reason]!" class="size-3 mr-1 shrink-0" />
          <span class="truncate">{{ get(s.egressId)?.name }}</span>
        </div>
      </UTooltip>
      <div class="absolute inset-y-0 w-0.5 bg-(--ui-text-highlighted) shadow-[0_0_0_3px_color-mix(in_oklab,var(--uf-surface)_70%,transparent)]" :style="{ left: `${pos(now.getTime())}%` }">
        <span class="absolute -top-0 left-1/2 -translate-x-1/2 size-2 rounded-full bg-(--ui-text-highlighted)" />
      </div>
    </div>
    <div class="relative h-5 mt-1">
      <span
        v-for="tk in ticks"
        :key="tk.ts"
        class="absolute -translate-x-1/2 text-[10.5px] uf-num"
        :class="tk.major ? 'text-highlighted font-semibold' : 'text-dimmed'"
        :style="{ left: `${pos(tk.ts)}%` }"
      >{{ tk.label }}</span>
    </div>
  </div>
  <USkeleton v-else class="h-12 w-full" />
</template>
