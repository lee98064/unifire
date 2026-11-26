<script setup lang="ts">
/** PoE watchdog list + editor (rendered as a tab of /devices/poe). */
import type { PoeWatchdogT, PoePortT, WatchdogEventT } from '#shared/schemas/automation'
import type { ClientT } from '#shared/schemas/access'

const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const confirm = useConfirm()
const { data: dogs, refresh } = useFetch<PoeWatchdogT[]>('/api/watchdogs', { key: 'watchdogs', default: () => [] })
const { data: ports } = useFetch<PoePortT[]>('/api/watchdogs/ports', { key: 'poe-ports', default: () => [] })
const { data: clients } = useFetch<ClientT[]>('/api/clients', { key: 'clients', default: () => [] })
useIntervalFn(() => refresh(), 15_000)

const statusUi: Record<string, { color: 'success' | 'warning' | 'error' | 'neutral' | 'secondary', icon: string }> = {
  ok: { color: 'success', icon: 'i-lucide-heart-pulse' },
  failing: { color: 'warning', icon: 'i-lucide-activity' },
  cycling: { color: 'secondary', icon: 'i-lucide-zap' },
  cooldown: { color: 'neutral', icon: 'i-lucide-snowflake' },
  limit: { color: 'error', icon: 'i-lucide-octagon-alert' },
  disabled: { color: 'neutral', icon: 'i-lucide-pause' },
  unknown: { color: 'neutral', icon: 'i-lucide-circle-help' },
}

const statusBg: Record<string, string> = { ok: 'bg-success/10', failing: 'bg-warning/10', cycling: 'bg-vpn/10', cooldown: 'bg-(--uf-hover)', limit: 'bg-error/10', disabled: 'bg-(--uf-hover)', unknown: 'bg-(--uf-hover)' }

/* editor */
const open = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ name: '', targetMac: null as string | null, targetIp: '', method: 'icmp' as 'icmp' | 'tcp', tcpPort: 80 as number | null, intervalSec: 30, failThreshold: 4, cooldownMin: 15, maxCyclesPerDay: 6, port: '' as string, enabled: true })
const poeItems = computed(() => ports.value.filter(p => p.poe && !p.isUplink).map(p => ({
  label: `${p.switchName} · #${p.portIdx} ${p.portName !== `Port ${p.portIdx}` ? p.portName : ''}`,
  value: `${p.switchMac}|${p.portIdx}`,
  description: p.connectedClientName ? `${p.connectedClientName}${p.powerW ? ` · ${p.powerW.toFixed(1)} W` : ''}` : (p.up ? t('watchdogs.portUp') : t('watchdogs.portDown')),
})))
const clientItems = computed(() => clients.value.filter(c => c.wired).map(c => ({ label: c.displayName, value: c.mac, description: `${c.ip ?? ''} · ${c.uplinkName ?? ''} #${c.switchPort ?? ''}` })))
function pickTarget(mac: string) {
  form.targetMac = mac
  const c = clients.value.find(x => x.mac === mac)
  if (!c) return
  if (c.ip) form.targetIp = c.ip
  if (!form.name) form.name = c.displayName
  if (c.uplinkMac && c.switchPort) form.port = `${c.uplinkMac}|${c.switchPort}`
}
function openEditor(d: PoeWatchdogT | null) {
  editingId.value = d?.id ?? null
  Object.assign(form, d
    ? { name: d.name, targetMac: d.targetMac, targetIp: d.targetIp, method: d.method, tcpPort: d.tcpPort, intervalSec: d.intervalSec, failThreshold: d.failThreshold, cooldownMin: d.cooldownMin, maxCyclesPerDay: d.maxCyclesPerDay, port: `${d.switchMac}|${d.portIdx}`, enabled: d.enabled }
    : { name: '', targetMac: null, targetIp: '', method: 'icmp', tcpPort: 80, intervalSec: 30, failThreshold: 4, cooldownMin: 15, maxCyclesPerDay: 6, port: '', enabled: true })
  open.value = true
}
async function save() {
  const [switchMac, portIdx] = form.port.split('|')
  const body = { name: form.name, targetMac: form.targetMac, targetIp: form.targetIp, method: form.method, tcpPort: form.method === 'tcp' ? form.tcpPort : null, intervalSec: form.intervalSec, failThreshold: form.failThreshold, cooldownMin: form.cooldownMin, maxCyclesPerDay: form.maxCyclesPerDay, switchMac, portIdx: Number(portIdx), enabled: form.enabled }
  if (editingId.value) await api.patch(`/api/watchdogs/${editingId.value}`, body, { success: t('common.saved') })
  else await api.post('/api/watchdogs', body, { success: t('common.saved') })
  open.value = false
  refresh()
}
async function remove() {
  if (!editingId.value || !(await confirm({ title: t('watchdogs.deleteConfirm'), color: 'error' }))) return
  await api.del(`/api/watchdogs/${editingId.value}`, undefined, { success: t('common.deleted') })
  open.value = false
  refresh()
}
async function cycleNow(d: PoeWatchdogT) {
  if (!(await confirm({ title: t('watchdogs.cycleConfirm', { name: d.name }), color: 'warning' }))) return
  await api.post(`/api/watchdogs/${d.id}/cycle`, undefined, { success: t('watchdogs.cycled') })
  refresh()
}

const eventsFor = ref<PoeWatchdogT | null>(null)
const { data: events, execute: loadEvents } = useFetch<WatchdogEventT[]>(() => `/api/watchdogs/${eventsFor.value?.id}/events`, { immediate: false, watch: false, default: () => [] })
watch(eventsFor, (v) => { if (v) loadEvents() })
const eventIcon: Record<string, string> = { fail: 'i-lucide-activity', cycle: 'i-lucide-zap', recovered: 'i-lucide-heart-pulse', limit: 'i-lucide-octagon-alert', error: 'i-lucide-circle-x' }
</script>

<template>
  <div>
    <div class="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
      <p class="text-[13px] text-muted flex-1">{{ t('watchdogs.desc') }}</p>
      <UButton icon="i-lucide-plus" class="self-start sm:self-auto" @click="openEditor(null)">{{ t('watchdogs.add') }}</UButton>
    </div>

    <div v-if="dogs.length" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
      <div v-for="d in dogs" :key="d.id" class="uf-card p-5 flex flex-col gap-4" :class="d.enabled ? '' : 'opacity-60'">
        <div class="flex items-start gap-3">
          <span class="relative size-11 rounded-xl flex items-center justify-center shrink-0" :class="statusBg[d.state.status]">
            <UIcon :name="statusUi[d.state.status]!.icon" class="size-5" :class="{ 'text-success': d.state.status === 'ok', 'text-warning': d.state.status === 'failing', 'text-vpn animate-pulse': d.state.status === 'cycling', 'text-error': d.state.status === 'limit', 'text-dimmed': ['cooldown', 'disabled', 'unknown'].includes(d.state.status) }" />
          </span>
          <div class="min-w-0 flex-1">
            <h3 class="text-[14.5px] font-semibold text-highlighted truncate">{{ d.name }}</h3>
            <div class="text-[12px] text-dimmed uf-mono">{{ d.targetIp }}<template v-if="d.method === 'tcp'">:{{ d.tcpPort }}</template> · {{ d.method.toUpperCase() }}</div>
          </div>
          <UBadge :color="statusUi[d.state.status]!.color" variant="subtle" size="sm">{{ t(`watchdogs.status.${d.state.status}`) }}</UBadge>
        </div>

        <!-- failure meter -->
        <div>
          <div class="flex justify-between text-[11.5px] text-dimmed mb-1.5">
            <span>{{ t('watchdogs.fails') }}</span><span class="uf-num">{{ d.state.consecutiveFails }}/{{ d.failThreshold }}</span>
          </div>
          <div class="flex gap-1">
            <span v-for="i in d.failThreshold" :key="i" class="h-1.5 flex-1 rounded-full transition-colors" :class="i <= d.state.consecutiveFails ? (d.state.consecutiveFails >= d.failThreshold ? 'bg-error' : 'bg-warning') : 'bg-(--ui-bg-accented)'" />
          </div>
        </div>

        <dl class="grid grid-cols-3 gap-2 text-[12px]">
          <div><dt class="text-dimmed">{{ t('watchdogs.port') }}</dt><dd class="text-toned truncate">{{ d.switchName ?? '—' }} #{{ d.portIdx }}</dd></div>
          <div><dt class="text-dimmed">{{ t('watchdogs.latency') }}</dt><dd class="text-toned uf-num">{{ fmt.ms(d.state.lastLatencyMs) }}</dd></div>
          <div><dt class="text-dimmed">{{ t('watchdogs.today') }}</dt><dd class="text-toned uf-num">{{ d.state.cyclesToday }}/{{ d.maxCyclesPerDay }}</dd></div>
        </dl>

        <div class="flex items-center gap-2 text-[11.5px] text-dimmed">
          <span>{{ t('watchdogs.lastOk') }} <TimeAgo :ts="d.state.lastOkAt" /></span>
          <span v-if="d.state.lastCycleAt">· {{ t('watchdogs.lastCycle') }} <TimeAgo :ts="d.state.lastCycleAt" /></span>
        </div>

        <div class="flex gap-2 mt-auto">
          <UButton size="sm" color="warning" variant="soft" icon="i-lucide-zap" @click="cycleNow(d)">{{ t('watchdogs.cycleNow') }}</UButton>
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-list" @click="eventsFor = d">{{ t('watchdogs.events') }}</UButton>
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-pencil" class="ml-auto" :aria-label="t('common.edit')" @click="openEditor(d)" />
        </div>
      </div>
    </div>
    <div v-else class="uf-card"><EmptyState icon="i-lucide-plug-zap" :title="t('watchdogs.empty')" :description="t('watchdogs.emptyDesc')"><UButton icon="i-lucide-plus" @click="openEditor(null)">{{ t('watchdogs.add') }}</UButton></EmptyState></div>

    <UModal v-model:open="open" :title="editingId ? t('watchdogs.edit') : t('watchdogs.add')" :ui="{ content: 'sm:max-w-xl' }">
      <template #body>
        <div class="space-y-4">
          <UFormField :label="t('watchdogs.target')" :hint="t('watchdogs.targetHint')">
            <USelectMenu :model-value="form.targetMac ?? undefined" :items="clientItems" value-key="value" class="w-full" @update:model-value="pickTarget" />
          </UFormField>
          <div class="grid sm:grid-cols-2 gap-3">
            <UFormField :label="t('watchdogs.name')"><UInput v-model="form.name" class="w-full" /></UFormField>
            <UFormField :label="t('watchdogs.ip')"><UInput v-model="form.targetIp" class="w-full uf-mono" /></UFormField>
          </div>
          <UFormField :label="t('watchdogs.poePort')" :description="t('watchdogs.poePortHint')">
            <USelectMenu v-model="form.port" :items="poeItems" value-key="value" class="w-full" />
          </UFormField>
          <div class="grid grid-cols-2 gap-3">
            <UFormField :label="t('watchdogs.method')"><USelect v-model="form.method" :items="[{ value: 'icmp', label: 'ICMP ping' }, { value: 'tcp', label: 'TCP connect' }]" class="w-full" /></UFormField>
            <UFormField v-if="form.method === 'tcp'" :label="t('watchdogs.tcpPort')"><UInputNumber v-model="form.tcpPort" :min="1" :max="65535" class="w-full" /></UFormField>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <UFormField :label="t('watchdogs.interval')"><UInputNumber v-model="form.intervalSec" :min="10" :step="10" class="w-full" /></UFormField>
            <UFormField :label="t('watchdogs.threshold')"><UInputNumber v-model="form.failThreshold" :min="1" :max="60" class="w-full" /></UFormField>
            <UFormField :label="t('watchdogs.cooldown')"><UInputNumber v-model="form.cooldownMin" :min="1" class="w-full" /></UFormField>
            <UFormField :label="t('watchdogs.maxPerDay')"><UInputNumber v-model="form.maxCyclesPerDay" :min="1" :max="48" class="w-full" /></UFormField>
          </div>
          <p class="text-[12px] text-muted bg-(--uf-surface-2) rounded-md px-3 py-2 ring-1 ring-(--ui-border-muted)">{{ t('watchdogs.summary', { n: form.failThreshold, s: form.intervalSec * form.failThreshold, c: form.cooldownMin, m: form.maxCyclesPerDay }) }}</p>
          <div class="flex items-center justify-between"><span class="text-[13px] font-medium text-highlighted">{{ t('common.enabled') }}</span><USwitch v-model="form.enabled" /></div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton v-if="editingId" color="error" variant="ghost" icon="i-lucide-trash-2" @click="remove">{{ t('common.delete') }}</UButton>
          <UButton class="ml-auto" color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton icon="i-lucide-save" :disabled="!form.name || !form.targetIp || !form.port" @click="save">{{ t('common.save') }}</UButton>
        </div>
      </template>
    </UModal>

    <USlideover :open="!!eventsFor" :title="eventsFor?.name" :description="t('watchdogs.events')" @update:open="v => { if (!v) eventsFor = null }">
      <template #body>
        <div v-if="events.length" class="space-y-3">
          <div v-for="ev in events" :key="ev.id" class="flex gap-3">
            <UIcon :name="eventIcon[ev.kind] ?? 'i-lucide-dot'" class="size-4 mt-0.5" :class="ev.kind === 'recovered' ? 'text-success' : ev.kind === 'cycle' ? 'text-vpn' : ev.kind === 'fail' ? 'text-warning' : 'text-error'" />
            <div>
              <div class="text-[13px] text-highlighted">{{ ev.message }}</div>
              <div class="text-[11.5px] text-dimmed">{{ fmt.dateTime(ev.ts) }}</div>
            </div>
          </div>
        </div>
        <p v-else class="text-[13px] text-dimmed text-center py-8">{{ t('watchdogs.noEvents') }}</p>
      </template>
    </USlideover>
  </div>
</template>
