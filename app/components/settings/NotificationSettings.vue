<script setup lang="ts">
import type { NotificationChannelT, NotificationEventT, ChannelTypeT } from '#shared/schemas/system'

const { t } = useI18n()
const msg = useMsg()
const api = useApi()
const confirm = useConfirm()
const push = usePush()
const toast = useToast()
const { data: channels, refresh } = useFetch<NotificationChannelT[]>('/api/notifications/channels', { key: 'channels', default: () => [] })

const allEvents: NotificationEventT[] = ['new_device', 'route_switch', 'route_drift', 'egress_down', 'egress_up', 'egress_ip_changed', 'quota_warning', 'quota_exceeded', 'extension_request', 'poe_cycle', 'external_change', 'guest_wifi_rotated', 'controller_error', 'rule']
const typeMeta: Record<ChannelTypeT, { icon: string, color: string }> = {
  webpush: { icon: 'i-lucide-bell-ring', color: '#006FFF' },
  telegram: { icon: 'i-lucide-send', color: '#229ED9' },
  discord: { icon: 'i-lucide-message-circle', color: '#5865F2' },
  webhook: { icon: 'i-lucide-webhook', color: '#8E59FF' },
  ntfy: { icon: 'i-lucide-megaphone', color: '#38CC65' },
}

async function enablePush() {
  try {
    await push.subscribe()
    toast.add({ title: t('settings.notify.pushOn'), color: 'success', icon: 'i-lucide-bell-ring' })
    if (!channels.value.some(c => c.config.type === 'webpush')) {
      await api.post('/api/notifications/channels', { name: 'Web Push', enabled: true, config: { type: 'webpush' }, events: ['new_device', 'egress_down', 'quota_exceeded', 'extension_request', 'route_drift', 'controller_error', 'rule'] })
      refresh()
    }
  }
  catch (e) {
    toast.add({ title: t('settings.notify.pushFailed'), description: String((e as Error).message), color: 'error' })
  }
}

/* editor */
const open = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ name: '', enabled: true, type: 'telegram' as ChannelTypeT, botToken: '', chatId: '', interactive: true, webhookUrl: '', url: '', method: 'POST' as 'POST' | 'PUT', secret: '', server: 'https://ntfy.sh', topic: '', token: '', events: [...allEvents] as NotificationEventT[] })
function openEditor(c: NotificationChannelT | null, type?: ChannelTypeT) {
  editingId.value = c?.id ?? null
  const cfg = (c?.config ?? { type: type ?? 'telegram' }) as Record<string, any>
  Object.assign(form, {
    name: c?.name ?? t(`settings.notify.type.${cfg.type}`), enabled: c?.enabled ?? true, type: cfg.type,
    botToken: cfg.botToken ?? '', chatId: cfg.chatId ?? '', interactive: cfg.interactive ?? true, webhookUrl: cfg.webhookUrl ?? '',
    url: cfg.url ?? '', method: cfg.method ?? 'POST', secret: cfg.secret ?? '', server: cfg.server ?? 'https://ntfy.sh', topic: cfg.topic ?? '', token: cfg.token ?? '',
    events: c?.events ?? [...allEvents],
  })
  open.value = true
}
function buildConfig() {
  switch (form.type) {
    case 'telegram': return { type: 'telegram', botToken: form.botToken, chatId: form.chatId, interactive: form.interactive }
    case 'discord': return { type: 'discord', webhookUrl: form.webhookUrl }
    case 'webhook': return { type: 'webhook', url: form.url, method: form.method, secret: form.secret || null }
    case 'ntfy': return { type: 'ntfy', server: form.server, topic: form.topic, token: form.token || null }
    default: return { type: 'webpush' }
  }
}
async function save() {
  const body = { name: form.name, enabled: form.enabled, config: buildConfig(), events: form.events }
  if (editingId.value) await api.patch(`/api/notifications/channels/${editingId.value}`, body, { success: t('common.saved') })
  else await api.post('/api/notifications/channels', body, { success: t('common.saved') })
  open.value = false
  refresh()
}
async function test(c: NotificationChannelT) { await api.post(`/api/notifications/channels/${c.id}/test`, undefined, { success: t('settings.notify.testSent') }); refresh() }
async function remove() {
  if (!editingId.value || !(await confirm({ title: t('settings.notify.deleteConfirm'), color: 'error' }))) return
  await api.del(`/api/notifications/channels/${editingId.value}`, undefined, { success: t('common.deleted') })
  open.value = false
  refresh()
}
async function toggle(c: NotificationChannelT, enabled: boolean) { await api.patch(`/api/notifications/channels/${c.id}`, { enabled }); refresh() }
</script>

<template>
  <div class="space-y-5">
    <!-- This device -->
    <div class="uf-card p-5 flex flex-wrap items-center gap-4">
      <span class="size-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center"><UIcon name="i-lucide-smartphone" class="size-5" /></span>
      <div class="flex-1 min-w-0">
        <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.notify.thisDevice') }}</h3>
        <p class="text-[12.5px] text-muted">
          <template v-if="!push.secure.value">{{ t('settings.notify.needHttps') }}</template>
          <template v-else-if="!push.supported.value">{{ t('settings.notify.unsupported') }}</template>
          <template v-else-if="push.permission.value === 'denied'">{{ t('settings.notify.denied') }}</template>
          <template v-else>{{ push.subscribed.value ? t('settings.notify.subscribed') : t('settings.notify.notSubscribed') }}</template>
        </p>
      </div>
      <UButton v-if="push.subscribed.value" color="neutral" variant="outline" icon="i-lucide-bell-off" @click="push.unsubscribe()">{{ t('settings.notify.disable') }}</UButton>
      <UButton v-else icon="i-lucide-bell-ring" :disabled="!push.supported.value || !push.secure.value || push.permission.value === 'denied'" @click="enablePush">{{ t('settings.notify.enable') }}</UButton>
    </div>

    <div class="uf-card p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.notify.channels') }}</h3>
          <p class="text-[12.5px] text-muted">{{ t('settings.notify.channelsDesc') }}</p>
        </div>
        <UDropdownMenu :items="(['telegram', 'discord', 'ntfy', 'webhook'] as const).map(ty => ({ label: t(`settings.notify.type.${ty}`), icon: typeMeta[ty].icon, onSelect: () => openEditor(null, ty) }))">
          <UButton size="sm" icon="i-lucide-plus">{{ t('settings.notify.add') }}</UButton>
        </UDropdownMenu>
      </div>
      <div v-if="channels.length" class="space-y-2">
        <div v-for="c in channels" :key="c.id" class="flex items-center gap-3 p-3 rounded-lg ring-1 ring-(--ui-border-muted)">
          <span class="size-9 rounded-lg flex items-center justify-center text-white" :style="{ background: typeMeta[c.config.type].color }"><UIcon :name="typeMeta[c.config.type].icon" class="size-4" /></span>
          <div class="min-w-0 flex-1">
            <div class="text-[13.5px] font-medium text-highlighted">{{ c.name }}</div>
            <div class="text-[11.5px] text-dimmed truncate">
              {{ t('settings.notify.eventsN', { n: c.events.length }) }}
              <template v-if="c.lastError"> · <span class="text-error">{{ msg(c.lastError) }}</span></template>
              <template v-else-if="c.lastSentAt"> · {{ t('settings.notify.lastSent') }} <TimeAgo :ts="c.lastSentAt" /></template>
            </div>
          </div>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-send" @click="test(c)">{{ t('settings.notify.test') }}</UButton>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="t('common.edit')" @click="openEditor(c)" />
          <USwitch :model-value="c.enabled" @update:model-value="toggle(c, $event)" />
        </div>
      </div>
      <EmptyState v-else icon="i-lucide-bell" :title="t('settings.notify.empty')" />
    </div>

    <UModal v-model:open="open" :title="editingId ? t('settings.notify.edit') : t('settings.notify.add')" :ui="{ content: 'sm:max-w-xl' }">
      <template #body>
        <div class="space-y-4">
          <UFormField :label="t('settings.notify.name')"><UInput v-model="form.name" class="w-full" /></UFormField>
          <template v-if="form.type === 'telegram'">
            <UFormField label="Bot token" :hint="t('settings.notify.secretHint')"><UInput v-model="form.botToken" class="w-full uf-mono" type="password" placeholder="123456:ABC-…" /></UFormField>
            <UFormField label="Chat ID"><UInput v-model="form.chatId" class="w-full uf-mono" /></UFormField>
            <UCheckbox v-model="form.interactive" :label="t('settings.notify.interactive')" :description="t('settings.notify.interactiveHint')" />
          </template>
          <UFormField v-else-if="form.type === 'discord'" label="Webhook URL" :hint="t('settings.notify.secretHint')"><UInput v-model="form.webhookUrl" class="w-full uf-mono" type="password" /></UFormField>
          <template v-else-if="form.type === 'webhook'">
            <div class="grid grid-cols-[1fr_100px] gap-2">
              <UFormField label="URL"><UInput v-model="form.url" class="w-full uf-mono" /></UFormField>
              <UFormField :label="t('rules.field.method')"><USelect v-model="form.method" :items="['POST', 'PUT']" class="w-full" /></UFormField>
            </div>
            <UFormField :label="t('settings.notify.hmac')" :hint="t('settings.notify.hmacHint')"><UInput v-model="form.secret" class="w-full uf-mono" type="password" /></UFormField>
          </template>
          <template v-else-if="form.type === 'ntfy'">
            <div class="grid grid-cols-2 gap-2">
              <UFormField label="Server"><UInput v-model="form.server" class="w-full uf-mono" /></UFormField>
              <UFormField label="Topic"><UInput v-model="form.topic" class="w-full uf-mono" /></UFormField>
            </div>
            <UFormField label="Access token" :hint="t('settings.notify.optional')"><UInput v-model="form.token" class="w-full uf-mono" type="password" /></UFormField>
          </template>
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-[13px] font-medium text-highlighted">{{ t('settings.notify.events') }}</span>
              <div class="flex gap-1">
                <UButton size="xs" color="neutral" variant="ghost" @click="form.events = [...allEvents]">{{ t('common.all') }}</UButton>
                <UButton size="xs" color="neutral" variant="ghost" @click="form.events = []">{{ t('common.none') }}</UButton>
              </div>
            </div>
            <div class="grid sm:grid-cols-2 gap-1.5">
              <UCheckbox v-for="ev in allEvents" :key="ev" :model-value="form.events.includes(ev)" :label="t(`settings.notify.ev.${ev}`)" @update:model-value="form.events = $event ? [...form.events, ev] : form.events.filter(x => x !== ev)" />
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton v-if="editingId" color="error" variant="ghost" icon="i-lucide-trash-2" @click="remove">{{ t('common.delete') }}</UButton>
          <UButton class="ml-auto" color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton icon="i-lucide-save" @click="save">{{ t('common.save') }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
