<script setup lang="ts">
import type { WolTargetT } from '#shared/schemas/automation'
import type { ClientT } from '#shared/schemas/access'

const { t } = useI18n()
const api = useApi()
const { data: targets, refresh } = useFetch<WolTargetT[]>('/api/wol', { key: 'wol', default: () => [] })
const { data: clients } = useFetch<ClientT[]>('/api/clients', { key: 'clients', default: () => [] })

const waking = ref<string | null>(null)
async function wake(w: WolTargetT) {
  waking.value = w.id
  try {
    await api.post(`/api/wol/${w.id}/wake`, undefined, { success: t('wol.sent', { name: w.name }) })
    setTimeout(refresh, 20_000)
  }
  finally { setTimeout(() => (waking.value = null), 1200) }
}

const open = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ name: '', mac: '', broadcast: '' as string, port: 9, scheduled: false, cron: '0 8 * * 1-5', timezone: 'Asia/Taipei' })
function openEditor(w: WolTargetT | null) {
  editingId.value = w?.id ?? null
  Object.assign(form, w
    ? { name: w.name, mac: w.mac, broadcast: w.broadcast ?? '', port: w.port, scheduled: !!w.schedule, cron: w.schedule?.cron ?? '0 8 * * 1-5', timezone: w.schedule?.timezone ?? 'Asia/Taipei' }
    : { name: '', mac: '', broadcast: '', port: 9, scheduled: false, cron: '0 8 * * 1-5', timezone: 'Asia/Taipei' })
  open.value = true
}
function pick(mac: string) {
  form.mac = mac
  const c = clients.value.find(x => x.mac === mac)
  if (c && !form.name) form.name = c.displayName
}
async function save() {
  const body = { name: form.name, mac: form.mac, broadcast: form.broadcast || null, port: form.port, schedule: form.scheduled ? { cron: form.cron, timezone: form.timezone } : null }
  if (editingId.value) await api.patch(`/api/wol/${editingId.value}`, body, { success: t('common.saved') })
  else await api.post('/api/wol', body, { success: t('common.saved') })
  open.value = false
  refresh()
}
async function remove() {
  if (!editingId.value) return
  await api.del(`/api/wol/${editingId.value}`, undefined, { success: t('common.deleted') })
  open.value = false
  refresh()
}
</script>

<template>
  <div>
    <PageHeader :title="t('nav.wol')" :description="t('wol.desc')" icon="i-lucide-power">
      <template #actions><UButton icon="i-lucide-plus" @click="openEditor(null)">{{ t('wol.add') }}</UButton></template>
    </PageHeader>

    <UAlert color="info" variant="subtle" icon="i-lucide-info" :description="t('wol.vlanNote')" class="mb-4" />

    <div v-if="targets.length" class="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <div v-for="w in targets" :key="w.id" class="uf-card p-5 flex flex-col items-center text-center">
        <button
          type="button"
          class="relative size-20 rounded-full flex items-center justify-center transition-all duration-300 ring-1"
          :class="w.online ? 'bg-success/12 text-success ring-success/30' : 'bg-(--uf-surface-2) text-toned ring-(--ui-border) hover:text-primary hover:ring-primary/40 hover:shadow-(--uf-glow)'"
          :aria-label="t('wol.wake')"
          @click="wake(w)"
        >
          <span v-if="waking === w.id" class="absolute inset-0 rounded-full ring-4 ring-primary/40 animate-ping" />
          <UIcon name="i-lucide-power" class="size-8" />
        </button>
        <h3 class="mt-4 text-[14.5px] font-semibold text-highlighted">{{ w.name }}</h3>
        <div class="text-[12px] text-dimmed uf-mono">{{ w.mac }}</div>
        <div class="mt-2 flex items-center gap-1.5 text-[12px]">
          <StatusDot :status="w.online ? 'online' : 'offline'" :size="7" />
          <span :class="w.online ? 'text-success' : 'text-dimmed'">{{ w.online == null ? t('wol.unknown') : w.online ? t('clients.online') : t('clients.offline') }}</span>
        </div>
        <div class="mt-3 text-[11.5px] text-dimmed space-y-0.5">
          <div>→ <span class="uf-mono">{{ w.effectiveBroadcast ?? '—' }}:{{ w.port }}</span></div>
          <div v-if="w.schedule" class="flex items-center justify-center gap-1"><UIcon name="i-lucide-alarm-clock" class="size-3" /><span class="uf-mono">{{ w.schedule.cron }}</span></div>
          <div v-if="w.lastWokeAt">{{ t('wol.lastWoke') }} <TimeAgo :ts="w.lastWokeAt" /></div>
        </div>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" class="mt-3" @click="openEditor(w)">{{ t('common.edit') }}</UButton>
      </div>
    </div>
    <div v-else class="uf-card"><EmptyState icon="i-lucide-power" :title="t('wol.empty')" :description="t('wol.emptyDesc')"><UButton icon="i-lucide-plus" @click="openEditor(null)">{{ t('wol.add') }}</UButton></EmptyState></div>

    <UModal v-model:open="open" :title="editingId ? t('wol.edit') : t('wol.add')">
      <template #body>
        <div class="space-y-4">
          <UFormField :label="t('wol.device')">
            <USelectMenu :model-value="form.mac || undefined" :items="clients.map(c => ({ label: c.displayName, value: c.mac, description: `${c.mac} · ${c.networkName ?? ''}` }))" value-key="value" class="w-full" @update:model-value="pick" />
          </UFormField>
          <div class="grid grid-cols-2 gap-3">
            <UFormField :label="t('wol.name')"><UInput v-model="form.name" class="w-full" /></UFormField>
            <UFormField label="MAC"><UInput v-model="form.mac" class="w-full uf-mono" /></UFormField>
            <UFormField :label="t('wol.broadcast')" :hint="t('wol.broadcastHint')"><UInput v-model="form.broadcast" class="w-full uf-mono" placeholder="192.168.1.255" /></UFormField>
            <UFormField :label="t('wol.port')"><UInputNumber v-model="form.port" :min="1" :max="65535" class="w-full" /></UFormField>
          </div>
          <div class="flex items-center justify-between"><span class="text-[13px] font-medium text-highlighted">{{ t('wol.schedule') }}</span><USwitch v-model="form.scheduled" /></div>
          <UFormField v-if="form.scheduled" :label="t('rules.field.cron')" :hint="t('rules.cronHint')"><UInput v-model="form.cron" class="w-full uf-mono" /></UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton v-if="editingId" color="error" variant="ghost" icon="i-lucide-trash-2" @click="remove">{{ t('common.delete') }}</UButton>
          <UButton class="ml-auto" color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton icon="i-lucide-save" :disabled="!form.name || !form.mac" @click="save">{{ t('common.save') }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
