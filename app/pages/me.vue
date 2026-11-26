<script setup lang="ts">
import type { MeSummaryT, QuotaStatusT } from '#shared/schemas/access'

definePageMeta({ layout: 'member' })
const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const { user } = useUserSession()
const { data: me, refresh } = useFetch<MeSummaryT>('/api/me/summary', { key: 'me' })
useIntervalFn(() => refresh(), 60_000)
const live = useLive()
live.on('quota', () => refresh())
live.on('extension.request', () => refresh())

const amount = ref<number>(30)
const reason = ref('')
const sending = ref(false)
const timeQuota = computed(() => me.value?.quotas.find(q => q.metric === 'activeMinutes') ?? null)
async function request() {
  sending.value = true
  try {
    await api.post('/api/me/requests', { quotaId: timeQuota.value?.quotaId ?? null, amount: amount.value, reason: reason.value || undefined }, { success: t('me.requestSent') })
    reason.value = ''
    refresh()
  }
  finally { sending.value = false }
}
const status = computed(() => {
  if (!me.value) return null
  if (me.value.blockedNow) {
    const r = me.value.blockReasons[0]
    return { tone: 'error', icon: r?.source === 'bedtime' ? 'i-lucide-moon-star' : r?.source === 'quota' ? 'i-lucide-hourglass' : 'i-lucide-circle-pause', title: r ? t(`me.blocked.${r.source}`) : t('me.blockedGeneric'), sub: r?.until ? t('me.until', { time: fmt.time(r.until) }) : '' }
  }
  return { tone: 'success', icon: 'i-lucide-wifi', title: t('me.online'), sub: me.value.nextBedtime ? t('me.nextBedtime', { time: fmt.time(me.value.nextBedtime.start) }) : '' }
})
function left(q: QuotaStatusT) { return Math.max(0, q.limit + q.bonus - q.used) }
const pendingReq = computed(() => me.value?.requests.find(r => r.status === 'pending'))
</script>

<template>
  <div v-if="me" class="space-y-5">
    <div class="flex items-center gap-4">
      <PersonAvatar v-if="me.person" :avatar="me.person.avatar" :color="me.person.color" :size="56" />
      <div>
        <p class="text-[13px] text-muted">{{ t('me.hi') }}</p>
        <h1 class="text-2xl font-semibold tracking-tight text-highlighted">{{ me.person?.name ?? user?.displayName }}</h1>
      </div>
    </div>

    <div v-if="status" class="rounded-2xl p-5 flex items-center gap-4 ring-1" :class="status.tone === 'error' ? 'bg-error/8 ring-error/25' : 'bg-success/8 ring-success/25'">
      <span class="size-12 rounded-full flex items-center justify-center text-white" :class="status.tone === 'error' ? 'bg-error' : 'bg-success'"><UIcon :name="status.icon" class="size-6" /></span>
      <div>
        <div class="text-[16px] font-semibold text-highlighted">{{ status.title }}</div>
        <div v-if="status.sub" class="text-[13px] text-muted">{{ status.sub }}</div>
      </div>
    </div>

    <div v-if="me.quotas.length" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div v-for="q in me.quotas" :key="q.quotaId" class="uf-card p-5 flex items-center gap-5">
        <QuotaRing :pct="q.pct" :state="q.state" :size="108" :stroke="10" :label="q.metric === 'activeMinutes' ? fmt.minutes(left(q)) : fmt.bytes(left(q), 1)" :sub="t('me.left')" />
        <div class="min-w-0">
          <div class="text-[14px] font-semibold text-highlighted">{{ q.name }}</div>
          <div class="text-[12.5px] text-muted mt-1">{{ t('me.used', { v: q.metric === 'activeMinutes' ? fmt.minutes(q.used) : fmt.bytes(q.used) }) }}</div>
          <div v-if="q.bonus" class="text-[12px] text-success mt-0.5">+{{ q.metric === 'activeMinutes' ? fmt.minutes(q.bonus) : fmt.bytes(q.bonus) }} {{ t('quotas.bonus') }}</div>
          <div class="text-[11.5px] text-dimmed mt-1">{{ t('people.resets') }} {{ fmt.time(q.resetsAt, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) }}</div>
        </div>
      </div>
    </div>

    <div class="uf-card p-5">
      <h2 class="text-[15px] font-semibold text-highlighted flex items-center gap-2"><UIcon name="i-lucide-hand" class="size-4 text-primary" />{{ t('me.askMore') }}</h2>
      <div v-if="pendingReq" class="mt-3 flex items-center gap-3 p-3 rounded-lg bg-primary/6 ring-1 ring-primary/20">
        <UIcon name="i-lucide-loader-circle" class="size-5 text-primary animate-spin [animation-duration:2s]" />
        <div class="text-[13px] text-toned">{{ t('me.pending', { amount: fmt.minutes(pendingReq.amount) }) }} · <TimeAgo :ts="pendingReq.createdAt" /></div>
      </div>
      <div v-else class="mt-3 space-y-3">
        <DurationPicker v-model="amount" :options="[15, 30, 60, 120]" />
        <UTextarea v-model="reason" :rows="2" class="w-full" :placeholder="t('me.reasonPh')" />
        <UButton block size="lg" icon="i-lucide-send" :loading="sending" @click="request">{{ t('me.send') }}</UButton>
      </div>
      <div v-if="me.requests.filter(r => r.status !== 'pending').length" class="mt-4 pt-3 border-t border-(--ui-border-muted) space-y-1.5">
        <div v-for="r in me.requests.filter(r => r.status !== 'pending').slice(0, 4)" :key="r.id" class="flex items-center gap-2 text-[12.5px]">
          <UIcon :name="r.status === 'approved' ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" class="size-4" :class="r.status === 'approved' ? 'text-success' : 'text-dimmed'" />
          <span class="text-toned">{{ fmt.minutes(r.amount) }} · {{ t(`me.status.${r.status}`) }}</span>
          <span class="ml-auto text-dimmed"><TimeAgo :ts="r.decidedAt ?? r.createdAt" /></span>
        </div>
      </div>
    </div>

    <div class="uf-card p-5">
      <h2 class="text-[15px] font-semibold text-highlighted mb-3">{{ t('me.devices') }}</h2>
      <div class="space-y-2">
        <div v-for="d in me.devices" :key="d.mac" class="flex items-center gap-3 p-2.5 rounded-lg bg-(--uf-surface-2)">
          <span class="relative size-9 rounded-lg bg-(--uf-surface) ring-1 ring-(--ui-border-muted) flex items-center justify-center">
            <UIcon :name="d.wired ? 'i-lucide-monitor' : 'i-lucide-smartphone'" class="size-4 text-toned" />
            <span class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-(--uf-surface-2)" :class="d.online ? 'bg-success' : 'bg-(--color-ufgray-400)'" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="text-[13.5px] font-medium text-highlighted truncate">{{ d.displayName }}</div>
            <div class="text-[11.5px] text-dimmed">{{ t('me.today', { time: fmt.minutes(d.today.activeMinutes), data: fmt.bytes(d.today.bytes) }) }}</div>
          </div>
          <UBadge v-if="d.blocked" color="error" variant="subtle" size="sm">{{ t('clients.blocked') }}</UBadge>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="space-y-4"><USkeleton class="h-16 w-48" /><USkeleton class="h-24 rounded-2xl" /><USkeleton class="h-40 rounded-xl" /></div>
</template>
