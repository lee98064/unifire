<script setup lang="ts">
import type { PoeOverviewT, PoeScheduleT, PoeScheduleStatusT } from '#shared/schemas/infra'
import type { SettingsT } from '#shared/schemas/system'

const { t, te } = useI18n()
const fmt = useFormat()
const api = useApi()
const route = useRoute()
const { isDryRun } = useControllerStatus()
const { data: poe, status, error, refresh } = useFetch<PoeOverviewT>('/api/poe', { key: 'poe' })
const { data: settings } = useFetch<SettingsT>('/api/settings', { key: 'settings', dedupe: 'defer' })
useIntervalFn(() => refresh(), 30_000)

const tab = computed({
  get: () => (['schedules', 'watchdogs', 'energy'].includes(route.query.tab as string) ? String(route.query.tab) : 'schedules'),
  set: v => navigateTo({ query: { ...route.query, tab: v === 'schedules' ? undefined : v } }, { replace: true }),
})
const tabs = computed(() => [
  { value: 'schedules', label: t('poe.tab.schedules'), icon: 'i-lucide-calendar-clock' },
  { value: 'watchdogs', label: t('poe.tab.watchdogs'), icon: 'i-lucide-plug-zap' },
  { value: 'energy', label: t('poe.tab.energy'), icon: 'i-lucide-chart-column' },
])

const timezone = computed(() => settings.value?.timezone ?? 'Asia/Taipei')
const rate = computed(() => settings.value?.energy?.ratePerKwh ?? null)
const currency = computed(() => settings.value?.energy?.currency ?? 'TWD')
const qualified = computed(() => !!poe.value?.qualification.qualified)

/* faceplate selection → editor */
const swMac = ref<string | null>(null)
watch(poe, (v) => { if (v && !v.switches.some(s => s.mac === swMac.value)) swMac.value = v.switches[0]?.mac ?? null }, { immediate: true })
const sw = computed(() => poe.value?.switches.find(s => s.mac === swMac.value) ?? null)
const editorOpen = ref(false)
const editing = ref<PoeScheduleT | null>(null)
const editingPort = ref<{ switchMac: string, portIdx: number } | null>(null)
function openFor(switchMac: string, portIdx: number) {
  editing.value = poe.value?.schedules.find(s => s.switchMac === switchMac && s.portIdx === portIdx) ?? null
  editingPort.value = { switchMac, portIdx }
  editorOpen.value = true
}
function openSchedule(s: PoeScheduleT | null) {
  editing.value = s
  editingPort.value = null
  editorOpen.value = true
}
const qualifyOpen = ref(false)

const statusUi: Record<PoeScheduleStatusT, { color: 'success' | 'warning' | 'error' | 'neutral' | 'info' | 'primary', icon: string }> = {
  ok: { color: 'success', icon: 'i-lucide-check' },
  pending: { color: 'info', icon: 'i-lucide-loader' },
  preview: { color: 'neutral', icon: 'i-lucide-eye' },
  dry_run: { color: 'warning', icon: 'i-lucide-flask-conical' },
  drift: { color: 'warning', icon: 'i-lucide-git-compare-arrows' },
  blocked: { color: 'error', icon: 'i-lucide-shield-x' },
  unqualified: { color: 'warning', icon: 'i-lucide-shield-question' },
  error: { color: 'error', icon: 'i-lucide-circle-x' },
  disabled: { color: 'neutral', icon: 'i-lucide-pause' },
}
const reason = (s: PoeScheduleT) => (s.state.reasonKey && te(s.state.reasonKey) ? t(s.state.reasonKey, s.state.reasonParams) : s.state.reasonKey)
const swName = (mac: string) => poe.value?.switches.find(s => s.mac === mac)?.name ?? mac

async function setMode(s: PoeScheduleT, mode: 'preview' | 'active') {
  await api.patch(`/api/poe/schedules/${s.id}`, { mode }, { success: mode === 'active' ? t('poe.activated', { name: s.name }) : t('poe.previewed', { name: s.name }) })
  refresh()
}
async function setEnabled(s: PoeScheduleT, enabled: boolean) {
  await api.patch(`/api/poe/schedules/${s.id}`, { enabled })
  refresh()
}
async function resume(s: PoeScheduleT) {
  await api.post(`/api/poe/schedules/${s.id}/resume`, undefined, { success: t('poe.resumed') })
  refresh()
}
async function clearOverride(switchMac: string, portIdx: number) {
  await api.post('/api/poe/override', { action: 'clear', switchMac, portIdx }, { success: t('poe.overrideCleared') })
  refresh()
}
const monthSaved = computed(() => (poe.value?.schedules ?? []).filter(s => s.enabled && s.mode === 'active').reduce((sum, s) => sum + (s.savings.monthKwh ?? 0), 0))
</script>

<template>
  <div>
    <PageHeader :title="t('nav.poe')" :description="t('poe.desc')" icon="i-lucide-zap">
      <template #actions>
        <UButton v-if="tab === 'schedules'" icon="i-lucide-plus" :disabled="!poe?.switches.length" @click="openSchedule(null)">{{ t('poe.newSchedule') }}</UButton>
      </template>
    </PageHeader>

    <UTabs v-model="tab" :items="tabs" :content="false" class="mb-5" />

    <template v-if="tab === 'schedules'">
      <div v-if="error && !poe" class="uf-card"><EmptyState icon="i-lucide-zap-off" :title="t('poe.unavailable')" :description="t('poe.unavailableDesc')" /></div>
      <USkeleton v-else-if="!poe" class="h-48 rounded-xl" />
      <template v-else>
        <!-- write qualification -->
        <div v-if="!qualified" class="rounded-xl ring-1 ring-warning/40 bg-warning/8 p-4 mb-5 flex flex-col sm:flex-row sm:items-center gap-3">
          <span class="size-10 rounded-xl bg-warning/15 text-warning flex items-center justify-center shrink-0"><UIcon name="i-lucide-shield-question" class="size-5" /></span>
          <div class="flex-1 min-w-0">
            <div class="text-[14px] font-semibold text-highlighted">{{ t('poe.notQualified') }}</div>
            <p class="text-[12.5px] text-muted">{{ poe.qualification.error ?? t('poe.notQualifiedDesc') }}</p>
          </div>
          <UButton color="warning" icon="i-lucide-shield-check" @click="qualifyOpen = true">{{ t('poe.qualify.open') }}</UButton>
        </div>
        <div v-else class="flex items-center gap-2 text-[12px] text-success mb-4">
          <UIcon name="i-lucide-shield-check" class="size-4" />{{ t('poe.qualifiedAt') }} <TimeAgo :ts="poe.qualification.at" />
        </div>

        <!-- switch picker + faceplate -->
        <UCard class="mb-5">
          <template #header>
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-sm font-semibold text-highlighted">{{ t('poe.pickPort') }}</h2>
              <div v-if="poe.switches.length > 1" class="flex gap-1.5 ml-2">
                <UButton v-for="s in poe.switches" :key="s.mac" size="xs" :color="swMac === s.mac ? 'primary' : 'neutral'" :variant="swMac === s.mac ? 'soft' : 'ghost'" @click="swMac = s.mac">{{ s.name }}</UButton>
              </div>
              <div v-if="sw?.budgetW" class="ml-auto flex items-center gap-2 text-[12px] text-muted uf-num">
                <UIcon name="i-lucide-zap" class="size-3.5 text-warning" />{{ (sw.usedW ?? 0).toFixed(1) }} / {{ sw.budgetW }} W
                <span class="w-20 h-1.5 rounded-full bg-(--ui-bg-accented) overflow-hidden"><span class="block h-full bg-warning rounded-full" :style="{ width: `${Math.min(100, ((sw.usedW ?? 0) / sw.budgetW) * 100)}%` }" /></span>
              </div>
            </div>
          </template>
          <SwitchFaceplate v-if="sw" :ports="sw.ports" pick-poe @select="i => openFor(sw!.mac, i)" />
          <EmptyState v-else icon="i-lucide-ethernet-port" :title="t('poe.noSwitch')" :description="t('poe.noSwitchDesc')" />
          <p v-if="sw" class="text-[12px] text-dimmed mt-3 flex items-center gap-1.5"><UIcon name="i-lucide-mouse-pointer-click" class="size-3.5" />{{ t('poe.pickHint') }}</p>
        </UCard>

        <!-- overrides -->
        <div v-if="poe.overrides.length" class="flex flex-wrap gap-2 mb-5">
          <div v-for="o in poe.overrides" :key="`${o.switchMac}-${o.portIdx}`" class="flex items-center gap-2 h-9 pl-3 pr-1 rounded-full ring-1 text-[12.5px]" :class="o.on ? 'ring-success/30 bg-success/8' : 'ring-warning/30 bg-warning/8'">
            <UIcon :name="o.on ? 'i-lucide-zap' : 'i-lucide-zap-off'" class="size-3.5" :class="o.on ? 'text-success' : 'text-warning'" />
            <span class="text-highlighted">{{ swName(o.switchMac) }} #{{ o.portIdx }}</span>
            <span class="text-muted">{{ o.on ? t('poe.overrideOn') : t('poe.overrideOff') }}{{ o.endsAt ? ` · ${fmt.until(o.endsAt)}` : '' }}</span>
            <UBadge v-if="o.source === 'rule'" size="xs" variant="soft" color="neutral">{{ t('poe.byRule') }}</UBadge>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="t('poe.clearOverride')" @click="clearOverride(o.switchMac, o.portIdx)" />
          </div>
        </div>

        <!-- schedules -->
        <div class="flex items-center justify-between mb-2.5">
          <h2 class="uf-section-title">{{ t('poe.schedules') }}</h2>
          <span v-if="monthSaved > 0" class="text-[12px] text-success flex items-center gap-1"><UIcon name="i-lucide-leaf" class="size-3.5" />{{ t('poe.savingTotal', { kwh: monthSaved.toFixed(1) }) }}</span>
        </div>
        <div v-if="poe.schedules.length" class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div v-for="s in poe.schedules" :key="s.id" class="uf-card p-4 flex flex-col gap-3.5" :class="s.enabled ? '' : 'opacity-60'">
            <div class="flex items-start gap-3">
              <span class="size-10 rounded-xl flex items-center justify-center shrink-0" :class="s.state.actual === 'off' ? 'bg-warning/12 text-warning' : 'bg-success/12 text-success'">
                <UIcon :name="s.state.actual === 'off' ? 'i-lucide-zap-off' : 'i-lucide-zap'" class="size-5" />
              </span>
              <div class="min-w-0 flex-1">
                <h3 class="text-[14px] font-semibold text-highlighted truncate">{{ s.name }}</h3>
                <div class="text-[12px] text-dimmed truncate">{{ s.switchName ?? swName(s.switchMac) }} · #{{ s.portIdx }}<template v-if="s.peerName"> · {{ s.peerName }}</template></div>
              </div>
              <UBadge :color="statusUi[s.state.status].color" variant="subtle" size="sm" :icon="statusUi[s.state.status].icon">{{ t(`poe.status.${s.state.status}`) }}</UBadge>
            </div>

            <WeekStrip :windows="s.offWindows" :timezone="s.timezone" compact />

            <div class="text-[12.5px] text-toned flex items-center gap-1.5">
              <UIcon :name="s.state.actual === 'off' ? 'i-lucide-moon' : 'i-lucide-sun'" class="size-3.5 text-dimmed" />
              <span>{{ s.state.actual === 'off' ? t('poe.isOff') : s.state.actual === 'on' ? t('poe.isOn') : t('poe.isUnknown') }}</span>
              <span v-if="s.state.nextChangeAt" class="text-dimmed">· {{ t(s.state.nextDesired === 'off' ? 'poe.nextOff' : 'poe.nextOn', { at: fmt.time(s.state.nextChangeAt), in: fmt.until(s.state.nextChangeAt) }) }}</span>
            </div>
            <p v-if="s.state.reasonKey" class="text-[12px] -mt-1" :class="s.state.status === 'blocked' || s.state.status === 'error' ? 'text-error' : 'text-warning'">{{ reason(s) }}</p>

            <div class="flex items-center gap-2 text-[12px]">
              <span class="flex items-center gap-1 text-success"><UIcon name="i-lucide-leaf" class="size-3.5" />{{ s.savings.monthKwh != null ? t('poe.savesShort', { kwh: s.savings.monthKwh.toFixed(1) }) : t('poe.savesUnknown') }}</span>
              <span v-if="s.savings.monthCost != null" class="text-dimmed uf-num">· {{ currency }} {{ s.savings.monthCost.toFixed(0) }}</span>
              <span class="ml-auto text-dimmed uf-num">{{ t('poe.offPerWeek', { h: s.savings.offHoursPerWeek.toFixed(0) }) }}</span>
            </div>

            <div class="flex items-center gap-2 pt-3 border-t border-(--ui-border-muted) mt-auto">
              <div class="inline-flex rounded-md ring-1 ring-(--ui-border-muted) p-0.5">
                <button v-for="m in (['preview', 'active'] as const)" :key="m" type="button" class="h-6 px-2.5 rounded text-[11.5px] font-medium transition" :class="s.mode === m ? (m === 'active' ? 'bg-primary text-white' : 'bg-(--uf-hover) text-highlighted') : 'text-dimmed hover:text-toned'" @click="s.mode !== m && setMode(s, m)">{{ t(`poe.modes.${m}`) }}</button>
              </div>
              <USwitch :model-value="s.enabled" size="sm" :aria-label="t('common.enabled')" @update:model-value="setEnabled(s, $event)" />
              <UButton v-if="s.state.status === 'drift'" size="xs" color="warning" variant="soft" icon="i-lucide-play" @click="resume(s)">{{ t('poe.resume') }}</UButton>
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" class="ml-auto" :aria-label="t('common.edit')" @click="openSchedule(s)" />
            </div>
          </div>
        </div>
        <div v-else class="uf-card"><EmptyState icon="i-lucide-calendar-clock" :title="t('poe.empty')" :description="t('poe.emptyDesc')"><UButton icon="i-lucide-plus" :disabled="!poe.switches.length" @click="openSchedule(null)">{{ t('poe.newSchedule') }}</UButton></EmptyState></div>
      </template>
    </template>

    <PoeWatchdogs v-else-if="tab === 'watchdogs'" />
    <EnergyLedger v-else />

    <PoeScheduleEditor
      v-if="poe"
      v-model:open="editorOpen"
      :schedule="editing"
      :port="editingPort"
      :switches="poe.switches"
      :timezone="timezone"
      :rate="rate"
      :currency="currency"
      :qualified="qualified"
      @saved="refresh()"
    />
    <PoeQualifyModal v-if="poe" v-model:open="qualifyOpen" :switches="poe.switches" :dry-run="isDryRun" @done="refresh()" />
  </div>
</template>
