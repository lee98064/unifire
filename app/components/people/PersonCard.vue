<script setup lang="ts">
import type { PersonT, QuotaStatusT } from '#shared/schemas/access'

const props = defineProps<{ person: PersonT }>()
const emit = defineEmits<{ edit: [] }>()
const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const now = useNow({ interval: 30_000 })
const { data: quotas } = useFetch<QuotaStatusT[]>(() => `/api/people/${props.person.id}/quotas`, { key: `person-quotas-${props.person.id}`, default: () => [] })

const pauseOpen = ref(false)
const pauseMinutes = ref<number | null>(60)
async function pause() {
  await api.post(`/api/people/${props.person.id}/pause`, { minutes: pauseMinutes.value }, { success: t('people.pausedToast', { name: props.person.name }) })
  pauseOpen.value = false
  refreshNuxtData(['people'])
}
async function resume() {
  await api.post(`/api/people/${props.person.id}/resume`, undefined, { success: t('people.resumedToast', { name: props.person.name }) })
  refreshNuxtData(['people'])
}
async function allow(minutes: number) {
  await api.post(`/api/people/${props.person.id}/allow`, { minutes }, { success: t('people.allowedToast', { name: props.person.name, m: minutes }) })
  refreshNuxtData(['people'])
}
function quotaLabel(q: QuotaStatusT) {
  return q.metric === 'activeMinutes' ? fmt.minutes(Math.max(0, q.limit + q.bonus - q.used)) : fmt.bytes(Math.max(0, q.limit + q.bonus - q.used), 0)
}
const allowanceActive = computed(() => props.person.allowanceUntil && props.person.allowanceUntil > now.value.getTime())
</script>

<template>
  <div class="uf-card uf-card-hover p-5 flex flex-col gap-4 relative overflow-hidden">
    <div v-if="person.pause.active" class="absolute inset-x-0 top-0 h-1 bg-[repeating-linear-gradient(135deg,var(--color-ufamber-500)_0_8px,transparent_8px_16px)]" />
    <div class="flex items-start gap-3">
      <PersonAvatar :avatar="person.avatar" :color="person.color" :size="48" :home="person.presence.home" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <h3 class="text-[15px] font-semibold text-highlighted truncate">{{ person.name }}</h3>
          <UBadge v-if="person.pause.active" color="warning" variant="subtle" size="sm" icon="i-lucide-circle-pause">{{ t('people.paused') }}</UBadge>
          <UBadge v-else-if="allowanceActive" color="success" variant="subtle" size="sm" icon="i-lucide-gift">{{ t('people.allowance') }}</UBadge>
        </div>
        <div class="text-[12px] text-dimmed mt-0.5">
          {{ person.presence.home ? t('people.homeSince') : t('people.awaySince') }} <TimeAgo :ts="person.presence.since" />
          · {{ t('dashboard.devicesN', { n: person.deviceMacs.length }) }}
        </div>
      </div>
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="t('common.edit')" @click="emit('edit')" />
    </div>

    <div v-if="quotas.length" class="flex gap-4">
      <div v-for="q in quotas.slice(0, 3)" :key="q.quotaId" class="flex items-center gap-2.5 min-w-0">
        <QuotaRing :pct="q.pct" :state="q.state" :size="54" :stroke="6" :label="`${Math.round(q.pct)}%`" />
        <div class="min-w-0">
          <div class="text-[12px] font-medium text-highlighted truncate">{{ q.name }}</div>
          <div class="text-[11px] text-dimmed">{{ t('people.left', { v: quotaLabel(q) }) }}</div>
          <div class="text-[10.5px] text-dimmed">{{ t('people.resets') }} {{ fmt.time(q.resetsAt, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) }}</div>
        </div>
      </div>
    </div>
    <div v-else class="text-[12px] text-dimmed flex items-center gap-1.5"><UIcon name="i-lucide-infinity" class="size-3.5" />{{ t('people.noQuota') }}</div>

    <div v-if="person.pause.active" class="text-[12px] text-warning bg-warning/8 rounded-md px-2.5 py-1.5 flex items-center gap-1.5">
      <UIcon name="i-lucide-timer" class="size-3.5" />
      {{ person.pause.until ? t('people.pausedUntil', { time: fmt.time(person.pause.until) }) : t('people.pausedIndef') }}
    </div>
    <div v-else-if="person.bedtime.filter(b => b.enabled).length" class="text-[12px] text-dimmed flex items-center gap-1.5">
      <UIcon name="i-lucide-moon-star" class="size-3.5" />
      {{ person.bedtime.filter(b => b.enabled).map(b => `${b.start}–${b.end}`).join(' · ') }}
    </div>

    <div class="flex gap-2 mt-auto">
      <UButton v-if="person.pause.active" block color="success" variant="soft" icon="i-lucide-play" @click="resume">{{ t('people.resume') }}</UButton>
      <UPopover v-else v-model:open="pauseOpen">
        <UButton block color="warning" variant="soft" icon="i-lucide-circle-pause" class="flex-1">{{ t('people.pause') }}</UButton>
        <template #content>
          <div class="p-3 w-72 space-y-3">
            <div class="text-[13px] font-medium text-highlighted">{{ t('people.pauseFor', { name: person.name }) }}</div>
            <DurationPicker v-model="pauseMinutes" :options="[15, 30, 60, 120, null]" />
            <UButton block color="warning" icon="i-lucide-circle-pause" @click="pause">{{ t('people.pauseNow') }}</UButton>
          </div>
        </template>
      </UPopover>
      <UDropdownMenu :items="[[{ label: t('people.allow30'), icon: 'i-lucide-gift', onSelect: () => allow(30) }, { label: t('people.allow60'), icon: 'i-lucide-gift', onSelect: () => allow(60) }]]">
        <UButton color="neutral" variant="outline" icon="i-lucide-gift" :aria-label="t('people.allowance')" />
      </UDropdownMenu>
    </div>
  </div>
</template>
