<script setup lang="ts">
import type { ManagedRouteT, RoutePreviewT, SwitchLogEntryT, FailoverPolicyT, RotationGeneratorT } from '#shared/schemas/routes'
import { emptyGrid, cloneGrid, type Grid } from '#shared/utils/schedule'

const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: r, refresh } = useFetch<ManagedRouteT>(() => `/api/managed-routes/${id.value}`, { key: `managed-route-${id.value}` })
const { data: preview, refresh: refreshPreview } = useFetch<RoutePreviewT>(() => `/api/managed-routes/${id.value}/preview`, { query: { hours: 48 }, key: `preview-${id.value}` })
const { data: log } = useFetch<{ items: SwitchLogEntryT[] }>('/api/switch-log', { query: { managedRouteId: id, limit: 50 }, key: `switch-log-${id.value}`, default: () => ({ items: [] }) })
const { egresses } = useEgresses()
const live = useLive()
live.on('route.switched', (e) => { if (e.managedRouteId === id.value) { refresh(); refreshPreview() } })
live.on('route.changed', (e) => { if (e.managedRouteId === id.value) { refresh(); refreshPreview() } })

const tab = ref<'schedule' | 'override' | 'failover' | 'settings' | 'log'>('schedule')

/* ── schedule editing ── */
const grid = ref<Grid>(emptyGrid())
const generator = ref<RotationGeneratorT | null>(null)
const timezone = ref('Asia/Taipei')
const savedJson = ref('')
watch(r, (v) => {
  if (!v) return
  grid.value = v.schedule ? cloneGrid(v.schedule.grid) : emptyGrid()
  generator.value = v.schedule?.generator ?? null
  timezone.value = v.schedule?.timezone ?? 'Asia/Taipei'
  savedJson.value = JSON.stringify(grid.value)
}, { immediate: true })
const dirty = computed(() => JSON.stringify(grid.value) !== savedJson.value)
const genOpen = ref(false)
const gridRef = ref<{ undo: () => void, redo: () => void, commit: (g: Grid) => void } | null>(null)
const saving = ref(false)

function onGenerated(g: Grid, gen: RotationGeneratorT) {
  gridRef.value?.commit(g)
  generator.value = gen
}
function clearGrid() { gridRef.value?.commit(emptyGrid()) }
function copyDay(from: number, to: number[]) {
  const g = cloneGrid(grid.value)
  for (const d of to) g[d] = [...g[from]!]
  gridRef.value?.commit(g)
}
async function saveSchedule() {
  saving.value = true
  try {
    const empty = grid.value.every(row => row.every(c => c === null))
    r.value = await api.put<ManagedRouteT>(`/api/managed-routes/${id.value}/schedule`, empty ? null : { timezone: timezone.value, grid: grid.value, generator: generator.value }, { success: t('routes.scheduleSaved') })
    await refreshPreview()
  }
  finally { saving.value = false }
}
function discard() {
  if (!r.value) return
  grid.value = r.value.schedule ? cloneGrid(r.value.schedule.grid) : emptyGrid()
}
onBeforeRouteLeave(() => (dirty.value ? window.confirm(t('common.unsavedConfirm')) : true))

/* ── failover ── */
const failover = ref<FailoverPolicyT | null>(null)
watch(r, v => { if (v) failover.value = structuredClone(toRaw(v.failover)) }, { immediate: true })
const failoverDirty = computed(() => r.value && failover.value && JSON.stringify(failover.value) !== JSON.stringify(r.value.failover))
async function saveFailover() {
  r.value = await api.patch<ManagedRouteT>(`/api/managed-routes/${id.value}`, { failover: failover.value }, { success: t('common.saved') })
}

/* ── settings ── */
const settingsForm = reactive({ name: '', defaultEgressId: '' as string | null, killSwitch: true })
watch(r, v => { if (v) Object.assign(settingsForm, { name: v.name, defaultEgressId: v.defaultEgressId, killSwitch: v.killSwitch }) }, { immediate: true })
async function saveSettings() {
  r.value = await api.patch<ManagedRouteT>(`/api/managed-routes/${id.value}`, { name: settingsForm.name, defaultEgressId: settingsForm.defaultEgressId ?? undefined, killSwitch: settingsForm.killSwitch }, { success: t('common.saved') })
  refreshPreview()
}
async function toggleEnabled(v: boolean) {
  r.value = await api.patch<ManagedRouteT>(`/api/managed-routes/${id.value}`, { enabled: v }, { success: v ? t('routes.resumed') : t('routes.pausedManage') })
}
async function resumeDrift() {
  r.value = await api.post<ManagedRouteT>(`/api/managed-routes/${id.value}/resume`, undefined, { success: t('routes.driftAccepted') })
}
const releaseOpen = ref(false)
const releaseDelete = ref(false)
async function release() {
  await api.del(`/api/managed-routes/${id.value}?deleteFromUnifi=${releaseDelete.value}`, undefined, { success: t('routes.released') })
  refreshNuxtData(['managed-routes', 'routes'])
  await navigateTo('/routes')
}

const reasonIcon: Record<string, string> = { schedule: 'i-lucide-calendar-clock', default: 'i-lucide-circle-dot', override: 'i-lucide-timer', failover: 'i-lucide-life-buoy', recover: 'i-lucide-undo-2', manual: 'i-lucide-hand', rule: 'i-lucide-workflow', initial: 'i-lucide-play' }
const copyFrom = ref(0)
</script>

<template>
  <div v-if="r" class="pb-16">
    <NuxtLink to="/routes" class="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-highlighted mb-3">
      <UIcon name="i-lucide-arrow-left" class="size-3.5" />{{ t('nav.routes') }}
    </NuxtLink>

    <PageHeader :title="r.name" :description="`${t(`routes.match.${r.matchingTarget}`)} · ${t('routes.sourcesN', { n: r.targets.length })}${r.killSwitch ? ' · Kill switch' : ''}`">
      <template #badge>
        <UBadge :color="r.state === 'active' ? 'success' : r.state === 'drift' ? 'warning' : r.state === 'error' ? 'error' : 'neutral'" variant="subtle">{{ t(`routes.state.${r.state}`) }}</UBadge>
      </template>
      <template #actions>
        <div class="flex items-center gap-2 mr-1">
          <span class="text-[12.5px] text-muted">{{ t('routes.managing') }}</span>
          <USwitch :model-value="r.enabled" @update:model-value="toggleEnabled" />
        </div>
        <UDropdownMenu :items="[[{ label: t('routes.release'), icon: 'i-lucide-unlink', color: 'error', onSelect: () => (releaseOpen = true) }]]">
          <UButton color="neutral" variant="outline" icon="i-lucide-ellipsis" :aria-label="t('common.more')" />
        </UDropdownMenu>
      </template>
    </PageHeader>

    <!-- Drift alert -->
    <UAlert
      v-if="r.state === 'drift' || r.state === 'error'"
      :color="r.state === 'drift' ? 'warning' : 'error'"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="r.state === 'drift' ? t('routes.driftTitle') : t('routes.errorTitle')"
      :description="r.stateDetail ?? (r.state === 'drift' ? t('routes.driftDesc') : '')"
      class="mb-4"
      :actions="r.state === 'drift' ? [{ label: t('routes.driftAccept'), color: 'warning', variant: 'solid', onClick: resumeDrift }] : []"
    />

    <!-- Hero -->
    <div class="uf-card p-5 sm:p-6 mb-4">
      <div class="grid md:grid-cols-[1fr_auto_1fr] gap-5 items-center">
        <div>
          <div class="uf-section-title mb-2">{{ t('routes.current') }}</div>
          <div class="flex items-center gap-3">
            <EgressChip :id="r.actualEgressId" size="md" show-health :fallback="t('routes.unknownActual')" />
            <UTooltip v-if="r.actualEgressId !== r.desired.egressId" :text="t('routes.converging')">
              <UIcon name="i-lucide-loader-circle" class="size-4 text-warning animate-spin" />
            </UTooltip>
          </div>
          <div class="mt-2 text-[12.5px] text-muted flex items-center gap-1.5">
            <UIcon :name="reasonIcon[r.desired.reason]!" class="size-3.5" />
            {{ t(`routes.reason.${r.desired.reason}`) }}<template v-if="r.desired.until"> · {{ t('routes.untilTime', { time: fmt.time(r.desired.until) }) }}</template>
          </div>
        </div>
        <UIcon name="i-lucide-arrow-right" class="hidden md:block size-5 text-dimmed" />
        <div>
          <div class="uf-section-title mb-2">{{ t('routes.next') }}</div>
          <template v-if="r.next">
            <div class="flex items-center gap-3">
              <EgressChip :id="r.next.egressId" size="md" />
              <span class="text-[13px] font-semibold text-highlighted uf-num">{{ fmt.time(r.next.at) }}</span>
            </div>
            <div class="mt-2 text-[12.5px] text-muted">{{ fmt.until(r.next.at) }} · {{ t(`routes.reason.${r.next.reason}`) }}</div>
          </template>
          <div v-else class="text-[13px] text-dimmed">{{ t('routes.noUpcoming') }}</div>
        </div>
      </div>
      <div class="mt-6">
        <div class="flex items-center justify-between mb-2">
          <span class="uf-section-title">{{ t('routes.next48') }}</span>
          <span class="text-[11.5px] text-dimmed">{{ timezone }}</span>
        </div>
        <RouteTimeline :preview="preview ?? null" />
      </div>
    </div>

    <UTabs
      v-model="tab"
      :content="false"
      variant="link"
      class="mb-4"
      :items="[
        { value: 'schedule', label: t('routes.tabSchedule'), icon: 'i-lucide-calendar-clock' },
        { value: 'override', label: t('routes.tabOverride'), icon: 'i-lucide-timer', badge: r.activeOverride ? '•' : undefined },
        { value: 'failover', label: t('routes.tabFailover'), icon: 'i-lucide-life-buoy' },
        { value: 'settings', label: t('routes.tabSettings'), icon: 'i-lucide-sliders-horizontal' },
        { value: 'log', label: t('routes.tabLog'), icon: 'i-lucide-history' },
      ]"
    />

    <UCard v-if="tab === 'schedule'">
      <div class="flex flex-wrap items-center gap-2 mb-5">
        <UButton icon="i-lucide-wand-sparkles" color="primary" variant="soft" @click="genOpen = true">{{ t('routes.gen.open') }}</UButton>
        <UPopover>
          <UButton icon="i-lucide-copy" color="neutral" variant="outline">{{ t('routes.copyDay') }}</UButton>
          <template #content>
            <div class="p-3 w-64 space-y-3">
              <USelect v-model="copyFrom" :items="Array.from({ length: 7 }, (_, d) => ({ value: d, label: fmt.weekday(d, 'long') }))" class="w-full" size="sm" />
              <div class="grid grid-cols-2 gap-1.5">
                <UButton size="xs" color="neutral" variant="outline" @click="copyDay(copyFrom, [0, 1, 2, 3, 4])">{{ t('routes.toWeekdays') }}</UButton>
                <UButton size="xs" color="neutral" variant="outline" @click="copyDay(copyFrom, [5, 6])">{{ t('routes.toWeekend') }}</UButton>
                <UButton size="xs" color="neutral" variant="outline" class="col-span-2" @click="copyDay(copyFrom, [0, 1, 2, 3, 4, 5, 6])">{{ t('routes.toAll') }}</UButton>
              </div>
            </div>
          </template>
        </UPopover>
        <UButton icon="i-lucide-eraser" color="neutral" variant="ghost" @click="clearGrid">{{ t('routes.clear') }}</UButton>
        <div class="ml-auto flex gap-1">
          <UTooltip :text="t('common.undo')"><UButton icon="i-lucide-undo-2" color="neutral" variant="ghost" :aria-label="t('common.undo')" @click="gridRef?.undo()" /></UTooltip>
          <UTooltip :text="t('common.redo')"><UButton icon="i-lucide-redo-2" color="neutral" variant="ghost" :aria-label="t('common.redo')" @click="gridRef?.redo()" /></UTooltip>
        </div>
      </div>
      <ScheduleGrid ref="gridRef" v-model="grid" :egresses="egresses" :default-egress-id="r.defaultEgressId" :timezone="timezone" />
    </UCard>

    <UCard v-else-if="tab === 'override'">
      <OverridePanel :route="r" @changed="v => { r = v; refreshPreview() }" />
    </UCard>

    <UCard v-else-if="tab === 'failover' && failover">
      <FailoverEditor v-model="failover" :desired-egress-id="r.desired.egressId" />
      <div class="flex justify-end mt-6">
        <UButton :disabled="!failoverDirty" icon="i-lucide-save" @click="saveFailover">{{ t('common.save') }}</UButton>
      </div>
    </UCard>

    <UCard v-else-if="tab === 'settings'">
      <div class="space-y-5 max-w-2xl">
        <UFormField :label="t('routes.name')"><UInput v-model="settingsForm.name" class="w-full" /></UFormField>
        <UFormField :label="t('routes.killSwitch')" :description="t('routes.killSwitchHint')"><USwitch v-model="settingsForm.killSwitch" /></UFormField>
        <div>
          <div class="text-[13px] font-medium text-highlighted mb-1">{{ t('routes.defaultEgress') }}</div>
          <p class="text-[12px] text-muted mb-2">{{ t('routes.defaultEgressHint') }}</p>
          <EgressPicker v-model="settingsForm.defaultEgressId" :egresses="egresses" />
        </div>
        <div class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-3 text-[12.5px] space-y-1">
          <div class="flex gap-2"><span class="text-dimmed w-28">UniFi ID</span><MacText :value="r.unifiRouteId" copy /></div>
          <div class="flex gap-2"><span class="text-dimmed w-28">{{ t('routes.sources') }}</span>
            <span class="flex flex-wrap gap-1">
              <template v-for="(tg, i) in r.targets" :key="i">
                <UBadge color="neutral" variant="outline" size="sm" class="uf-mono">{{ tg.type === 'CLIENT' ? tg.mac : tg.type === 'NETWORK' ? tg.networkId : 'ALL' }}</UBadge>
              </template>
            </span>
          </div>
          <div v-if="r.destinations.length" class="flex gap-2"><span class="text-dimmed w-28">{{ t('routes.destinations') }}</span><span class="text-toned">{{ r.destinations.join(', ') }}</span></div>
        </div>
        <div class="flex justify-end"><UButton icon="i-lucide-save" @click="saveSettings">{{ t('common.save') }}</UButton></div>
      </div>
    </UCard>

    <UCard v-else :ui="{ body: 'p-0 sm:p-0' }">
      <div v-if="log.items.length" class="divide-y divide-(--ui-border-muted)">
        <div v-for="s in log.items" :key="s.id" class="flex items-center gap-3 px-4 sm:px-5 py-3">
          <span class="text-[12px] text-dimmed uf-num w-24 shrink-0">{{ fmt.dateTime(s.ts) }}</span>
          <UIcon :name="reasonIcon[s.reason]!" class="size-4 text-dimmed" />
          <span class="text-[12.5px] text-toned w-24 shrink-0">{{ t(`routes.reason.${s.reason}`) }}</span>
          <div class="flex items-center gap-1.5 flex-1 min-w-0">
            <EgressChip v-if="s.fromEgressId" :id="s.fromEgressId" size="xs" />
            <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed" />
            <EgressChip :id="s.toEgressId" size="xs" />
          </div>
          <UBadge v-if="s.error" color="error" variant="subtle" size="sm">{{ s.error }}</UBadge>
          <UBadge v-else-if="s.dryRun" color="warning" variant="subtle" size="sm">dry-run</UBadge>
          <UBadge v-else-if="s.verified" color="success" variant="subtle" size="sm" icon="i-lucide-badge-check">{{ s.durationMs }} ms</UBadge>
        </div>
      </div>
      <div v-else class="py-10 text-center text-[13px] text-dimmed">{{ t('dashboard.noSwitches') }}</div>
    </UCard>

    <!-- Unsaved bar -->
    <Transition enter-from-class="translate-y-full opacity-0" enter-active-class="transition duration-300 ease-(--ease-uf)" leave-to-class="translate-y-full opacity-0" leave-active-class="transition duration-200">
      <div v-if="dirty && tab === 'schedule'" class="fixed z-30 left-0 right-0 lg:left-auto lg:right-8 bottom-[calc(66px+env(safe-area-inset-bottom))] lg:bottom-6 mx-3 lg:mx-0">
        <div class="uf-card shadow-(--uf-shadow-lg) flex items-center gap-3 px-4 py-3 lg:min-w-[420px]">
          <UIcon name="i-lucide-pencil-line" class="size-4 text-warning" />
          <span class="text-[13px] font-medium text-highlighted flex-1">{{ t('common.unsaved') }}</span>
          <UButton color="neutral" variant="ghost" size="sm" @click="discard">{{ t('common.discard') }}</UButton>
          <UButton size="sm" icon="i-lucide-save" :loading="saving" @click="saveSchedule">{{ t('routes.saveSchedule') }}</UButton>
        </div>
      </div>
    </Transition>

    <RotationGenerator v-model:open="genOpen" :egresses="egresses" :initial="generator" :base="grid" :default-egress-id="r.defaultEgressId" @apply="onGenerated" />

    <UModal v-model:open="releaseOpen" :title="t('routes.release')" :description="t('routes.releaseDesc')">
      <template #body>
        <UCheckbox v-model="releaseDelete" :label="t('routes.releaseDelete')" :description="t('routes.releaseDeleteHint')" />
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" @click="releaseOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton color="error" icon="i-lucide-unlink" @click="release">{{ t('routes.release') }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
  <div v-else class="space-y-4">
    <USkeleton class="h-8 w-64" />
    <USkeleton class="h-48 w-full rounded-xl" />
    <USkeleton class="h-96 w-full rounded-xl" />
  </div>
</template>
