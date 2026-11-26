<script setup lang="ts">
import type { WeeklyWindowT } from '#shared/schemas/common'
import type { PoeOverviewT, PoeScheduleT, PortViewT } from '#shared/schemas/infra'
import { hoursPerWeek, upcomingWindows } from '~/utils/windows'

/** Create / edit a PoE schedule: pick a port, paint the weekly "power off" windows, preview 48 h, see the savings. */
const props = defineProps<{
  schedule: PoeScheduleT | null
  port: { switchMac: string, portIdx: number } | null
  switches: PoeOverviewT['switches']
  timezone: string
  rate: number | null
  currency: string
  qualified: boolean
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const confirm = useConfirm()

const form = reactive({
  name: '',
  key: '' as string, // "<switchMac>|<idx>"
  offWindows: [] as WeeklyWindowT[],
  mode: 'preview' as 'preview' | 'active',
  enabled: true,
  acknowledgedAp: false,
})
watch(open, (v) => {
  if (!v) return
  const s = props.schedule
  const p = s ? { switchMac: s.switchMac, portIdx: s.portIdx } : props.port
  Object.assign(form, {
    name: s?.name ?? '',
    key: p ? `${p.switchMac}|${p.portIdx}` : '',
    offWindows: s ? structuredClone(toRaw(s.offWindows)) : [{ days: [0, 1, 2, 3, 4, 5, 6], start: '23:00', end: '07:00', enabled: true }],
    mode: s?.mode ?? 'preview',
    enabled: s?.enabled ?? true,
    acknowledgedAp: s?.acknowledgedAp ?? false,
  })
  if (!s && p) form.name = defaultName(findPort(form.key))
}, { immediate: true })

function findPort(key: string): { sw: PoeOverviewT['switches'][number], port: PortViewT } | null {
  const [mac, idx] = key.split('|')
  const sw = props.switches.find(s => s.mac === mac)
  const port = sw?.ports.find(p => p.idx === Number(idx))
  return sw && port ? { sw, port } : null
}
function defaultName(hit: ReturnType<typeof findPort>) {
  if (!hit) return ''
  return hit.port.peer?.name ?? hit.port.name ?? `${hit.sw.name} #${hit.port.idx}`
}
const selected = computed(() => findPort(form.key))
watch(() => form.key, (k, old) => {
  if (!props.schedule && (!form.name || form.name === defaultName(findPort(old ?? '')))) form.name = defaultName(findPort(k))
})

const portItems = computed(() => props.switches.flatMap(sw => sw.ports.filter(p => p.poe?.capable).map(p => ({
  label: `${sw.name} · #${p.idx}${p.peer?.name ? ` · ${p.peer.name}` : ''}`,
  value: `${sw.mac}|${p.idx}`,
  description: !p.poeSafety.allowed ? t('poe.notAllowed') : p.poe?.powerW ? `${p.poe.powerW.toFixed(1)} W` : undefined,
  disabled: !p.poeSafety.allowed && !(props.schedule && props.schedule.switchMac === sw.mac && props.schedule.portIdx === p.idx),
}))))

const safety = computed(() => selected.value?.port.poeSafety ?? null)
const blockingReasons = computed(() => (safety.value?.reasons ?? []).filter(r => r !== 'powers_ap'))
const needsAck = computed(() => !!safety.value?.requiresAck)
const offHours = computed(() => hoursPerWeek(form.offWindows))
const watts = computed(() => selected.value?.port.poe?.powerW ?? props.schedule?.savings.avgW ?? null)
const monthKwh = computed(() => (watts.value ? (watts.value * offHours.value * 30) / 7 / 1000 : null))
const monthCost = computed(() => (monthKwh.value != null && props.rate != null ? monthKwh.value * props.rate : null))
const preview = computed(() => upcomingWindows(form.offWindows, props.timezone, Date.now(), 48))
const previewStart = computed(() => Math.floor(Date.now() / 300_000) * 300_000)
const canSave = computed(() => !!form.name && !!selected.value && form.offWindows.some(w => w.enabled && w.days.length) && !blockingReasons.value.length && (!needsAck.value || form.acknowledgedAp))

const saving = ref(false)
async function save() {
  const hit = selected.value
  if (!hit) return
  saving.value = true
  try {
    const body = { name: form.name, switchMac: hit.sw.mac, portIdx: hit.port.idx, offWindows: form.offWindows, timezone: props.timezone, mode: form.mode, enabled: form.enabled, acknowledgedAp: form.acknowledgedAp }
    if (props.schedule) await api.patch(`/api/poe/schedules/${props.schedule.id}`, body, { success: t('common.saved') })
    else await api.post('/api/poe/schedules', body, { success: t('common.saved') })
    open.value = false
    emit('saved')
  }
  finally { saving.value = false }
}
async function remove() {
  const s = props.schedule
  if (!s || !(await confirm({ title: t('poe.deleteConfirm', { name: s.name }), description: s.state.actual === 'off' ? t('poe.deleteRestores') : undefined, color: 'error' }))) return
  await api.del(`/api/poe/schedules/${s.id}`, undefined, { success: t('common.deleted') })
  open.value = false
  emit('saved')
}
async function override(on: boolean, minutes: number | null) {
  const hit = selected.value
  if (!hit) return
  await api.post('/api/poe/override', { action: 'set', switchMac: hit.sw.mac, portIdx: hit.port.idx, on, minutes, acknowledgedAp: form.acknowledgedAp }, { success: on ? t('poe.overrideOnDone') : t('poe.overrideOffDone', { m: minutes ? fmt.minutes(minutes) : t('common.indefinitely') }) })
  emit('saved')
}
</script>

<template>
  <USlideover v-model:open="open" :title="schedule ? t('poe.editSchedule') : t('poe.newSchedule')" :description="t('poe.editorDesc')" :ui="{ content: 'sm:max-w-xl' }">
    <template #body>
      <div class="space-y-5">
        <UFormField :label="t('poe.port')">
          <USelectMenu v-model="form.key" :items="portItems" value-key="value" class="w-full" :disabled="!!schedule" />
        </UFormField>

        <div v-if="selected" class="rounded-lg ring-1 ring-(--ui-border-muted) bg-(--uf-surface-2) p-3 flex items-center gap-3">
          <span class="size-9 rounded-lg flex items-center justify-center shrink-0" :class="(selected.port.poe?.powerW ?? 0) > 0 ? 'bg-warning/15 text-warning' : 'bg-(--uf-hover) text-dimmed'"><UIcon name="i-lucide-zap" class="size-4.5" /></span>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium text-highlighted truncate">{{ selected.port.peer?.name ?? t('ports.unknownPeer') }}</div>
            <div class="text-[12px] text-dimmed">{{ selected.sw.name }} · {{ t('ports.port', { n: selected.port.idx }) }}<template v-if="selected.port.poe?.poeClass"> · {{ selected.port.poe.poeClass }}</template></div>
          </div>
          <div class="text-right">
            <div class="text-[14px] font-semibold uf-num text-highlighted">{{ selected.port.poe?.mode === 'off' ? t('ports.poeOffShort') : `${(selected.port.poe?.powerW ?? 0).toFixed(1)} W` }}</div>
            <div class="text-[11px] text-dimmed">{{ t('poe.now') }}</div>
          </div>
        </div>

        <UAlert v-for="r in blockingReasons" :key="r" color="error" variant="subtle" icon="i-lucide-shield-x" :title="t(`poe.safety.${r}`)" :description="t(`poe.safetyDesc.${r}`)" />
        <div v-if="needsAck" class="rounded-lg ring-1 ring-warning/40 bg-warning/8 p-3 space-y-2">
          <div class="flex items-start gap-2 text-[13px] text-highlighted"><UIcon name="i-lucide-wifi-off" class="size-4 text-warning mt-0.5 shrink-0" />{{ t('poe.apWarning') }}</div>
          <UCheckbox v-model="form.acknowledgedAp" :label="t('poe.apAck')" />
        </div>

        <UFormField :label="t('poe.name')"><UInput v-model="form.name" class="w-full" /></UFormField>

        <div>
          <div class="text-[13px] font-medium text-highlighted mb-1">{{ t('poe.offWindows') }}</div>
          <p class="text-[12px] text-muted mb-2">{{ t('poe.offWindowsHint') }}</p>
          <WeeklyWindowsEditor v-model="form.offWindows" />
        </div>

        <div class="rounded-lg ring-1 ring-(--ui-border-muted) p-3">
          <div class="flex items-center justify-between mb-2.5">
            <span class="text-[12.5px] font-medium text-highlighted">{{ t('poe.preview48') }}</span>
            <span class="text-[11.5px] text-dimmed uf-num">{{ t('poe.offPerWeek', { h: offHours.toFixed(1) }) }}</span>
          </div>
          <div class="relative h-5 rounded-md bg-success/15 overflow-hidden">
            <span v-for="(w, k) in preview" :key="k" class="absolute inset-y-0 bg-warning/80" :style="{ left: `${((w.start - previewStart) / (48 * 3_600_000)) * 100}%`, width: `${((w.end - w.start) / (48 * 3_600_000)) * 100}%` }" />
            <span v-for="h in [24]" :key="h" class="absolute inset-y-0 w-px bg-(--ui-border-accented)" :style="{ left: '50%' }" />
          </div>
          <div class="flex justify-between text-[10.5px] text-dimmed mt-1 uf-num">
            <span>{{ t('poe.nowShort') }}</span><span>+24h</span><span>+48h</span>
          </div>
          <div v-if="preview.length" class="mt-2 text-[12px] text-toned space-y-0.5">
            <div v-for="(w, k) in preview.slice(0, 3)" :key="k" class="flex items-center gap-2 uf-num">
              <UIcon name="i-lucide-zap-off" class="size-3 text-warning" />{{ fmt.dateTime(w.start) }} → {{ fmt.time(w.end) }}<span class="text-dimmed">({{ fmt.duration(w.end - w.start) }})</span>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-lg bg-success/8 ring-1 ring-success/25 p-3">
            <div class="text-[11.5px] text-success font-medium flex items-center gap-1"><UIcon name="i-lucide-leaf" class="size-3.5" />{{ t('poe.savesMonth') }}</div>
            <div class="mt-1 text-lg font-semibold uf-num text-highlighted">{{ monthKwh == null ? '—' : `${monthKwh.toFixed(1)} kWh` }}</div>
          </div>
          <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3">
            <div class="text-[11.5px] text-dimmed">{{ t('poe.savesCost') }}</div>
            <div class="mt-1 text-lg font-semibold uf-num text-highlighted">{{ monthCost == null ? '—' : `${currency} ${monthCost.toFixed(0)}` }}</div>
            <NuxtLink v-if="rate == null" to="/devices/poe?tab=energy" class="text-[11px] text-primary hover:underline" @click="open = false">{{ t('poe.setRate') }}</NuxtLink>
          </div>
        </div>

        <UFormField :label="t('poe.mode')">
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="m in (['preview', 'active'] as const)"
              :key="m"
              type="button"
              class="text-left rounded-lg ring-1 p-3 transition"
              :class="form.mode === m ? 'ring-primary bg-primary/5' : 'ring-(--ui-border-muted) hover:ring-(--ui-border-accented)'"
              @click="form.mode = m"
            >
              <div class="flex items-center gap-1.5 text-[13px] font-medium text-highlighted"><UIcon :name="m === 'preview' ? 'i-lucide-eye' : 'i-lucide-play'" class="size-3.5" />{{ t(`poe.modes.${m}`) }}</div>
              <div class="text-[11.5px] text-muted mt-0.5">{{ t(`poe.modesDesc.${m}`) }}</div>
            </button>
          </div>
        </UFormField>
        <UAlert v-if="form.mode === 'active' && !qualified" color="warning" variant="subtle" icon="i-lucide-shield-question" :title="t('poe.notQualifiedShort')" :description="t('poe.notQualifiedEditor')" />

        <div class="flex items-center justify-between"><span class="text-[13px] font-medium text-highlighted">{{ t('common.enabled') }}</span><USwitch v-model="form.enabled" /></div>

        <div v-if="selected && selected.port.poeSafety.allowed" class="pt-4 border-t border-(--ui-border-muted)">
          <div class="text-[13px] font-medium text-highlighted mb-2">{{ t('poe.quick') }}</div>
          <div class="flex flex-wrap gap-2">
            <UButton v-for="m in [30, 60, 120]" :key="m" size="sm" color="warning" variant="soft" icon="i-lucide-zap-off" :disabled="needsAck && !form.acknowledgedAp" @click="override(false, m)">{{ t('poe.offFor', { m: fmt.minutes(m) }) }}</UButton>
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-zap" @click="override(true, 60)">{{ t('poe.powerOnHour') }}</UButton>
          </div>
          <p class="text-[11.5px] text-dimmed mt-2">{{ t('poe.quickHint') }}</p>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full gap-2">
        <UButton v-if="schedule" color="error" variant="ghost" icon="i-lucide-trash-2" @click="remove">{{ t('common.delete') }}</UButton>
        <UButton class="ml-auto" color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
        <UButton icon="i-lucide-save" :loading="saving" :disabled="!canSave" @click="save">{{ t('common.save') }}</UButton>
      </div>
    </template>
  </USlideover>
</template>
