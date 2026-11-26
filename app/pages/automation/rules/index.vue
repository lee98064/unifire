<script setup lang="ts">
import type { RuleT, RuleRunT } from '#shared/schemas/automation'
import { actionSpecs, triggerSpecs, toneClass } from '~/utils/rules'

const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const tab = ref<'rules' | 'runs'>('rules')
const { data: rules, refresh } = useFetch<RuleT[]>('/api/rules', { key: 'rules', default: () => [] })
const { data: runs } = useFetch<{ items: RuleRunT[] }>('/api/rules/runs', { key: 'rule-runs', query: { limit: 100 }, default: () => ({ items: [] }) })

async function toggle(r: RuleT, enabled: boolean) {
  await api.patch(`/api/rules/${r.id}`, { enabled })
  refresh()
}

const templates = [
  { key: 'bedtimeVpn', icon: 'i-lucide-moon-star' },
  { key: 'welcomeHome', icon: 'i-lucide-house' },
  { key: 'vpnDownNotify', icon: 'i-lucide-cloud-off' },
  { key: 'newDeviceTelegram', icon: 'i-lucide-send' },
]
</script>

<template>
  <div>
    <PageHeader :title="t('nav.rules')" :description="t('rules.desc')" icon="i-lucide-workflow">
      <template #actions><UButton icon="i-lucide-plus" to="/automation/rules/new">{{ t('rules.add') }}</UButton></template>
    </PageHeader>

    <UTabs v-model="tab" :content="false" variant="link" class="mb-5" :items="[{ value: 'rules', label: t('rules.tabRules'), icon: 'i-lucide-workflow' }, { value: 'runs', label: t('rules.tabRuns'), icon: 'i-lucide-history' }]" />

    <template v-if="tab === 'rules'">
      <div v-if="rules.length" class="grid lg:grid-cols-2 gap-3">
        <NuxtLink v-for="r in rules" :key="r.id" :to="`/automation/rules/${r.id}`" class="uf-card uf-card-hover p-4 flex gap-4 items-start" :class="r.enabled ? '' : 'opacity-60'">
          <span class="size-10 rounded-xl flex items-center justify-center shrink-0" :class="toneClass[triggerSpecs[r.trigger.type].tone]">
            <UIcon :name="triggerSpecs[r.trigger.type].icon" class="size-5" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <h3 class="text-[14.5px] font-semibold text-highlighted truncate">{{ r.name }}</h3>
              <UIcon v-if="r.lastRunOk === false" name="i-lucide-circle-alert" class="size-4 text-error" />
            </div>
            <p class="text-[12.5px] text-muted mt-0.5">
              <span class="font-medium text-toned">{{ t('rules.when') }}</span> {{ t(`rules.trigger.${r.trigger.type}`) }}
              <template v-if="r.conditions.length"> · <span class="font-medium text-toned">{{ t('rules.if') }}</span> {{ t('rules.nConditions', { n: r.conditions.length }) }}</template>
            </p>
            <div class="mt-2.5 flex items-center gap-1.5">
              <span class="text-[11.5px] font-medium text-toned mr-0.5">{{ t('rules.then') }}</span>
              <UTooltip v-for="(a, i) in r.actions" :key="i" :text="t(`rules.action.${a.type}`)">
                <span class="size-6 rounded-md flex items-center justify-center" :class="toneClass[actionSpecs[a.type].tone]"><UIcon :name="actionSpecs[a.type].icon" class="size-3.5" /></span>
              </UTooltip>
              <span class="ml-auto text-[11.5px] text-dimmed">{{ r.runCount }} {{ t('rules.runs') }} · <TimeAgo :ts="r.lastRunAt" /></span>
            </div>
          </div>
          <USwitch :model-value="r.enabled" @click.prevent.stop @update:model-value="toggle(r, $event)" />
        </NuxtLink>
      </div>
      <div v-else class="uf-card p-6">
        <EmptyState icon="i-lucide-workflow" :title="t('rules.empty')" :description="t('rules.emptyDesc')" />
        <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 max-w-4xl mx-auto">
          <NuxtLink v-for="tp in templates" :key="tp.key" :to="`/automation/rules/new?template=${tp.key}`" class="uf-card uf-card-hover p-4">
            <UIcon :name="tp.icon" class="size-5 text-primary" />
            <div class="mt-2 text-[13px] font-semibold text-highlighted">{{ t(`rules.tpl.${tp.key}.title`) }}</div>
            <div class="mt-1 text-[12px] text-muted">{{ t(`rules.tpl.${tp.key}.desc`) }}</div>
          </NuxtLink>
        </div>
      </div>
    </template>

    <UCard v-else :ui="{ body: 'p-0 sm:p-0' }">
      <div v-if="runs.items.length" class="divide-y divide-(--ui-border-muted)">
        <div v-for="run in runs.items" :key="run.id" class="flex items-center gap-3 px-4 sm:px-5 py-3">
          <UIcon :name="run.skipped ? 'i-lucide-skip-forward' : run.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-x'" class="size-4 shrink-0" :class="run.skipped ? 'text-dimmed' : run.ok ? 'text-success' : 'text-error'" />
          <span class="text-[12px] text-dimmed uf-num w-24 shrink-0">{{ fmt.dateTime(run.ts) }}</span>
          <NuxtLink :to="`/automation/rules/${run.ruleId}`" class="text-[13px] font-medium text-highlighted hover:text-primary truncate">{{ run.ruleName }}</NuxtLink>
          <UBadge v-if="run.test" color="neutral" variant="outline" size="xs">{{ t('rules.test') }}</UBadge>
          <UBadge v-if="run.dryRun" color="warning" variant="subtle" size="xs">dry-run</UBadge>
          <span v-if="run.skipped" class="text-[12px] text-dimmed">{{ t(`rules.skipped.${run.skipped}`) }}</span>
          <span v-else class="ml-auto text-[12px] text-dimmed truncate max-w-[40%]">{{ run.results.map(r => r.message ?? r.action).join(' · ') }}</span>
        </div>
      </div>
      <div v-else class="py-10 text-center text-[13px] text-dimmed">{{ t('rules.noRuns') }}</div>
    </UCard>
  </div>
</template>
