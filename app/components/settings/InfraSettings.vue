<script setup lang="ts">
import type { SettingsT } from '#shared/schemas/system'

/** Phase 2 thresholds: device health, port guard, incidents, sticky clients, electricity price, retention. */
const settings = defineModel<SettingsT>({ required: true })
const emit = defineEmits<{ save: [] }>()
const { t } = useI18n()
const { get: device } = useDevices()

function patch<K extends 'infra' | 'energy' | 'sticky' | 'incidents'>(k: K, v: Partial<SettingsT[K]>) {
  settings.value = { ...settings.value, [k]: { ...settings.value[k], ...v } }
}
const stickyMbps = computed({
  get: () => Math.round((settings.value.sticky?.skipAboveBps ?? 0) / 1e6 * 10) / 10,
  set: v => patch('sticky', { skipAboveBps: Math.round((v ?? 0) * 1e6) }),
})
function unignore(i: number) {
  patch('infra', { ignoredPorts: settings.value.infra.ignoredPorts.filter((_, j) => j !== i) })
}
</script>

<template>
  <div v-if="settings.infra" class="space-y-5">
    <div class="uf-card p-5 space-y-4">
      <div>
        <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.infra.health') }}</h3>
        <p class="text-[12.5px] text-muted">{{ t('settings.infra.healthDesc') }}</p>
      </div>
      <div class="grid sm:grid-cols-3 gap-4">
        <UFormField :label="t('settings.infra.tempWarn')"><UInputNumber :model-value="settings.infra.tempWarnC" :min="30" :max="120" class="w-full" @update:model-value="patch('infra', { tempWarnC: $event ?? 80 })" /></UFormField>
        <UFormField :label="t('settings.infra.cpuWarn')"><UInputNumber :model-value="settings.infra.cpuWarnPct" :min="10" :max="100" class="w-full" @update:model-value="patch('infra', { cpuWarnPct: $event ?? 90 })" /></UFormField>
        <UFormField :label="t('settings.infra.memWarn')"><UInputNumber :model-value="settings.infra.memWarnPct" :min="10" :max="100" class="w-full" @update:model-value="patch('infra', { memWarnPct: $event ?? 90 })" /></UFormField>
      </div>
    </div>

    <div class="uf-card p-5 space-y-4">
      <div>
        <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.infra.ports') }}</h3>
        <p class="text-[12.5px] text-muted">{{ t('settings.infra.portsDesc') }}</p>
      </div>
      <div class="grid sm:grid-cols-3 gap-4">
        <UFormField :label="t('settings.infra.errorRate')" :hint="'%'"><UInputNumber :model-value="settings.infra.errorRatePct" :min="0.001" :max="100" :step="0.01" :format-options="{ maximumFractionDigits: 3 }" class="w-full" @update:model-value="patch('infra', { errorRatePct: $event ?? 0.1 })" /></UFormField>
        <UFormField :label="t('settings.infra.flaps')"><UInputNumber :model-value="settings.infra.flapsPerHour" :min="2" :max="100" class="w-full" @update:model-value="patch('infra', { flapsPerHour: $event ?? 4 })" /></UFormField>
        <UFormField :label="t('settings.infra.downgradePolls')" :hint="t('settings.infra.downgradePollsHint')"><UInputNumber :model-value="settings.infra.downgradeMinPolls" :min="1" :max="30" class="w-full" @update:model-value="patch('infra', { downgradeMinPolls: $event ?? 3 })" /></UFormField>
      </div>
      <div>
        <div class="text-[12.5px] font-medium text-highlighted mb-1.5">{{ t('settings.infra.ignored') }}</div>
        <div v-if="settings.infra.ignoredPorts.length" class="flex flex-wrap gap-1.5">
          <span v-for="(p, i) in settings.infra.ignoredPorts" :key="`${p.switchMac}-${p.portIdx}`" class="flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full ring-1 ring-(--ui-border-muted) text-[12px] text-toned">
            {{ device(p.switchMac)?.name ?? p.switchMac }} #{{ p.portIdx }}
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="t('common.remove')" @click="unignore(i)" />
          </span>
        </div>
        <p v-else class="text-[12px] text-dimmed">{{ t('settings.infra.ignoredNone') }}</p>
      </div>
    </div>

    <div class="uf-card p-5 space-y-4">
      <div>
        <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.infra.incidents') }}</h3>
        <p class="text-[12.5px] text-muted">{{ t('settings.infra.incidentsDesc') }}</p>
      </div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <UFormField :label="t('settings.infra.window')" :hint="t('rules.minutesUnit')"><UInputNumber :model-value="settings.incidents.windowMinutes" :min="1" :max="60" class="w-full" @update:model-value="patch('incidents', { windowMinutes: $event ?? 10 })" /></UFormField>
        <UFormField :label="t('settings.infra.quiet')" :hint="t('rules.minutesUnit')"><UInputNumber :model-value="settings.incidents.quietMinutes" :min="1" :max="60" class="w-full" @update:model-value="patch('incidents', { quietMinutes: $event ?? 5 })" /></UFormField>
        <UFormField :label="t('settings.infra.notifyFrom')">
          <USelect :model-value="settings.incidents.notifyMinSeverity" :items="[{ value: 'warning', label: t('incidents.severity.warning') }, { value: 'critical', label: t('incidents.severity.critical') }, { value: 'off', label: t('settings.infra.never') }]" class="w-full" @update:model-value="patch('incidents', { notifyMinSeverity: $event as SettingsT['incidents']['notifyMinSeverity'] })" />
        </UFormField>
        <UFormField :label="t('settings.infra.massMin')"><UInputNumber :model-value="settings.incidents.massDisconnectMin" :min="2" :max="100" class="w-full" @update:model-value="patch('incidents', { massDisconnectMin: $event ?? 5 })" /></UFormField>
        <UFormField :label="t('settings.infra.massPct')" hint="%"><UInputNumber :model-value="settings.incidents.massDisconnectPct" :min="5" :max="100" class="w-full" @update:model-value="patch('incidents', { massDisconnectPct: $event ?? 30 })" /></UFormField>
      </div>
    </div>

    <div class="uf-card p-5 space-y-4">
      <div class="flex items-start gap-3">
        <div class="flex-1">
          <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.infra.sticky') }}</h3>
          <p class="text-[12.5px] text-muted">{{ t('settings.infra.stickyDesc') }}</p>
        </div>
        <USwitch :model-value="settings.sticky.enabled" @update:model-value="patch('sticky', { enabled: $event })" />
      </div>
      <div v-if="settings.sticky.enabled" class="space-y-4">
        <div class="grid sm:grid-cols-2 gap-4">
          <UFormField :label="t('settings.infra.stickySignal')" hint="dBm"><UInputNumber :model-value="settings.sticky.signalDbm" :min="-95" :max="-50" class="w-full" @update:model-value="patch('sticky', { signalDbm: $event ?? -75 })" /></UFormField>
          <UFormField :label="t('settings.infra.stickyMinutes')" :hint="t('rules.minutesUnit')"><UInputNumber :model-value="settings.sticky.minutes" :min="1" :max="120" class="w-full" @update:model-value="patch('sticky', { minutes: $event ?? 10 })" /></UFormField>
        </div>
        <div class="rounded-lg ring-1 ring-(--ui-border-muted) p-3.5 space-y-3">
          <div class="flex items-start gap-3">
            <div class="flex-1">
              <div class="text-[13px] font-medium text-highlighted">{{ t('settings.infra.nudge') }}</div>
              <p class="text-[12px] text-muted">{{ t('settings.infra.nudgeDesc') }}</p>
            </div>
            <USwitch :model-value="settings.sticky.nudge" @update:model-value="patch('sticky', { nudge: $event })" />
          </div>
          <div v-if="settings.sticky.nudge" class="grid sm:grid-cols-2 gap-4">
            <UFormField :label="t('settings.infra.nudgeMax')"><UInputNumber :model-value="settings.sticky.maxNudgesPerDay" :min="1" :max="20" class="w-full" @update:model-value="patch('sticky', { maxNudgesPerDay: $event ?? 3 })" /></UFormField>
            <UFormField :label="t('settings.infra.nudgeSkip')" hint="Mbps"><UInputNumber v-model="stickyMbps" :min="0" :step="0.5" class="w-full" /></UFormField>
          </div>
        </div>
      </div>
    </div>

    <div class="uf-card p-5 space-y-4">
      <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.infra.energy') }}</h3>
      <div class="grid sm:grid-cols-2 gap-4">
        <UFormField :label="t('energy.ratePerKwh')" :hint="t('energy.rateHint')"><UInputNumber :model-value="settings.energy.ratePerKwh ?? undefined" :min="0" :step="0.1" :format-options="{ maximumFractionDigits: 2 }" class="w-full" @update:model-value="patch('energy', { ratePerKwh: $event ?? null })" /></UFormField>
        <UFormField :label="t('energy.currency')"><UInput :model-value="settings.energy.currency" class="w-full" @update:model-value="patch('energy', { currency: $event || 'TWD' })" /></UFormField>
      </div>
    </div>

    <div class="uf-card p-5 space-y-4">
      <div>
        <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.infra.retention') }}</h3>
        <p class="text-[12.5px] text-muted">{{ t('settings.infra.retentionDesc') }}</p>
      </div>
      <div class="grid sm:grid-cols-2 gap-4">
        <UFormField :label="t('settings.infra.retainRaw')" :hint="t('common.days')"><UInputNumber :model-value="settings.infra.retainRawDays" :min="1" :max="90" class="w-full" @update:model-value="patch('infra', { retainRawDays: $event ?? 7 })" /></UFormField>
        <UFormField :label="t('settings.infra.retainRollup')" :hint="t('common.days')"><UInputNumber :model-value="settings.infra.retainRollupDays" :min="30" :max="3650" class="w-full" @update:model-value="patch('infra', { retainRollupDays: $event ?? 400 })" /></UFormField>
      </div>
    </div>

    <div class="flex justify-end"><UButton icon="i-lucide-save" @click="emit('save')">{{ t('common.save') }}</UButton></div>
  </div>
  <USkeleton v-else class="h-64 rounded-xl" />
</template>
