<script setup lang="ts">
import type { QuotaT, QuotaStatusT, GroupT, ClientT } from '#shared/schemas/access'

type QuotaRow = QuotaT & { statuses: (QuotaStatusT & { personId: string | null })[] }

const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const confirm = useConfirm()
const { data: quotas, refresh } = useFetch<QuotaRow[]>('/api/quotas', { key: 'quotas', default: () => [] })
const { people, get: getPerson } = usePeople()
const { data: groups } = useFetch<GroupT[]>('/api/groups', { key: 'groups', default: () => [] })
const { data: clients } = useFetch<ClientT[]>('/api/clients', { key: 'clients', default: () => [] })
const { egresses } = useEgresses()

function scopeLabel(q: QuotaT) {
  if (q.scope.type === 'person') { const p = getPerson(q.scope.id); return p ? `${p.avatar} ${p.name}` : '?' }
  if (q.scope.type === 'group') return groups.value.find(g => g.id === q.scope.id)?.name ?? '?'
  return clients.value.find(c => c.mac === q.scope.id)?.displayName ?? q.scope.id
}
function amount(q: { metric: QuotaT['metric'] }, v: number) { return q.metric === 'activeMinutes' ? fmt.minutes(v) : fmt.bytes(v, 1) }

/* editor */
const open = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({
  name: '', scopeType: 'person' as 'person' | 'group' | 'client', scopeId: undefined as string | undefined,
  metric: 'activeMinutes' as QuotaT['metric'], period: 'daily' as QuotaT['period'],
  limitValue: 120, limitUnit: 'min' as 'min' | 'h' | 'MB' | 'GB',
  useWeekday: false, weekday: [120, 120, 120, 120, 180, 240, 240] as number[],
  warnAtPct: 80, actionType: 'block' as 'block' | 'egress' | 'notify', actionEgressId: null as string | null, enabled: true,
})
const unitFactor = { min: 1, h: 60, MB: 1e6, GB: 1e9 }
watch(() => form.metric, (m) => { form.limitUnit = m === 'activeMinutes' ? 'min' : 'GB'; form.limitValue = m === 'activeMinutes' ? 120 : 20 })

function openEditor(q: QuotaT | null) {
  editingId.value = q?.id ?? null
  if (q) {
    const isTime = q.metric === 'activeMinutes'
    const unit = isTime ? (q.limit % 60 === 0 ? 'h' : 'min') : (q.limit >= 1e9 ? 'GB' : 'MB')
    Object.assign(form, {
      name: q.name, scopeType: q.scope.type, scopeId: q.scope.id, metric: q.metric, period: q.period,
      limitUnit: unit, limitValue: q.limit / unitFactor[unit],
      useWeekday: !!q.weekdayLimits, weekday: (q.weekdayLimits ?? Array(7).fill(q.limit)).map(v => (v ?? q.limit) / unitFactor[unit]),
      warnAtPct: q.warnAtPct, actionType: q.action.type, actionEgressId: q.action.type === 'egress' ? q.action.egressId : null, enabled: q.enabled,
    })
  }
  else {
    Object.assign(form, { name: '', scopeType: 'person', scopeId: undefined, metric: 'activeMinutes', period: 'daily', limitValue: 2, limitUnit: 'h', useWeekday: false, weekday: [2, 2, 2, 2, 3, 4, 4], warnAtPct: 80, actionType: 'block', actionEgressId: null, enabled: true })
  }
  open.value = true
}
async function save() {
  const f = unitFactor[form.limitUnit]
  const body = {
    name: form.name,
    scope: { type: form.scopeType, id: form.scopeId },
    metric: form.metric,
    period: form.period,
    limit: form.limitValue * f,
    weekdayLimits: form.useWeekday && form.period === 'daily' ? form.weekday.map(v => v * f) : null,
    warnAtPct: form.warnAtPct,
    action: form.actionType === 'egress' ? { type: 'egress', egressId: form.actionEgressId } : { type: form.actionType },
    enabled: form.enabled,
  }
  if (editingId.value) await api.patch(`/api/quotas/${editingId.value}`, body, { success: t('common.saved') })
  else await api.post('/api/quotas', body, { success: t('common.saved') })
  open.value = false
  refresh()
  refreshNuxtData('people')
}
async function toggle(q: QuotaT, enabled: boolean) {
  await api.patch(`/api/quotas/${q.id}`, { enabled })
  refresh()
}
async function remove() {
  if (!editingId.value || !(await confirm({ title: t('quotas.deleteConfirm'), color: 'error' }))) return
  await api.del(`/api/quotas/${editingId.value}`, undefined, { success: t('common.deleted') })
  open.value = false
  refresh()
}
const scopeItems = computed(() => form.scopeType === 'person'
  ? people.value.map(p => ({ label: `${p.avatar} ${p.name}`, value: p.id }))
  : form.scopeType === 'group' ? groups.value.map(g => ({ label: g.name, value: g.id })) : clients.value.map(c => ({ label: c.displayName, value: c.mac })))
const canSave = computed(() => form.name && form.scopeId && form.limitValue > 0 && (form.actionType !== 'egress' || form.actionEgressId))
</script>

<template>
  <div>
    <PageHeader :title="t('nav.quotas')" :description="t('quotas.desc')" icon="i-lucide-hourglass">
      <template #actions><UButton icon="i-lucide-plus" @click="openEditor(null)">{{ t('quotas.add') }}</UButton></template>
    </PageHeader>

    <div v-if="quotas.length" class="space-y-3">
      <div v-for="q in quotas" :key="q.id" class="uf-card p-4 sm:p-5" :class="q.enabled ? '' : 'opacity-60'">
        <div class="flex flex-wrap items-center gap-3">
          <span class="size-10 rounded-xl flex items-center justify-center" :class="q.metric === 'activeMinutes' ? 'bg-primary/10 text-primary' : 'bg-vpn/10 text-vpn'">
            <UIcon :name="q.metric === 'activeMinutes' ? 'i-lucide-hourglass' : 'i-lucide-hard-drive-download'" class="size-5" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2"><h3 class="text-[14.5px] font-semibold text-highlighted truncate">{{ q.name }}</h3></div>
            <div class="text-[12px] text-dimmed">{{ scopeLabel(q) }} · {{ t(`quotas.period.${q.period}`) }} {{ amount(q, q.limit) }} · {{ t(`quotas.action.${q.action.type}`) }}<template v-if="q.action.type === 'egress'"> → {{ egresses.find(e => e.id === (q.action as any).egressId)?.name }}</template></div>
          </div>
          <USwitch :model-value="q.enabled" @update:model-value="toggle(q, $event)" />
          <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="t('common.edit')" @click="openEditor(q)" />
        </div>
        <div v-if="q.statuses.length" class="mt-4 grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div v-for="s in q.statuses" :key="s.personId ?? s.quotaId" class="flex items-center gap-3 p-2.5 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted)">
            <PersonAvatar v-if="getPerson(s.personId)" :avatar="getPerson(s.personId)!.avatar" :color="getPerson(s.personId)!.color" :size="28" />
            <div class="flex-1 min-w-0">
              <div class="flex justify-between text-[12px] mb-1">
                <span class="text-toned truncate">{{ getPerson(s.personId)?.name ?? scopeLabel(q) }}</span>
                <span class="uf-num" :class="s.state === 'exceeded' ? 'text-error font-semibold' : s.state === 'warning' ? 'text-warning font-semibold' : 'text-dimmed'">{{ amount(q, s.used) }} / {{ amount(q, s.limit + s.bonus) }}</span>
              </div>
              <UProgress :model-value="Math.min(100, s.pct)" size="xs" :color="s.state === 'exceeded' ? 'error' : s.state === 'warning' ? 'warning' : 'primary'" />
              <div v-if="s.bonus" class="text-[10.5px] text-success mt-1">+{{ amount(q, s.bonus) }} {{ t('quotas.bonus') }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="uf-card"><EmptyState icon="i-lucide-hourglass" :title="t('quotas.empty')" :description="t('quotas.emptyDesc')"><UButton icon="i-lucide-plus" @click="openEditor(null)">{{ t('quotas.add') }}</UButton></EmptyState></div>

    <UModal v-model:open="open" :title="editingId ? t('quotas.edit') : t('quotas.add')" :ui="{ content: 'sm:max-w-xl' }">
      <template #body>
        <div class="space-y-5">
          <UFormField :label="t('quotas.name')"><UInput v-model="form.name" class="w-full" :placeholder="t('quotas.namePh')" /></UFormField>
          <div class="grid grid-cols-[auto_1fr] gap-2 items-end">
            <UFormField :label="t('quotas.scope')">
              <USelect v-model="form.scopeType" :items="[{ value: 'person', label: t('quotas.scopeType.person') }, { value: 'group', label: t('quotas.scopeType.group') }, { value: 'client', label: t('quotas.scopeType.client') }]" class="w-32" @update:model-value="form.scopeId = undefined" />
            </UFormField>
            <USelectMenu v-model="form.scopeId" :items="scopeItems" value-key="value" class="w-full" />
          </div>
          <div class="grid grid-cols-2 gap-2 p-1 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted)">
            <button v-for="m in (['activeMinutes', 'bytes'] as const)" :key="m" type="button" class="h-9 rounded-md text-[13px] font-medium flex items-center justify-center gap-2 transition" :class="form.metric === m ? 'bg-(--uf-surface) text-highlighted shadow-(--uf-shadow) ring-1 ring-(--ui-border-muted)' : 'text-muted'" @click="form.metric = m">
              <UIcon :name="m === 'activeMinutes' ? 'i-lucide-hourglass' : 'i-lucide-hard-drive-download'" class="size-4" />{{ t(`quotas.metric.${m}`) }}
            </button>
          </div>
          <p v-if="form.metric === 'activeMinutes'" class="text-[12px] text-muted -mt-3">{{ t('quotas.activeHint') }}</p>
          <div class="grid sm:grid-cols-3 gap-3">
            <UFormField :label="t('quotas.periodLabel')"><USelect v-model="form.period" :items="(['daily', 'weekly', 'monthly'] as const).map(p => ({ value: p, label: t(`quotas.period.${p}`) }))" class="w-full" /></UFormField>
            <UFormField :label="t('quotas.limit')" class="sm:col-span-2">
              <div class="flex gap-2">
                <UInputNumber v-model="form.limitValue" :min="0" :step="form.limitUnit === 'min' ? 15 : 1" class="flex-1" />
                <USelect v-model="form.limitUnit" :items="form.metric === 'activeMinutes' ? ['min', 'h'] : ['MB', 'GB']" class="w-24" />
              </div>
            </UFormField>
          </div>
          <div v-if="form.period === 'daily'">
            <UCheckbox v-model="form.useWeekday" :label="t('quotas.weekday')" />
            <div v-if="form.useWeekday" class="mt-3 grid grid-cols-7 gap-1.5">
              <div v-for="d in 7" :key="d" class="text-center">
                <div class="text-[11px] text-dimmed mb-1">{{ fmt.weekday(d - 1, 'short') }}</div>
                <UInput v-model.number="form.weekday[d - 1]" type="number" size="xs" class="w-full" :ui="{ base: 'text-center' }" />
              </div>
            </div>
          </div>
          <UFormField :label="t('quotas.warnAt')">
            <div class="flex items-center gap-3"><USlider v-model="form.warnAtPct" :min="50" :max="95" :step="5" class="flex-1" /><span class="w-12 text-right text-[13px] font-medium text-highlighted uf-num">{{ form.warnAtPct }}%</span></div>
          </UFormField>
          <UFormField :label="t('quotas.whenExceeded')">
            <URadioGroup v-model="form.actionType" :items="(['block', 'egress', 'notify'] as const).map(a => ({ value: a, label: t(`quotas.action.${a}`), description: t(`quotas.actionHint.${a}`) }))" />
          </UFormField>
          <div v-if="form.actionType === 'egress'"><EgressPicker v-model="form.actionEgressId" :egresses="egresses" compact /></div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton v-if="editingId" color="error" variant="ghost" icon="i-lucide-trash-2" @click="remove">{{ t('common.delete') }}</UButton>
          <UButton class="ml-auto" color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton icon="i-lucide-save" :disabled="!canSave" @click="save">{{ t('common.save') }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
