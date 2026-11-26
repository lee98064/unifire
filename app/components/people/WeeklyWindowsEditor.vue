<script setup lang="ts">
import type { WeeklyWindowT } from '#shared/schemas/common'

const model = defineModel<WeeklyWindowT[]>({ required: true })
const { t } = useI18n()
const fmt = useFormat()

function add() { model.value = [...model.value, { days: [0, 1, 2, 3, 4], start: '22:00', end: '07:00', enabled: true }] }
function update(i: number, patch: Partial<WeeklyWindowT>) { model.value = model.value.map((w, j) => (j === i ? { ...w, ...patch } : w)) }
function remove(i: number) { model.value = model.value.filter((_, j) => j !== i) }
function toggleDay(i: number, d: number) {
  const w = model.value[i]!
  update(i, { days: w.days.includes(d) ? w.days.filter(x => x !== d) : [...w.days, d].sort() })
}
const times = Array.from({ length: 48 }, (_, k) => `${String(Math.floor(k / 2)).padStart(2, '0')}:${k % 2 ? '30' : '00'}`)
</script>

<template>
  <div class="space-y-2">
    <div v-for="(w, i) in model" :key="i" class="flex flex-wrap items-center gap-2 p-2.5 rounded-lg ring-1 ring-(--ui-border-muted) bg-(--uf-surface-2)" :class="w.enabled ? '' : 'opacity-60'">
      <USwitch :model-value="w.enabled" size="sm" @update:model-value="update(i, { enabled: $event })" />
      <div class="flex gap-0.5">
        <button
          v-for="d in 7"
          :key="d"
          type="button"
          class="size-7 rounded-md text-[11px] font-medium transition"
          :class="w.days.includes(d - 1) ? 'bg-primary text-white' : 'text-dimmed hover:bg-(--uf-hover)'"
          @click="toggleDay(i, d - 1)"
        >{{ fmt.weekday(d - 1, 'narrow') }}</button>
      </div>
      <USelect :model-value="w.start" :items="times" size="xs" class="w-20" @update:model-value="update(i, { start: $event as string })" />
      <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed" />
      <USelect :model-value="w.end" :items="times" size="xs" class="w-20" @update:model-value="update(i, { end: $event as string })" />
      <span v-if="w.end <= w.start" class="text-[11px] text-dimmed">{{ t('people.nextDay') }}</span>
      <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" class="ml-auto" :aria-label="t('common.remove')" @click="remove(i)" />
    </div>
    <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus" @click="add">{{ t('people.addWindow') }}</UButton>
  </div>
</template>
