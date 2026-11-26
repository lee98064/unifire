<script setup lang="ts">
import type { RuleT, RuleInputT, RuleRunT, RuleTriggerT, RuleConditionT, RuleActionT } from '#shared/schemas/automation'
import { actionSpecs, conditionSpecs, triggerSpecs, toneClass } from '~/utils/rules'

const { t } = useI18n()
const api = useApi()
const confirm = useConfirm()
const route = useRoute()
const isNew = computed(() => route.params.id === 'new')

const form = reactive<RuleInputT>({
  name: '', description: null, enabled: true, cooldownSeconds: 60,
  trigger: triggerSpecs['client.connected'].defaults(),
  conditions: [], actions: [actionSpecs.notify.defaults()],
})

const { data: existing } = useFetch<RuleT>(() => `/api/rules/${route.params.id}`, { immediate: !isNew.value, key: `rule-${route.params.id}` })
watch(existing, (r) => {
  if (!r) return
  Object.assign(form, structuredClone(toRaw({ name: r.name, description: r.description, enabled: r.enabled, cooldownSeconds: r.cooldownSeconds, trigger: r.trigger, conditions: r.conditions, actions: r.actions })))
}, { immediate: true })

/* templates */
const templates: Record<string, () => Partial<RuleInputT>> = {
  bedtimeVpn: () => ({ name: t('rules.tpl.bedtimeVpn.title'), trigger: { type: 'schedule', cron: '0 22 * * *', timezone: 'Asia/Taipei' }, actions: [{ type: 'notify', channelIds: [], title: t('rules.tpl.bedtimeVpn.title'), body: '' }] }),
  welcomeHome: () => ({ name: t('rules.tpl.welcomeHome.title'), trigger: { type: 'person.arrived', personId: null }, actions: [{ type: 'webhook', url: 'http://homeassistant.local:8123/api/webhook/unifire-arrived', method: 'POST', headers: {}, body: '{"person":"{{person}}"}' }] }),
  vpnDownNotify: () => ({ name: t('rules.tpl.vpnDownNotify.title'), trigger: { type: 'egress.down', egressId: null }, cooldownSeconds: 600, actions: [{ type: 'notify', channelIds: [], title: '{{egress}} down', body: '{{egress}} is unreachable' }] }),
  newDeviceTelegram: () => ({ name: t('rules.tpl.newDeviceTelegram.title'), trigger: { type: 'client.new' }, actions: [{ type: 'notify', channelIds: [], title: 'New device: {{name}}', body: '{{mac}} · {{vendor}}' }] }),
}
onMounted(() => {
  const tp = route.query.template as string | undefined
  if (isNew.value && tp && templates[tp]) Object.assign(form, templates[tp]!())
})

function setTrigger(type: RuleTriggerT['type']) { form.trigger = triggerSpecs[type].defaults() }
function addCondition(type: RuleConditionT['type']) { form.conditions.push(conditionSpecs[type].defaults()) }
function addAction(type: RuleActionT['type']) { form.actions.push(actionSpecs[type].defaults()) }
function moveAction(i: number, dir: -1 | 1) {
  const j = i + dir
  if (j < 0 || j >= form.actions.length) return
  const a = form.actions
  ;[a[i], a[j]] = [a[j]!, a[i]!]
}

const triggerGroups: { key: string, types: RuleTriggerT['type'][] }[] = [
  { key: 'devices', types: ['client.connected', 'client.disconnected', 'client.new', 'device.offline'] },
  { key: 'people', types: ['person.arrived', 'person.left', 'person.room_entered', 'person.room_left'] },
  { key: 'infra', types: ['infra.offline', 'infra.online', 'infra.rebooted', 'infra.overheat', 'infra.firmware', 'port.issue', 'poe.budget', 'incident.opened'] },
  { key: 'network', types: ['egress.down', 'egress.up', 'egress.ip_changed', 'traffic.threshold'] },
  { key: 'time', types: ['schedule', 'quota.warning', 'quota.exceeded'] },
]

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    const body = structuredClone(toRaw(form))
    if (isNew.value) {
      const r = await api.post<RuleT>('/api/rules', body, { success: t('common.saved') })
      await navigateTo(`/automation/rules/${r.id}`, { replace: true })
    }
    else {
      existing.value = await api.patch<RuleT>(`/api/rules/${route.params.id}`, body, { success: t('common.saved') })
    }
    refreshNuxtData('rules')
  }
  finally { saving.value = false }
}
async function remove() {
  if (!(await confirm({ title: t('rules.deleteConfirm'), color: 'error' }))) return
  await api.del(`/api/rules/${route.params.id}`, undefined, { success: t('common.deleted') })
  refreshNuxtData('rules')
  await navigateTo('/automation/rules')
}
const testResult = ref<RuleRunT | null>(null)
const testing = ref(false)
async function test(dryRun: boolean) {
  testing.value = true
  try { testResult.value = await api.post<RuleRunT>(`/api/rules/${route.params.id}/test`, { dryRun }) }
  finally { testing.value = false }
}
</script>

<template>
  <div class="pb-10">
    <NuxtLink to="/automation/rules" class="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-highlighted mb-3">
      <UIcon name="i-lucide-arrow-left" class="size-3.5" />{{ t('nav.rules') }}
    </NuxtLink>

    <div class="grid xl:grid-cols-[1fr_340px] gap-6 items-start">
      <div class="relative">
        <!-- spine -->
        <div class="absolute left-[19px] top-10 bottom-10 w-px bg-gradient-to-b from-primary/50 via-(--ui-border) to-success/50 hidden sm:block" />

        <!-- WHEN -->
        <section class="relative sm:pl-14 mb-5">
          <span class="hidden sm:flex absolute left-0 top-0 size-10 rounded-full bg-primary text-white items-center justify-center text-[12px] font-bold shadow-(--uf-glow)">{{ t('rules.when') }}</span>
          <div class="uf-card p-5">
            <h2 class="text-[15px] font-semibold text-highlighted mb-1">{{ t('rules.whenTitle') }}</h2>
            <p class="text-[12.5px] text-muted mb-4">{{ t('rules.whenDesc') }}</p>
            <div class="space-y-3 mb-4">
              <div v-for="g in triggerGroups" :key="g.key">
                <div class="uf-section-title mb-1.5">{{ t(`rules.triggerGroup.${g.key}`) }}</div>
                <div class="flex flex-wrap gap-1.5">
                  <button
                    v-for="ty in g.types"
                    :key="ty"
                    type="button"
                    class="inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12.5px] font-medium ring-1 transition"
                    :class="form.trigger.type === ty ? 'bg-primary text-white ring-primary' : 'ring-(--ui-border-muted) text-toned hover:ring-(--ui-border-accented)'"
                    @click="setTrigger(ty)"
                  >
                    <UIcon :name="triggerSpecs[ty].icon" class="size-3.5" />{{ t(`rules.trigger.${ty}`) }}
                  </button>
                </div>
              </div>
            </div>
            <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-4">
              <RuleBlockEditor v-model="form.trigger as any" :fields="triggerSpecs[form.trigger.type].fields" prefix="trigger" />
              <p v-if="!triggerSpecs[form.trigger.type].fields.length" class="text-[12.5px] text-dimmed">{{ t('rules.noParams') }}</p>
            </div>
          </div>
        </section>

        <!-- IF -->
        <section class="relative sm:pl-14 mb-5">
          <span class="hidden sm:flex absolute left-0 top-0 size-10 rounded-full bg-(--uf-surface) ring-1 ring-(--ui-border) text-toned items-center justify-center text-[12px] font-bold">{{ t('rules.if') }}</span>
          <div class="uf-card p-5">
            <div class="flex items-center justify-between mb-3">
              <div>
                <h2 class="text-[15px] font-semibold text-highlighted">{{ t('rules.ifTitle') }}</h2>
                <p class="text-[12.5px] text-muted">{{ t('rules.ifDesc') }}</p>
              </div>
              <UDropdownMenu :items="(Object.keys(conditionSpecs) as RuleConditionT['type'][]).map(ty => ({ label: t(`rules.condition.${ty}`), icon: conditionSpecs[ty].icon, onSelect: () => addCondition(ty) }))">
                <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus">{{ t('rules.addCondition') }}</UButton>
              </UDropdownMenu>
            </div>
            <TransitionGroup tag="div" class="space-y-2" name="uf-list">
              <div v-for="(c, i) in form.conditions" :key="`${c.type}-${i}`" class="rounded-lg ring-1 ring-(--ui-border-muted) p-3">
                <div class="flex items-center gap-2 mb-3">
                  <span class="size-6 rounded-md flex items-center justify-center" :class="toneClass[conditionSpecs[c.type].tone]"><UIcon :name="conditionSpecs[c.type].icon" class="size-3.5" /></span>
                  <span class="text-[13px] font-medium text-highlighted">{{ t(`rules.condition.${c.type}`) }}</span>
                  <span v-if="i > 0" class="text-[11px] font-semibold text-dimmed uppercase">{{ t('rules.and') }}</span>
                  <UButton size="xs" color="error" variant="ghost" icon="i-lucide-x" class="ml-auto" :aria-label="t('common.remove')" @click="form.conditions.splice(i, 1)" />
                </div>
                <RuleBlockEditor v-model="form.conditions[i] as any" :fields="conditionSpecs[c.type].fields" prefix="condition" />
              </div>
            </TransitionGroup>
            <p v-if="!form.conditions.length" class="text-[12.5px] text-dimmed">{{ t('rules.noConditions') }}</p>
          </div>
        </section>

        <!-- THEN -->
        <section class="relative sm:pl-14">
          <span class="hidden sm:flex absolute left-0 top-0 size-10 rounded-full bg-success text-white items-center justify-center text-[12px] font-bold">{{ t('rules.then') }}</span>
          <div class="uf-card p-5">
            <div class="flex items-center justify-between mb-3">
              <div>
                <h2 class="text-[15px] font-semibold text-highlighted">{{ t('rules.thenTitle') }}</h2>
                <p class="text-[12.5px] text-muted">{{ t('rules.thenDesc') }}</p>
              </div>
              <UDropdownMenu :items="(Object.keys(actionSpecs) as RuleActionT['type'][]).map(ty => ({ label: t(`rules.action.${ty}`), icon: actionSpecs[ty].icon, onSelect: () => addAction(ty) }))" :ui="{ content: 'max-h-80' }">
                <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus">{{ t('rules.addAction') }}</UButton>
              </UDropdownMenu>
            </div>
            <TransitionGroup tag="div" class="space-y-2" name="uf-list">
              <div v-for="(a, i) in form.actions" :key="`${a.type}-${i}`" class="rounded-lg ring-1 ring-(--ui-border-muted) p-3">
                <div class="flex items-center gap-2 mb-3">
                  <span class="text-[11px] text-dimmed uf-num w-4">{{ i + 1 }}</span>
                  <span class="size-6 rounded-md flex items-center justify-center" :class="toneClass[actionSpecs[a.type].tone]"><UIcon :name="actionSpecs[a.type].icon" class="size-3.5" /></span>
                  <span class="text-[13px] font-medium text-highlighted">{{ t(`rules.action.${a.type}`) }}</span>
                  <div class="ml-auto flex">
                    <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-chevron-up" :aria-label="t('common.moveUp')" @click="moveAction(i, -1)" />
                    <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-chevron-down" :aria-label="t('common.moveDown')" @click="moveAction(i, 1)" />
                    <UButton size="xs" color="error" variant="ghost" icon="i-lucide-x" :aria-label="t('common.remove')" :disabled="form.actions.length === 1" @click="form.actions.splice(i, 1)" />
                  </div>
                </div>
                <RuleBlockEditor v-model="form.actions[i] as any" :fields="actionSpecs[a.type].fields" prefix="action" />
              </div>
            </TransitionGroup>
          </div>
        </section>
      </div>

      <!-- side panel -->
      <div class="xl:sticky xl:top-20 space-y-4">
        <UCard>
          <div class="space-y-4">
            <UFormField :label="t('rules.name')"><UInput v-model="form.name" class="w-full" :placeholder="t('rules.namePh')" /></UFormField>
            <UFormField :label="t('rules.description')"><UTextarea :model-value="form.description ?? ''" :rows="2" class="w-full" @update:model-value="form.description = $event || null" /></UFormField>
            <UFormField :label="t('rules.cooldown')" :description="t('rules.cooldownHint')">
              <div class="flex items-center gap-2"><UInputNumber v-model="form.cooldownSeconds" :min="0" :step="30" class="flex-1" /><span class="text-[12px] text-dimmed">{{ t('rules.seconds') }}</span></div>
            </UFormField>
            <div class="flex items-center justify-between"><span class="text-[13px] font-medium text-highlighted">{{ t('common.enabled') }}</span><USwitch v-model="form.enabled" /></div>
            <UButton block icon="i-lucide-save" :loading="saving" :disabled="!form.name" @click="save">{{ t('common.save') }}</UButton>
            <UButton v-if="!isNew" block color="error" variant="ghost" icon="i-lucide-trash-2" @click="remove">{{ t('common.delete') }}</UButton>
          </div>
        </UCard>

        <UCard v-if="!isNew">
          <h3 class="text-[13px] font-semibold text-highlighted mb-1">{{ t('rules.testTitle') }}</h3>
          <p class="text-[12px] text-muted mb-3">{{ t('rules.testDesc') }}</p>
          <div class="flex gap-2">
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-flask-conical" :loading="testing" @click="test(true)">{{ t('rules.testDry') }}</UButton>
            <UButton size="sm" color="warning" variant="soft" icon="i-lucide-play" :loading="testing" @click="test(false)">{{ t('rules.testLive') }}</UButton>
          </div>
          <div v-if="testResult" class="mt-3 space-y-1.5">
            <div v-for="(res, i) in testResult.results" :key="i" class="flex items-start gap-2 text-[12px]">
              <UIcon :name="res.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" class="size-4 shrink-0" :class="res.ok ? 'text-success' : 'text-error'" />
              <span class="text-toned"><b>{{ t(`rules.action.${res.action}`) }}</b> {{ res.message }}</span>
            </div>
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>

<style scoped>
.uf-list-move, .uf-list-enter-active, .uf-list-leave-active { transition: all 200ms var(--ease-uf); }
.uf-list-enter-from, .uf-list-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
