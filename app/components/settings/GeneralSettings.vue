<script setup lang="ts">
import type { SettingsT } from '#shared/schemas/system'
import type { UnifiRouteT } from '#shared/schemas/routes'

const settings = defineModel<SettingsT>({ required: true })
const emit = defineEmits<{ save: [] }>()
const { t } = useI18n()
const { data: routes } = useFetch<UnifiRouteT[]>('/api/routes', { key: 'routes', default: () => [] })
const { networks } = useNetworks()

function patch<K extends keyof SettingsT>(k: K, v: SettingsT[K]) { settings.value = { ...settings.value, [k]: v } }
const routeItems = computed(() => routes.value.filter(r => r.ownership !== 'probe' && r.ownership !== 'object' && r.ownership !== 'predefined').map(r => ({ label: r.description || r.id, value: r.id, description: r.suspectedAutomation ? t('routes.suspectedAutomation') : t(`routes.match.${r.matchingTarget}`) })))
const timezones = ['Asia/Taipei', 'Asia/Tokyo', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/Los_Angeles', 'America/New_York', 'UTC']
</script>

<template>
  <div class="space-y-5">
    <!-- Safety: excluded routes -->
    <div class="uf-card p-5 ring-1 ring-error/20">
      <div class="flex items-start gap-3 mb-3">
        <span class="size-9 rounded-lg bg-error/10 text-error flex items-center justify-center shrink-0"><UIcon name="i-lucide-ban" class="size-4" /></span>
        <div>
          <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.general.excluded') }}</h3>
          <p class="text-[12.5px] text-muted">{{ t('settings.general.excludedDesc') }}</p>
        </div>
      </div>
      <USelectMenu :model-value="settings.excludedRouteIds" :items="routeItems" value-key="value" multiple class="w-full" :placeholder="t('settings.general.excludedPh')" @update:model-value="patch('excludedRouteIds', $event)" />
    </div>

    <div class="uf-card p-5 space-y-4">
      <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.general.basics') }}</h3>
      <div class="grid sm:grid-cols-2 gap-4">
        <UFormField :label="t('settings.general.timezone')"><USelectMenu :model-value="settings.timezone" :items="timezones" class="w-full" create-item @update:model-value="patch('timezone', $event)" /></UFormField>
        <UFormField :label="t('settings.general.siteUrl')" :hint="t('settings.general.siteUrlHint')"><UInput :model-value="settings.siteUrl ?? ''" class="w-full uf-mono" placeholder="https://unifire.example.com" @update:model-value="patch('siteUrl', $event || null)" /></UFormField>
      </div>
    </div>

    <div class="uf-card p-5 space-y-4">
      <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.general.approval') }}</h3>
      <URadioGroup :model-value="settings.approval.mode" :items="(['off', 'notify', 'strict'] as const).map(m => ({ value: m, label: t(`approvals.modes.${m}`), description: t(`settings.general.approvalHint.${m}`) }))" @update:model-value="patch('approval', { ...settings.approval, mode: $event as any })" />
      <UCheckbox :model-value="settings.approval.matchRandomizedByHostname" :label="t('settings.general.matchRandomized')" :description="t('settings.general.matchRandomizedHint')" @update:model-value="patch('approval', { ...settings.approval, matchRandomizedByHostname: !!$event })" />
    </div>

    <div class="uf-card p-5 grid sm:grid-cols-3 gap-4">
      <UFormField :label="t('settings.general.presenceGrace')" :description="t('settings.general.presenceGraceHint')">
        <UInputNumber :model-value="settings.presence.graceMinutes" :min="1" :max="120" class="w-full" @update:model-value="patch('presence', { graceMinutes: $event ?? 10 })" />
      </UFormField>
      <UFormField :label="t('settings.general.activeThreshold')" :description="t('settings.general.activeThresholdHint')">
        <div class="flex items-center gap-2"><UInputNumber :model-value="Math.round(settings.usage.activeThresholdBytes / 1024)" :min="1" class="flex-1" @update:model-value="patch('usage', { ...settings.usage, activeThresholdBytes: ($event ?? 50) * 1024 })" /><span class="text-[12px] text-dimmed">KB/min</span></div>
      </UFormField>
      <UFormField :label="t('settings.general.rawRetention')">
        <div class="flex items-center gap-2"><UInputNumber :model-value="settings.usage.retainRawDays" :min="1" :max="90" class="flex-1" @update:model-value="patch('usage', { ...settings.usage, retainRawDays: $event ?? 14 })" /><span class="text-[12px] text-dimmed">{{ t('common.days') }}</span></div>
      </UFormField>
    </div>

    <div class="uf-card p-5 space-y-4">
      <h3 class="text-[14px] font-semibold text-highlighted">{{ t('nav.snapshots') }}</h3>
      <div class="grid sm:grid-cols-3 gap-4">
        <UFormField :label="t('settings.general.snapCron')"><UInput :model-value="settings.snapshots.cron" class="w-full uf-mono" @update:model-value="patch('snapshots', { ...settings.snapshots, cron: $event })" /></UFormField>
        <UFormField :label="t('settings.general.snapRetain')"><div class="flex items-center gap-2"><UInputNumber :model-value="settings.snapshots.retainDays" :min="1" class="flex-1" @update:model-value="patch('snapshots', { ...settings.snapshots, retainDays: $event ?? 90 })" /><span class="text-[12px] text-dimmed">{{ t('common.days') }}</span></div></UFormField>
        <UFormField :label="t('settings.general.preWrite')"><USwitch :model-value="settings.snapshots.preWrite" @update:model-value="patch('snapshots', { ...settings.snapshots, preWrite: $event })" /></UFormField>
      </div>
    </div>

    <div class="uf-card p-5 space-y-4">
      <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.general.host') }}</h3>
      <UFormField :label="t('settings.general.selfMac')" :description="t('settings.general.selfMacHint')"><UInput :model-value="settings.selfMacOverride ?? ''" class="w-full sm:w-72 uf-mono" placeholder="aa:bb:cc:dd:ee:ff" @update:model-value="patch('selfMacOverride', ($event || null) as any)" /></UFormField>
      <div>
        <div class="text-[13px] font-medium text-highlighted mb-1">{{ t('settings.general.broadcasts') }}</div>
        <p class="text-[12px] text-muted mb-2">{{ t('settings.general.broadcastsHint') }}</p>
        <div class="space-y-1.5">
          <div v-for="n in networks.filter(n => n.subnet && (n.purpose === 'corporate' || n.purpose === 'guest'))" :key="n.id" class="grid grid-cols-[1fr_200px] items-center gap-3">
            <span class="text-[12.5px] text-toned">{{ n.name }} <span class="uf-mono text-dimmed">{{ n.subnet }}</span></span>
            <UInput :model-value="settings.broadcastOverrides[n.id] ?? ''" size="sm" class="uf-mono" :placeholder="t('settings.general.auto')" @update:model-value="patch('broadcastOverrides', { ...settings.broadcastOverrides, [n.id]: $event })" />
          </div>
        </div>
      </div>
    </div>

    <div class="flex justify-end sticky bottom-[calc(70px+env(safe-area-inset-bottom))] lg:bottom-4">
      <UButton size="lg" icon="i-lucide-save" class="shadow-(--uf-shadow-lg)" @click="emit('save')">{{ t('common.save') }}</UButton>
    </div>
  </div>
</template>
