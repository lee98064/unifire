<script setup lang="ts">
import type { PresenceTimelineT } from '#shared/schemas/access'

const { t } = useI18n()
const fmt = useFormat()
const { people, get: getPerson } = usePeople()
const range = ref<'day' | 'week'>('day')
const offset = ref(0) // days/weeks back

const window_ = computed(() => {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range.value === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - offset.value * 7)
  else start.setDate(start.getDate() - offset.value)
  const from = start.getTime()
  const to = from + (range.value === 'week' ? 7 : 1) * 86400_000
  return { from, to }
})
const { data, status } = useFetch<PresenceTimelineT>('/api/presence/timeline', { query: window_, key: 'presence-timeline' })
const now = useClock(60_000)
const pos = (ts: number) => Math.max(0, Math.min(100, ((ts - window_.value.from) / (window_.value.to - window_.value.from)) * 100))
const ticks = computed(() => {
  const out: { left: number, label: string }[] = []
  if (range.value === 'day') for (let h = 0; h <= 24; h += 3) out.push({ left: (h / 24) * 100, label: `${String(h).padStart(2, '0')}` })
  else for (let d = 0; d < 7; d++) out.push({ left: (d / 7) * 100, label: fmt.weekday(d) })
  return out
})
const rows = computed(() => people.value.map(p => ({ person: p, sessions: data.value?.people.find(x => x.personId === p.id)?.sessions ?? [] })))
function homeMinutes(sessions: { start: number, end: number | null }[]) {
  return sessions.reduce((acc, s) => acc + (Math.min(s.end ?? now.value.getTime(), window_.value.to) - Math.max(s.start, window_.value.from)) / 60000, 0)
}
</script>

<template>
  <div>
    <PageHeader :title="t('nav.presence')" :description="t('presence.desc')" icon="i-lucide-house">
      <template #actions>
        <UTabs v-model="range" :content="false" size="sm" :items="[{ value: 'day', label: t('presence.day') }, { value: 'week', label: t('presence.week') }]" @update:model-value="offset = 0" />
        <UButton color="neutral" variant="outline" icon="i-lucide-chevron-left" :aria-label="t('common.previous')" @click="offset++" />
        <UButton color="neutral" variant="outline" icon="i-lucide-chevron-right" :aria-label="t('common.next')" :disabled="offset === 0" @click="offset--" />
      </template>
    </PageHeader>

    <UCard>
      <div class="text-[13px] font-medium text-highlighted mb-4">{{ fmt.date(window_.from) }}<template v-if="range === 'week'"> – {{ fmt.date(window_.to - 1) }}</template></div>
      <div class="grid grid-cols-[150px_1fr_80px] gap-x-4 items-center">
        <span />
        <div class="relative h-5">
          <span v-for="tk in ticks" :key="tk.label + tk.left" class="absolute -translate-x-1/2 text-[10.5px] text-dimmed uf-num" :style="{ left: `${tk.left}%` }">{{ tk.label }}</span>
        </div>
        <span class="text-[10.5px] text-dimmed text-right">{{ t('presence.atHome') }}</span>

        <template v-for="r in rows" :key="r.person.id">
          <div class="flex items-center gap-2.5 py-2.5 min-w-0">
            <PersonAvatar :avatar="r.person.avatar" :color="r.person.color" :size="30" :home="r.person.presence.home" />
            <span class="text-[13px] font-medium text-highlighted truncate">{{ r.person.name }}</span>
          </div>
          <div class="relative h-8 rounded-md bg-(--ui-bg-accented)/60 overflow-hidden">
            <div v-for="tk in ticks" :key="tk.left" class="absolute inset-y-0 w-px bg-(--ui-border-muted)" :style="{ left: `${tk.left}%` }" />
            <UTooltip v-for="(s, i) in r.sessions" :key="i" :text="`${fmt.dateTime(s.start)} – ${s.end ? fmt.time(s.end) : t('presence.now')}`">
              <div
                class="absolute inset-y-1 rounded-[5px] shadow-sm transition hover:brightness-110"
                :style="{ left: `${pos(s.start)}%`, width: `${Math.max(0.4, pos(s.end ?? now.getTime()) - pos(s.start))}%`, background: r.person.color }"
              />
            </UTooltip>
            <div v-if="now.getTime() < window_.to && now.getTime() > window_.from" class="absolute inset-y-0 w-0.5 bg-(--ui-text-highlighted)" :style="{ left: `${pos(now.getTime())}%` }" />
          </div>
          <span class="text-[12px] text-toned text-right uf-num">{{ fmt.minutes(homeMinutes(r.sessions)) }}</span>
        </template>
      </div>
      <div v-if="!people.length && status !== 'pending'" class="py-8"><EmptyState icon="i-lucide-house" :title="t('presence.empty')" :description="t('presence.emptyDesc')" /></div>
      <p class="mt-4 text-[11.5px] text-dimmed flex items-center gap-1.5"><UIcon name="i-lucide-info" class="size-3.5" />{{ t('presence.hint') }}</p>
    </UCard>
  </div>
</template>
