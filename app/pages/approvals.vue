<script setup lang="ts">
import type { ApprovalItemT } from '#shared/schemas/access'
import type { SettingsT } from '#shared/schemas/system'

const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const { data: items, refresh } = useFetch<ApprovalItemT[]>('/api/approvals', { key: 'approvals', default: () => [] })
const { data: settings } = useFetch<SettingsT>('/api/settings', { key: 'settings' })
const { people } = usePeople()

const index = ref(0)
const current = computed(() => items.value[index.value] ?? null)
watch(items, (v) => { if (index.value >= v.length) index.value = Math.max(0, v.length - 1) })

const alias = ref('')
const personId = ref<string | null>(null)
watch(current, (c) => { alias.value = c?.hostname ?? ''; personId.value = null }, { immediate: true })

const leaving = ref<'left' | 'right' | 'down' | null>(null)
const busy = ref(false)
async function decide(decision: 'approve' | 'block' | 'ignore') {
  const c = current.value
  if (!c || busy.value) return
  busy.value = true
  leaving.value = decision === 'approve' ? 'right' : decision === 'block' ? 'left' : 'down'
  try {
    await api.post(`/api/approvals/${c.mac}`, { decision, alias: decision === 'approve' && alias.value ? alias.value : undefined, personId: decision === 'approve' ? personId.value : undefined })
    await new Promise(r => setTimeout(r, 220))
    items.value = items.value.filter(i => i.mac !== c.mac)
    refreshNuxtData(['clients', 'dashboard', 'badges'])
  }
  catch { /* toast shown */ }
  finally { leaving.value = null; busy.value = false; drag.x = 0 }
}

/* keyboard */
onKeyStroke((e) => {
  if ((e.target as HTMLElement)?.closest('input, textarea, [role="combobox"]')) return
  if (e.key === 'a' || e.key === 'A') decide('approve')
  else if (e.key === 'b' || e.key === 'B') decide('block')
  else if (e.key === 'i' || e.key === 'I') decide('ignore')
  else if (e.key === 'ArrowRight') index.value = Math.min(items.value.length - 1, index.value + 1)
  else if (e.key === 'ArrowLeft') index.value = Math.max(0, index.value - 1)
})

/* swipe */
const drag = reactive({ x: 0, startX: 0, active: false })
function onDown(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('input, button, [role="combobox"]')) return
  drag.active = true
  drag.startX = e.clientX
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onMove(e: PointerEvent) { if (drag.active) drag.x = e.clientX - drag.startX }
function onUp() {
  if (!drag.active) return
  drag.active = false
  if (drag.x > 120) decide('approve')
  else if (drag.x < -120) decide('block')
  else drag.x = 0
}
const cardStyle = computed(() => {
  if (leaving.value === 'right') return { transform: 'translateX(120%) rotate(12deg)', opacity: 0 }
  if (leaving.value === 'left') return { transform: 'translateX(-120%) rotate(-12deg)', opacity: 0 }
  if (leaving.value === 'down') return { transform: 'translateY(40%) scale(0.9)', opacity: 0 }
  return { transform: `translateX(${drag.x}px) rotate(${drag.x / 24}deg)` }
})

const vendorIcon = (v: string | null) => {
  const s = (v ?? '').toLowerCase()
  if (/apple|samsung|google|xiaomi|oppo|huawei/.test(s)) return 'i-lucide-smartphone'
  if (/sonos|bose/.test(s)) return 'i-lucide-speaker'
  if (/nintendo|sony|microsoft/.test(s)) return 'i-lucide-gamepad-2'
  if (/espressif|tuya|shelly/.test(s)) return 'i-lucide-cpu'
  if (/synology|qnap/.test(s)) return 'i-lucide-hard-drive'
  if (/intel|dell|lenovo|asus/.test(s)) return 'i-lucide-laptop'
  return 'i-lucide-circle-help'
}
</script>

<template>
  <div>
    <PageHeader :title="t('nav.approvals')" :description="t('approvals.desc')" icon="i-lucide-shield-check">
      <template #actions>
        <NuxtLink to="/settings?tab=general" class="flex items-center gap-2 h-8 px-3 rounded-full ring-1 ring-(--ui-border-muted) bg-(--uf-surface) text-[12.5px]">
          <span class="size-2 rounded-full" :class="settings?.approval.mode === 'strict' ? 'bg-error' : settings?.approval.mode === 'notify' ? 'bg-primary' : 'bg-(--ui-text-dimmed)'" />
          {{ t('approvals.mode') }}: <b class="text-highlighted">{{ t(`approvals.modes.${settings?.approval.mode ?? 'off'}`) }}</b>
        </NuxtLink>
      </template>
    </PageHeader>

    <div v-if="current" class="grid lg:grid-cols-[1fr_300px] gap-6 items-start">
      <div class="relative mx-auto w-full max-w-[520px] pt-3">
        <!-- stacked cards behind -->
        <div v-if="items.length > 2" class="absolute inset-x-8 top-0 h-full uf-card opacity-40 scale-[0.92]" />
        <div v-if="items.length > 1" class="absolute inset-x-4 top-1.5 h-full uf-card opacity-70 scale-[0.96]" />

        <div
          class="relative uf-card shadow-(--uf-shadow-lg) overflow-hidden touch-pan-y select-none"
          :class="drag.active ? '' : 'transition-all duration-300 ease-(--ease-uf)'"
          :style="cardStyle"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
        >
          <!-- swipe hints -->
          <div class="absolute inset-0 pointer-events-none flex items-center justify-between px-6 z-10">
            <span class="px-3 py-1.5 rounded-lg ring-2 ring-error text-error font-bold text-sm rotate-[-12deg] transition-opacity" :style="{ opacity: Math.min(1, -drag.x / 120) }">{{ t('approvals.block') }}</span>
            <span class="px-3 py-1.5 rounded-lg ring-2 ring-success text-success font-bold text-sm rotate-[12deg] transition-opacity" :style="{ opacity: Math.min(1, drag.x / 120) }">{{ t('approvals.approve') }}</span>
          </div>

          <div class="relative h-28 bg-gradient-to-br from-primary/20 via-primary/5 to-vpn/15 uf-grid-bg">
            <div class="absolute left-6 -bottom-9 size-[72px] rounded-2xl bg-(--uf-surface) ring-1 ring-(--ui-border) shadow-(--uf-shadow-lg) flex items-center justify-center">
              <UIcon :name="vendorIcon(current.vendor)" class="size-8 text-primary" />
            </div>
            <div class="absolute right-4 top-4 flex gap-1.5">
              <UBadge v-if="current.quarantined" color="error" variant="solid" size="sm" icon="i-lucide-shield-ban">{{ t('approvals.quarantined') }}</UBadge>
              <UBadge v-if="current.randomizedMac" color="warning" variant="solid" size="sm" icon="i-lucide-shuffle">{{ t('clients.randomized') }}</UBadge>
            </div>
          </div>

          <div class="px-6 pt-12 pb-6">
            <div class="flex items-baseline gap-2">
              <h2 class="text-xl font-semibold text-highlighted truncate">{{ current.hostname ?? current.vendor ?? t('approvals.unknownDevice') }}</h2>
              <span class="text-[12px] text-dimmed uf-num">{{ index + 1 }}/{{ items.length }}</span>
            </div>
            <div class="text-[13px] text-muted">{{ current.vendor ?? t('approvals.unknownVendor') }}</div>

            <dl class="mt-5 grid grid-cols-2 gap-3 text-[12.5px]">
              <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-2.5"><dt class="text-dimmed">MAC</dt><dd><MacText :value="current.mac" copy /></dd></div>
              <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-2.5"><dt class="text-dimmed">IP</dt><dd class="uf-mono text-highlighted">{{ current.ip ?? '—' }}</dd></div>
              <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-2.5"><dt class="text-dimmed">{{ t('clients.network') }}</dt><dd class="text-highlighted">{{ current.networkName ?? '—' }}</dd></div>
              <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-2.5"><dt class="text-dimmed">{{ current.wired ? t('clients.switchPort') : t('approvals.ap') }}</dt><dd class="text-highlighted truncate">{{ current.uplinkName ?? '—' }}{{ current.switchPort ? ` #${current.switchPort}` : '' }}{{ current.ssid ? ` · ${current.ssid}` : '' }}</dd></div>
            </dl>
            <div class="mt-3 text-[12px] text-dimmed flex items-center gap-1.5"><UIcon name="i-lucide-clock" class="size-3.5" />{{ t('approvals.detected') }} <TimeAgo :ts="current.detectedAt" /> · {{ fmt.dateTime(current.detectedAt) }}</div>

            <div class="mt-5 grid sm:grid-cols-2 gap-3">
              <UFormField :label="t('clients.alias')"><UInput v-model="alias" class="w-full" size="sm" /></UFormField>
              <UFormField :label="t('clients.person')">
                <USelectMenu v-model="personId" :items="[{ label: t('clients.noPerson'), value: null }, ...people.map(p => ({ label: `${p.avatar} ${p.name}`, value: p.id }))]" value-key="value" class="w-full" size="sm" />
              </UFormField>
            </div>

            <div class="mt-6 grid grid-cols-3 gap-2">
              <UButton color="error" variant="soft" size="lg" icon="i-lucide-ban" block :disabled="busy" @click="decide('block')">{{ t('approvals.block') }}<UKbd size="sm" class="hidden sm:inline-flex ml-1">B</UKbd></UButton>
              <UButton color="neutral" variant="outline" size="lg" icon="i-lucide-eye-off" block :disabled="busy" @click="decide('ignore')">{{ t('approvals.ignore') }}<UKbd size="sm" class="hidden sm:inline-flex ml-1">I</UKbd></UButton>
              <UButton color="success" size="lg" icon="i-lucide-check" block :disabled="busy" @click="decide('approve')">{{ t('approvals.approve') }}<UKbd size="sm" class="hidden sm:inline-flex ml-1 bg-white/20 text-white ring-white/30">A</UKbd></UButton>
            </div>
            <p class="mt-3 text-center text-[11.5px] text-dimmed lg:hidden">{{ t('approvals.swipeHint') }}</p>
          </div>
        </div>
      </div>

      <!-- queue -->
      <div class="uf-card p-3 hidden lg:block">
        <div class="uf-section-title px-2 pb-2">{{ t('approvals.queue') }} · {{ items.length }}</div>
        <div class="space-y-0.5 max-h-[60vh] overflow-y-auto">
          <button
            v-for="(it, i) in items"
            :key="it.mac"
            type="button"
            class="w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-left transition"
            :class="i === index ? 'bg-primary/10' : 'hover:bg-(--uf-hover)'"
            @click="index = i"
          >
            <UIcon :name="vendorIcon(it.vendor)" class="size-4 text-toned shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="text-[12.5px] font-medium text-highlighted truncate">{{ it.hostname ?? it.vendor ?? it.mac }}</div>
              <div class="text-[11px] text-dimmed"><TimeAgo :ts="it.detectedAt" /></div>
            </div>
            <UIcon v-if="it.quarantined" name="i-lucide-shield-ban" class="size-3.5 text-error" />
          </button>
        </div>
        <div class="mt-3 pt-3 border-t border-(--ui-border-muted) px-2 text-[11.5px] text-dimmed space-y-1">
          <div class="flex justify-between"><span>{{ t('approvals.approve') }}</span><UKbd size="sm">A</UKbd></div>
          <div class="flex justify-between"><span>{{ t('approvals.block') }}</span><UKbd size="sm">B</UKbd></div>
          <div class="flex justify-between"><span>{{ t('approvals.ignore') }}</span><UKbd size="sm">I</UKbd></div>
          <div class="flex justify-between"><span>{{ t('approvals.navigate') }}</span><span><UKbd size="sm">←</UKbd> <UKbd size="sm">→</UKbd></span></div>
        </div>
      </div>
    </div>

    <div v-else class="uf-card">
      <EmptyState icon="i-lucide-shield-check" :title="t('approvals.empty')" :description="t('approvals.emptyDesc')" />
    </div>
  </div>
</template>
