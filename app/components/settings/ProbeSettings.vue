<script setup lang="ts">
import type { ProbeOverviewT } from '#shared/schemas/egress'
import type { SettingsT } from '#shared/schemas/system'

const settings = defineModel<SettingsT>({ required: true })
const emit = defineEmits<{ save: [] }>()
const { t } = useI18n()
const msg = useMsg()
const api = useApi()
const confirm = useConfirm()
const { data: probes, refresh } = useFetch<ProbeOverviewT>('/api/probes', { key: 'probes' })
const busy = ref(false)
async function provision() {
  busy.value = true
  try { probes.value = await api.post<ProbeOverviewT>('/api/probes/provision', undefined, { success: t('settings.probes.provisioned') }) }
  finally { busy.value = false }
}
async function cleanup() {
  if (!(await confirm({ title: t('settings.probes.cleanupConfirm'), description: t('settings.probes.cleanupDesc'), color: 'error' }))) return
  probes.value = await api.del<ProbeOverviewT>('/api/probes', undefined, { success: t('settings.probes.cleaned') })
}
const poolText = computed({ get: () => settings.value.probe.ipPool.join('\n'), set: v => (settings.value = { ...settings.value, probe: { ...settings.value.probe, ipPool: v.split(/\s+/).filter(Boolean) } }) })
const stateColor = { ok: 'success', missing: 'warning', provisioning: 'primary', disabled: 'neutral', error: 'error' } as const
</script>

<template>
  <div class="space-y-5">
    <div class="uf-card p-5">
      <div class="flex flex-wrap items-start gap-3 mb-4">
        <div class="flex-1 min-w-0">
          <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.probes.title') }}</h3>
          <p class="text-[12.5px] text-muted mt-0.5 max-w-2xl">{{ t('settings.probes.desc') }}</p>
        </div>
        <UButton size="sm" color="error" variant="ghost" icon="i-lucide-trash-2" @click="cleanup">{{ t('settings.probes.cleanup') }}</UButton>
        <UButton size="sm" icon="i-lucide-radio-tower" :loading="busy" @click="provision">{{ t('settings.probes.provision') }}</UButton>
      </div>
      <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3 mb-4 text-[12.5px] flex flex-wrap gap-x-6 gap-y-1">
        <span><span class="text-dimmed">{{ t('settings.probes.source') }}</span> <span class="uf-mono text-highlighted">{{ probes?.selfMac ?? '—' }}</span></span>
        <span><span class="text-dimmed">{{ t('settings.probes.sweepIp') }}</span> <span class="uf-mono text-highlighted">{{ probes?.sweepIp ?? '—' }}</span></span>
      </div>
      <div class="divide-y divide-(--ui-border-muted) rounded-lg ring-1 ring-(--ui-border-muted)">
        <div v-for="r in probes?.routes ?? []" :key="r.egressId" class="flex items-center gap-3 px-3 py-2.5">
          <EgressChip :id="r.egressId" size="sm" class="min-w-0" />
          <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed" />
          <span class="uf-mono text-[12px] text-toned w-32">{{ r.ip ?? '—' }}</span>
          <span class="text-[11.5px] text-dimmed truncate flex-1">{{ msg(r.detail) }}</span>
          <UBadge :color="stateColor[r.state]" variant="subtle" size="sm">{{ t(`egresses.probe.${r.state}`) }}</UBadge>
        </div>
      </div>
    </div>

    <div class="uf-card p-5 space-y-4">
      <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.probes.params') }}</h3>
      <div class="grid sm:grid-cols-4 gap-3">
        <UFormField :label="t('settings.probes.interval')"><UInputNumber :model-value="settings.probe.intervalSec" :min="10" :step="5" class="w-full" @update:model-value="settings = { ...settings, probe: { ...settings.probe, intervalSec: $event ?? 30 } }" /></UFormField>
        <UFormField :label="t('settings.probes.method')"><USelect :model-value="settings.probe.method" :items="[{ value: 'tcp', label: 'TCP 443/53' }, { value: 'dns', label: 'DNS query' }, { value: 'icmp', label: 'ICMP' }]" class="w-full" @update:model-value="settings = { ...settings, probe: { ...settings.probe, method: $event as any } }" /></UFormField>
        <UFormField :label="t('settings.probes.failThreshold')"><UInputNumber :model-value="settings.probe.failThreshold" :min="1" :max="20" class="w-full" @update:model-value="settings = { ...settings, probe: { ...settings.probe, failThreshold: $event ?? 3 } }" /></UFormField>
        <UFormField :label="t('settings.probes.sweepEvery')" :hint="t('settings.probes.zeroManual')"><UInputNumber :model-value="settings.probe.sweepIntervalMin" :min="0" :step="15" class="w-full" @update:model-value="settings = { ...settings, probe: { ...settings.probe, sweepIntervalMin: $event ?? 60 } }" /></UFormField>
      </div>
      <UFormField :label="t('settings.probes.pool')" :description="t('settings.probes.poolHint')">
        <UTextarea v-model="poolText" :rows="5" class="w-full uf-mono" />
      </UFormField>
      <div class="flex justify-end"><UButton icon="i-lucide-save" @click="emit('save'); refresh()">{{ t('common.save') }}</UButton></div>
    </div>
  </div>
</template>
