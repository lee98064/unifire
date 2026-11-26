<script setup lang="ts">
import type { PresenceTimelineT } from '#shared/schemas/access'
import type { RoomTimelineT, RoomSegmentT } from '#shared/schemas/infra'

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
const route = useRoute()
const router = useRouter()
const mode = computed<'home' | 'rooms'>({
  get: () => (route.query.mode === 'rooms' ? 'rooms' : 'home'),
  set: v => router.replace({ query: { ...route.query, mode: v === 'home' ? undefined : v } }),
})
const { data: roomData, error: roomError } = useFetch<RoomTimelineT>('/api/presence/rooms', { query: window_, key: 'room-timeline', immediate: true })
const roomById = computed(() => new Map((roomData.value?.rooms ?? []).map(r => [r.id, r])))
const roomColor = (id: string | null) => (id ? roomById.value.get(id)?.color ?? 'var(--color-ufgray-500)' : 'var(--color-ufgray-400)')
const roomName = (id: string | null) => (id ? roomById.value.get(id)?.name ?? '?' : t('rooms.unknownRoom'))
const roomRows = computed(() => people.value.map(p => ({ person: p, segments: roomData.value?.people.find(x => x.personId === p.id)?.segments ?? [] })))
const current = computed(() => new Map((roomData.value?.people ?? []).map(p => [p.personId, p.current])))
const homeMap = computed(() => {
  const rooms = [...(roomData.value?.rooms ?? [])].sort((a, b) => a.order - b.order)
  const inRoom = (rid: string | null) => people.value.filter(p => p.presence.home && (current.value.get(p.id)?.roomId ?? null) === rid && current.value.get(p.id))
  return {
    rooms: rooms.map(r => ({ room: r, people: inRoom(r.id) })),
    unknown: people.value.filter(p => p.presence.home && !(current.value.get(p.id)?.roomId)),
    away: people.value.filter(p => !p.presence.home),
  }
})
const segTip = (s: RoomSegmentT) => `${roomName(s.roomId)} · ${fmt.time(s.start)} – ${s.end ? fmt.time(s.end) : t('presence.now')}`
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
        <UTabs v-model="mode" :content="false" size="sm" :items="[{ value: 'home', label: t('presence.modeHome'), icon: 'i-lucide-house' }, { value: 'rooms', label: t('presence.modeRooms'), icon: 'i-lucide-door-open' }]" />
        <UTabs v-model="range" :content="false" size="sm" :items="[{ value: 'day', label: t('presence.day') }, { value: 'week', label: t('presence.week') }]" @update:model-value="offset = 0" />
        <UButton color="neutral" variant="outline" icon="i-lucide-chevron-left" :aria-label="t('common.previous')" @click="offset++" />
        <UButton color="neutral" variant="outline" icon="i-lucide-chevron-right" :aria-label="t('common.next')" :disabled="offset === 0" @click="offset--" />
      </template>
    </PageHeader>

    <template v-if="mode === 'rooms'">
      <div v-if="roomError" class="uf-card mb-4"><EmptyState icon="i-lucide-door-open" :title="t('rooms.unavailable')" /></div>
      <template v-else>
        <div v-if="!roomData?.rooms.length" class="uf-card mb-4"><EmptyState icon="i-lucide-door-open" :title="t('presence.noRooms')" :description="t('presence.noRoomsDesc')"><UButton to="/settings?tab=rooms" icon="i-lucide-settings">{{ t('presence.setupRooms') }}</UButton></EmptyState></div>
        <template v-else>
          <!-- home map -->
          <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 mb-4">
            <div v-for="m in homeMap.rooms" :key="m.room.id" class="uf-card p-3.5 relative overflow-hidden" :class="m.people.length ? '' : 'opacity-75'">
              <span class="absolute inset-x-0 top-0 h-0.5" :style="{ background: m.room.color ?? undefined }" />
              <div class="flex items-center gap-2 mb-2.5">
                <span class="size-7 rounded-lg flex items-center justify-center" :style="{ background: `color-mix(in oklab, ${m.room.color ?? '#888'} 16%, transparent)`, color: m.room.color ?? undefined }"><UIcon :name="`i-lucide-${m.room.icon ?? 'house'}`" class="size-4" /></span>
                <div class="min-w-0"><div class="text-[13px] font-semibold text-highlighted truncate">{{ m.room.name }}</div><div v-if="m.room.floor" class="text-[10.5px] text-dimmed">{{ m.room.floor }}</div></div>
              </div>
              <div class="flex flex-wrap gap-1.5 min-h-7">
                <UTooltip v-for="p in m.people" :key="p.id" :text="`${p.name} · ${t('presence.since')} ${fmt.time(current.get(p.id)?.since)}`"><PersonAvatar :avatar="p.avatar" :color="p.color" :size="28" /></UTooltip>
                <span v-if="!m.people.length" class="text-[11.5px] text-dimmed self-center">{{ t('presence.emptyRoom') }}</span>
              </div>
            </div>
            <div v-if="homeMap.unknown.length" class="uf-card p-3.5">
              <div class="text-[13px] font-semibold text-toned mb-2.5 flex items-center gap-1.5"><UIcon name="i-lucide-circle-help" class="size-4 text-dimmed" />{{ t('rooms.unknownRoom') }}</div>
              <div class="flex flex-wrap gap-1.5"><PersonAvatar v-for="p in homeMap.unknown" :key="p.id" :avatar="p.avatar" :color="p.color" :size="28" /></div>
            </div>
            <div v-if="homeMap.away.length" class="uf-card p-3.5 bg-(--uf-surface-2)">
              <div class="text-[13px] font-semibold text-toned mb-2.5 flex items-center gap-1.5"><UIcon name="i-lucide-door-closed" class="size-4 text-dimmed" />{{ t('presence.away') }}</div>
              <div class="flex flex-wrap gap-1.5"><PersonAvatar v-for="p in homeMap.away" :key="p.id" :avatar="p.avatar" :color="p.color" :size="28" class="grayscale opacity-70" /></div>
            </div>
          </div>

          <UCard>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-4">
              <span class="text-[13px] font-medium text-highlighted">{{ fmt.date(window_.from) }}<template v-if="range === 'week'"> – {{ fmt.date(window_.to - 1) }}</template></span>
              <span v-for="r in roomData.rooms" :key="r.id" class="flex items-center gap-1.5 text-[11.5px] text-muted"><span class="size-2.5 rounded-sm" :style="{ background: r.color ?? '#888' }" />{{ r.name }}</span>
            </div>
            <div class="grid grid-cols-[150px_1fr] gap-x-4 items-center">
              <span />
              <div class="relative h-5"><span v-for="tk in ticks" :key="tk.label + tk.left" class="absolute -translate-x-1/2 text-[10.5px] text-dimmed uf-num" :style="{ left: `${tk.left}%` }">{{ tk.label }}</span></div>
              <template v-for="r in roomRows" :key="r.person.id">
                <div class="flex items-center gap-2.5 py-2.5 min-w-0">
                  <PersonAvatar :avatar="r.person.avatar" :color="r.person.color" :size="30" :home="r.person.presence.home" />
                  <span class="text-[13px] font-medium text-highlighted truncate">{{ r.person.name }}</span>
                </div>
                <div class="relative h-8 rounded-md bg-(--ui-bg-accented)/60 overflow-hidden">
                  <div v-for="tk in ticks" :key="tk.left" class="absolute inset-y-0 w-px bg-(--ui-border-muted)" :style="{ left: `${tk.left}%` }" />
                  <UTooltip v-for="(s, i) in r.segments" :key="i" :text="segTip(s)">
                    <div class="absolute inset-y-1 rounded-[4px] transition hover:brightness-110" :class="s.roomId ? '' : 'opacity-50'" :style="{ left: `${pos(s.start)}%`, width: `${Math.max(0.3, pos(s.end ?? now.getTime()) - pos(s.start))}%`, background: roomColor(s.roomId) }" />
                  </UTooltip>
                  <div v-if="now.getTime() < window_.to && now.getTime() > window_.from" class="absolute inset-y-0 w-0.5 bg-(--ui-text-highlighted)" :style="{ left: `${pos(now.getTime())}%` }" />
                </div>
              </template>
            </div>
            <p class="mt-4 text-[11.5px] text-dimmed flex items-center gap-1.5"><UIcon name="i-lucide-info" class="size-3.5" />{{ t('presence.roomsHint') }}</p>
          </UCard>
        </template>
      </template>
    </template>

    <UCard v-else>
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
