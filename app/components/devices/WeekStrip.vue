<script setup lang="ts">
import type { WeeklyWindowT } from '#shared/schemas/common'
import { wallClock } from '#shared/utils/schedule'
import { daySegments } from '~/utils/windows'

/** Seven thin day bars (Mon → Sun) with the "power off" windows shaded and a "now" marker. */
const props = withDefaults(defineProps<{ windows: WeeklyWindowT[], timezone?: string, color?: string, compact?: boolean }>(), { timezone: 'Asia/Taipei', color: 'var(--color-ufamber-500)', compact: false })
const fmt = useFormat()
const now = useClock(60_000)
const segs = computed(() => daySegments(props.windows))
const clock = computed(() => wallClock(now.value.getTime(), props.timezone))
const nowPct = computed(() => ((clock.value.hour * 60 + clock.value.minute) / 1440) * 100)
</script>

<template>
  <div class="space-y-[3px]" role="img">
    <div v-for="(day, d) in segs" :key="d" class="flex items-center gap-2">
      <span class="w-4 text-[10px] text-dimmed text-right shrink-0" :class="clock.day === d ? 'text-primary font-semibold' : ''">{{ fmt.weekday(d, 'narrow') }}</span>
      <div class="relative flex-1 rounded-full bg-success/15 overflow-hidden" :class="compact ? 'h-1.5' : 'h-2'">
        <span
          v-for="(s, k) in day"
          :key="k"
          class="absolute inset-y-0"
          :style="{ left: `${(s.start / 1440) * 100}%`, width: `${((s.end - s.start) / 1440) * 100}%`, background: color }"
        />
        <span v-if="clock.day === d" class="absolute -inset-y-px w-0.5 bg-(--ui-text-highlighted) rounded-full" :style="{ left: `calc(${nowPct}% - 1px)` }" />
      </div>
    </div>
    <div v-if="!compact" class="flex justify-between pl-6 text-[9.5px] text-dimmed uf-num">
      <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
    </div>
  </div>
</template>
