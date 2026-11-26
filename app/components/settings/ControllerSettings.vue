<script setup lang="ts">
import type { ControllerStatusT } from '#shared/schemas/controller'

const { t } = useI18n()
const api = useApi()
const confirm = useConfirm()
const { status, refresh } = useControllerStatus()
const probing = ref(false)
const capLabels = computed(() => Object.fromEntries((status.value?.capabilities ?? []).map(c => [c.key, t(`caps.k.${c.key}`)])))

async function probe() {
  probing.value = true
  try { status.value = await api.post<ControllerStatusT>('/api/controller/probe') }
  finally { probing.value = false }
}
async function setMode(mode: 'dry-run' | 'live') {
  if (mode === 'live' && !(await confirm({ title: t('settings.controller.goLiveTitle'), description: t('settings.controller.goLiveDesc'), color: 'warning', icon: 'i-lucide-zap', confirmLabel: t('settings.controller.goLive') }))) return
  status.value = await api.put<ControllerStatusT>('/api/controller/mode', { mode }, { success: mode === 'live' ? t('settings.controller.liveOn') : t('settings.controller.dryOn') })
}
async function sync() { await api.post('/api/controller/sync', undefined, { success: t('settings.controller.synced') }); refresh() }
</script>

<template>
  <div v-if="status" class="space-y-5">
    <div class="uf-card p-5">
      <div class="flex flex-wrap items-start gap-4">
        <span class="size-12 rounded-xl flex items-center justify-center" :class="status.connected ? 'bg-success/12 text-success' : 'bg-error/12 text-error'"><UIcon name="i-lucide-router" class="size-6" /></span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="text-[15px] font-semibold text-highlighted">{{ status.model ?? 'UniFi' }}</h3>
            <UBadge :color="status.connected ? 'success' : 'error'" variant="subtle" size="sm">{{ status.connected ? t('topbar.connected') : t('topbar.disconnected') }}</UBadge>
            <UBadge v-if="status.mock" color="secondary" variant="subtle" size="sm" icon="i-lucide-flask-conical">{{ t('topbar.mock') }}</UBadge>
          </div>
          <div class="text-[12.5px] text-muted mt-0.5">Network {{ status.networkVersion ?? '—' }} · UniFi OS {{ status.consoleVersion ?? '—' }} · {{ status.timezone ?? '' }}</div>
          <div class="text-[12px] text-dimmed mt-1 uf-mono truncate">{{ status.url }} · site {{ status.site }} · {{ status.username }}</div>
          <div v-if="status.lastError" class="mt-2 text-[12px] text-error flex items-center gap-1.5"><UIcon name="i-lucide-circle-alert" class="size-3.5" />{{ status.lastError }}</div>
        </div>
        <div class="flex gap-2">
          <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-refresh-cw" @click="sync">{{ t('settings.controller.sync') }}</UButton>
          <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-pencil" to="/setup">{{ t('settings.controller.reconfigure') }}</UButton>
        </div>
      </div>
      <dl class="mt-4 grid sm:grid-cols-4 gap-3 text-[12.5px]">
        <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-2.5"><dt class="text-dimmed">{{ t('settings.controller.tls') }}</dt><dd class="text-highlighted">{{ status.verifyMode ? t(`setup.controller.vm${status.verifyMode === 'fingerprint' ? 'Fingerprint' : status.verifyMode === 'ca' ? 'Ca' : 'Insecure'}`) : '—' }}</dd></div>
        <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-2.5"><dt class="text-dimmed">{{ t('settings.controller.ws') }}</dt><dd class="flex items-center gap-1.5 text-highlighted"><StatusDot :status="status.wsConnected ? 'online' : 'offline'" :size="7" />{{ status.wsConnected ? t('settings.controller.wsOn') : t('settings.controller.wsOff') }}</dd></div>
        <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-2.5"><dt class="text-dimmed">{{ t('setup.review.selfHost') }}</dt><dd class="uf-mono text-highlighted truncate">{{ status.selfIp ?? '—' }} · {{ status.selfMac ?? '—' }}</dd></div>
        <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-2.5"><dt class="text-dimmed">{{ t('settings.controller.lastSync') }}</dt><dd class="text-highlighted"><TimeAgo :ts="status.lastSyncAt" /></dd></div>
      </dl>
    </div>

    <!-- Mode -->
    <div class="uf-card p-5">
      <h3 class="text-[14px] font-semibold text-highlighted mb-1">{{ t('settings.controller.mode') }}</h3>
      <p class="text-[12.5px] text-muted mb-4">{{ t('settings.controller.modeDesc') }}</p>
      <div class="grid sm:grid-cols-2 gap-3">
        <button type="button" class="text-left p-4 rounded-xl ring-1 transition" :class="status.mode === 'dry-run' ? 'ring-2 ring-warning bg-warning/6' : 'ring-(--ui-border-muted) hover:ring-(--ui-border-accented)'" @click="status.mode !== 'dry-run' && setMode('dry-run')">
          <div class="flex items-center gap-2"><UIcon name="i-lucide-shield-alert" class="size-5 text-warning" /><span class="text-[14px] font-semibold text-highlighted">{{ t('topbar.dryRun') }}</span><UIcon v-if="status.mode === 'dry-run'" name="i-lucide-circle-check" class="size-4 text-warning ml-auto" /></div>
          <p class="mt-1.5 text-[12.5px] text-muted">{{ t('settings.controller.dryDesc') }}</p>
        </button>
        <button type="button" class="text-left p-4 rounded-xl ring-1 transition" :class="status.mode === 'live' ? 'ring-2 ring-success bg-success/6' : 'ring-(--ui-border-muted) hover:ring-(--ui-border-accented)'" @click="status.mode !== 'live' && setMode('live')">
          <div class="flex items-center gap-2"><UIcon name="i-lucide-zap" class="size-5 text-success" /><span class="text-[14px] font-semibold text-highlighted">{{ t('settings.controller.live') }}</span><UIcon v-if="status.mode === 'live'" name="i-lucide-circle-check" class="size-4 text-success ml-auto" /></div>
          <p class="mt-1.5 text-[12.5px] text-muted">{{ t('settings.controller.liveDesc') }}</p>
        </button>
      </div>
    </div>

    <div class="uf-card p-5">
      <div class="flex items-center justify-between mb-3">
        <div>
          <h3 class="text-[14px] font-semibold text-highlighted">{{ t('setup.review.capabilities') }}</h3>
          <p class="text-[12.5px] text-muted">{{ t('settings.controller.capsDesc') }}</p>
        </div>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-scan-search" :loading="probing" @click="probe">{{ t('settings.controller.reprobe') }}</UButton>
      </div>
      <CapabilityMatrix :caps="status.capabilities" :labels="capLabels" />
    </div>
  </div>
  <USkeleton v-else class="h-64 rounded-xl" />
</template>
