<script setup lang="ts">
import type { ClientT, ClientUsageT } from '#shared/schemas/access'
import type { StickyClientT } from '#shared/schemas/infra'
import type { TableColumn } from '@nuxt/ui'
import type { EChartsOption } from 'echarts'

const UCheckbox = resolveComponent('UCheckbox')
const { t } = useI18n()
const toast = useToast()
const fmt = useFormat()
const api = useApi()
const route = useRoute()
const router = useRouter()
const { data: clients, status, refresh } = useFetch<ClientT[]>('/api/clients', { key: 'clients', default: () => [] })
const { people, get: getPerson } = usePeople()

const q = ref('')
const filter = ref<'all' | 'online' | 'offline' | 'blocked' | 'unassigned'>('online')
const personFilter = ref<string | null>(null)
const rows = computed(() => clients.value.filter((c) => {
  if (filter.value === 'online' && !c.online) return false
  if (filter.value === 'offline' && c.online) return false
  if (filter.value === 'blocked' && !c.blocked) return false
  if (filter.value === 'unassigned' && c.personId) return false
  if (personFilter.value && c.personId !== personFilter.value) return false
  if (q.value) {
    const s = q.value.toLowerCase()
    return [c.displayName, c.hostname, c.ip, c.mac, c.vendor].some(v => v?.toLowerCase().includes(s))
  }
  return true
}).sort((a, b) => Number(b.online) - Number(a.online) || (b.rxRateBps ?? 0) - (a.rxRateBps ?? 0)))

const counts = computed(() => ({
  all: clients.value.length,
  online: clients.value.filter(c => c.online).length,
  offline: clients.value.filter(c => !c.online).length,
  blocked: clients.value.filter(c => c.blocked).length,
  unassigned: clients.value.filter(c => !c.personId).length,
}))

/* selection for bulk assignment (keyed by MAC; cleared when the visible set changes) */
const rowSelection = ref<Record<string, boolean>>({})
const selectedMacs = computed(() => rows.value.filter(c => rowSelection.value[c.mac]).map(c => c.mac))
watch([filter, personFilter, q], () => { rowSelection.value = {} })
const stop = (e: Event) => e.stopPropagation()

const columns: TableColumn<ClientT>[] = [
  {
    id: 'select',
    header: ({ table }) => h(UCheckbox, {
      'modelValue': table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected(),
      'onUpdate:modelValue': (v: boolean | 'indeterminate') => table.toggleAllPageRowsSelected(!!v),
      'aria-label': t('clients.selectAll'),
    }),
    cell: ({ row }) => h('div', { onClick: stop }, h(UCheckbox, {
      'modelValue': row.getIsSelected(),
      'onUpdate:modelValue': (v: boolean | 'indeterminate') => row.toggleSelected(!!v),
      'aria-label': t('clients.selectRow'),
    })),
    meta: { class: { th: 'w-10', td: 'w-10' } },
  },
  { accessorKey: 'displayName', header: () => t('clients.name') },
  { id: 'ip', header: 'IP' },
  { id: 'net', header: () => t('clients.network') },
  { id: 'person', header: () => t('clients.person') },
  { id: 'rate', header: () => t('clients.rate') },
  { id: 'today', header: () => t('clients.today') },
  { id: 'status', header: () => t('clients.status') },
]

/* detail */
const selectedMac = computed({
  get: () => (route.query.mac as string) || null,
  set: v => router.replace({ query: { ...route.query, mac: v ?? undefined } }),
})
const selected = computed(() => clients.value.find(c => c.mac === selectedMac.value) ?? null)
const { data: sticky } = useFetch<StickyClientT[]>('/api/roaming/sticky', { key: 'sticky', default: () => [] })
const stickyByMac = computed(() => new Map(sticky.value.filter(s => s.status !== 'recovered').map(s => [s.mac, s])))
const usageRange = ref<'24h' | '7d' | '30d'>('24h')
const { data: usage, execute: loadUsage } = useFetch<ClientUsageT>(() => `/api/clients/${selectedMac.value}/usage`, { query: { range: usageRange }, immediate: false, watch: false })
watch([selectedMac, usageRange], () => { if (selectedMac.value) loadUsage() }, { immediate: true })
const usageChart = computed<EChartsOption>(() => ({
  tooltip: { valueFormatter: (v: unknown) => fmt.bytes(Number(v)) },
  xAxis: { type: 'time' },
  yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmt.bytes(v, 0) } },
  series: [
    { type: 'bar', stack: 'u', name: t('dashboard.download'), itemStyle: { color: '#006FFF', borderRadius: [0, 0, 0, 0] }, barMaxWidth: 10, data: usage.value?.buckets.map(b => [b.ts, b.rxBytes]) ?? [] },
    { type: 'bar', stack: 'u', name: t('dashboard.upload'), itemStyle: { color: '#8E59FF', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 10, data: usage.value?.buckets.map(b => [b.ts, b.txBytes]) ?? [] },
  ],
}))

const edit = reactive({ alias: '', personId: '', note: '' })
watch(selected, (c) => { if (c) Object.assign(edit, { alias: c.unifiName === c.displayName ? '' : c.displayName, personId: c.personId ?? '', note: c.note ?? '' }) }, { immediate: true })
async function saveEdit() {
  if (!selected.value) return
  await api.patch(`/api/clients/${selected.value.mac}`, { alias: edit.alias || null, personId: edit.personId || null, note: edit.note || null }, { success: t('common.saved') })
  refresh()
  refreshNuxtData('people')
}
const blockMinutes = ref<number | null>(60)
async function action(a: 'block' | 'unblock' | 'kick') {
  if (!selected.value) return
  await api.post(`/api/clients/${selected.value.mac}/action`, { action: a, minutes: a === 'block' ? blockMinutes.value ?? undefined : undefined }, { success: t(`clients.done.${a}`) })
  refresh()
}

/* assignment straight from the list: one row (cell picker) or every selected row (bulk bar) */
const assigning = ref<string | null>(null)
async function assign(macs: string[], personId: string | null) {
  if (!macs.length) return
  assigning.value = macs.length === 1 ? macs[0]! : 'bulk'
  try {
    for (const mac of macs) await api.patch(`/api/clients/${mac}`, { personId })
    const name = getPerson(personId)?.name ?? ''
    toast.add({
      title: personId
        ? (macs.length === 1 ? t('clients.assigned', { name }) : t('clients.assignedN', { n: macs.length, name }))
        : (macs.length === 1 ? t('clients.unassigned') : t('clients.unassignedN', { n: macs.length })),
      color: 'success', icon: personId ? 'i-lucide-user-check' : 'i-lucide-user-x',
    })
    if (assigning.value === 'bulk') rowSelection.value = {}
  }
  finally {
    assigning.value = null
    await refresh()
    refreshNuxtData('people')
  }
}
</script>

<template>
  <div>
    <PageHeader :title="t('nav.clients')" :description="t('clients.desc')" icon="i-lucide-monitor-smartphone" />

    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="flex flex-col lg:flex-row gap-3 lg:items-center">
          <div class="flex gap-1 overflow-x-auto -mx-1 px-1">
            <button
              v-for="f in (['online', 'all', 'offline', 'blocked', 'unassigned'] as const)"
              :key="f"
              type="button"
              class="h-8 px-3 rounded-full text-[12.5px] font-medium whitespace-nowrap transition ring-1"
              :class="filter === f ? 'bg-primary/10 text-primary ring-primary/30' : 'text-toned ring-transparent hover:bg-(--uf-hover)'"
              @click="filter = f"
            >{{ t(`clients.filter.${f}`) }} <span class="ml-1 text-dimmed uf-num">{{ counts[f] }}</span></button>
          </div>
          <div class="flex gap-2 lg:ml-auto">
            <USelectMenu v-model="personFilter" :items="[{ label: t('clients.anyPerson'), value: null }, ...people.map(p => ({ label: `${p.avatar} ${p.name}`, value: p.id }))]" value-key="value" size="sm" class="w-40" :placeholder="t('clients.anyPerson')" />
            <UInput v-model="q" icon="i-lucide-search" :placeholder="t('clients.search')" size="sm" class="w-full lg:w-64" />
          </div>
        </div>
      </template>

      <!-- bulk bar -->
      <div v-if="selectedMacs.length" class="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-primary/6 border-b border-primary/20">
        <span class="text-[13px] font-medium text-primary">{{ t('clients.selectedN', { n: selectedMacs.length }) }}</span>
        <div class="w-56"><PersonAssignSelect :model-value="null" :loading="assigning === 'bulk'" @update:model-value="v => v && assign(selectedMacs, v)" /></div>
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-user-x" :disabled="assigning === 'bulk'" @click="assign(selectedMacs, null)">{{ t('clients.unassign') }}</UButton>
        <UButton size="sm" color="neutral" variant="ghost" class="ml-auto" @click="rowSelection = {}">{{ t('clients.clearSelection') }}</UButton>
      </div>

      <UTable v-model:row-selection="rowSelection" :get-row-id="(r: ClientT) => r.mac" :data="rows" :columns="columns" :loading="status === 'pending' && !clients.length" class="cursor-pointer" :ui="{ tr: 'hover:bg-(--uf-hover)' }" @select="(_e: Event, row: any) => (selectedMac = row.original.mac)">
        <template #displayName-cell="{ row }">
          <div class="flex items-center gap-3 min-w-0">
            <span class="relative size-8 rounded-lg flex items-center justify-center bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) shrink-0">
              <UIcon :name="row.original.wired ? 'i-lucide-ethernet-port' : 'i-lucide-wifi'" class="size-4 text-toned" />
              <span class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-(--uf-surface)" :class="row.original.online ? 'bg-success' : 'bg-(--color-ufgray-400)'" />
            </span>
            <div class="min-w-0">
              <div class="font-medium text-highlighted truncate max-w-[220px] flex items-center gap-1.5">
                {{ row.original.displayName }}
                <UTooltip v-if="row.original.randomizedMac" :text="t('clients.randomized')"><UIcon name="i-lucide-shuffle" class="size-3 text-dimmed" /></UTooltip>
              </div>
              <div class="text-[11.5px] text-dimmed truncate max-w-[220px]">{{ row.original.vendor ?? row.original.hostname ?? row.original.mac }}</div>
            </div>
          </div>
        </template>
        <template #ip-cell="{ row }">
          <div class="uf-mono text-toned">{{ row.original.ip ?? '—' }}</div>
          <div class="text-[11px] text-dimmed uf-mono">{{ row.original.mac }}</div>
        </template>
        <template #net-cell="{ row }">
          <div class="text-[12.5px] text-toned">{{ row.original.networkName ?? '—' }}</div>
          <div class="text-[11px] text-dimmed truncate max-w-[160px]">{{ row.original.wired ? `${row.original.uplinkName ?? ''}${row.original.switchPort ? ` · #${row.original.switchPort}` : ''}` : `${row.original.ssid ?? ''}${row.original.signal ? ` · ${row.original.signal} dBm` : ''}` }}</div>
        </template>
        <template #person-cell="{ row }">
          <div @click.stop>
            <PersonAssignSelect
              compact
              :model-value="row.original.personId"
              :loading="assigning === row.original.mac"
              @update:model-value="v => v !== row.original.personId && assign([row.original.mac], v)"
            />
          </div>
        </template>
        <template #rate-cell="{ row }">
          <div v-if="row.original.online" class="text-[12px] uf-num">
            <div class="text-toned"><UIcon name="i-lucide-arrow-down" class="size-3 text-primary" /> {{ fmt.bps(row.original.rxRateBps) }}</div>
            <div class="text-dimmed"><UIcon name="i-lucide-arrow-up" class="size-3 text-vpn" /> {{ fmt.bps(row.original.txRateBps) }}</div>
          </div>
          <span v-else class="text-[12px] text-dimmed"><TimeAgo :ts="row.original.lastSeen" /></span>
        </template>
        <template #today-cell="{ row }">
          <div class="text-[12.5px] text-toned uf-num">{{ fmt.bytes(row.original.today.bytes) }}</div>
          <div class="text-[11px] text-dimmed">{{ fmt.minutes(row.original.today.activeMinutes) }}</div>
        </template>
        <template #status-cell="{ row }">
          <div class="flex flex-wrap gap-1">
            <UBadge v-if="row.original.blocked" color="error" variant="subtle" size="sm" icon="i-lucide-ban">{{ t('clients.blocked') }}</UBadge>
            <UBadge v-if="row.original.approval === 'pending'" color="warning" variant="subtle" size="sm" icon="i-lucide-shield-question">{{ t('clients.pending') }}</UBadge>
            <UBadge v-if="row.original.managedRouteIds.length" color="primary" variant="subtle" size="sm" icon="i-lucide-waypoints">{{ row.original.managedRouteIds.length }}</UBadge>
            <UTooltip v-if="stickyByMac.get(row.original.mac)" :text="t('roaming.stickyShort', { ap: stickyByMac.get(row.original.mac)!.apName, dbm: stickyByMac.get(row.original.mac)!.signal })"><UBadge color="warning" variant="subtle" size="sm" icon="i-lucide-magnet">{{ t('roaming.stickyBadge') }}</UBadge></UTooltip>
          </div>
        </template>
      </UTable>
    </UCard>

    <USlideover :open="!!selected" :title="selected?.displayName" :description="selected?.mac" :ui="{ content: 'sm:max-w-xl' }" @update:open="v => { if (!v) selectedMac = null }">
      <template #body>
        <div v-if="selected" class="space-y-6">
          <div class="flex flex-wrap gap-1.5">
            <UBadge :color="selected.online ? 'success' : 'neutral'" variant="subtle" :icon="selected.online ? 'i-lucide-wifi' : 'i-lucide-wifi-off'">{{ selected.online ? t('clients.online') : t('clients.offline') }}</UBadge>
            <UBadge v-if="selected.blocked" color="error" variant="subtle" icon="i-lucide-ban">{{ t('clients.blocked') }}</UBadge>
            <UBadge v-for="(b, i) in selected.blockReasons" :key="i" color="error" variant="outline" size="sm">{{ b.label }}<template v-if="b.until"> · {{ fmt.time(b.until) }}</template></UBadge>
          </div>

          <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-[12.5px]">
            <div><dt class="text-dimmed">IP</dt><dd class="uf-mono text-highlighted">{{ selected.ip ?? '—' }}<span v-if="selected.fixedIp" class="text-dimmed"> ({{ t('clients.fixed') }})</span></dd></div>
            <div><dt class="text-dimmed">MAC</dt><dd><MacText :value="selected.mac" copy /></dd></div>
            <div><dt class="text-dimmed">{{ t('clients.vendor') }}</dt><dd class="text-toned">{{ selected.vendor ?? '—' }}</dd></div>
            <div><dt class="text-dimmed">Hostname</dt><dd class="text-toned truncate">{{ selected.hostname ?? '—' }}</dd></div>
            <div><dt class="text-dimmed">{{ t('clients.network') }}</dt><dd class="text-toned">{{ selected.networkName ?? '—' }}</dd></div>
            <div><dt class="text-dimmed">{{ selected.wired ? t('clients.switchPort') : 'SSID' }}</dt><dd class="text-toned">{{ selected.wired ? `${selected.uplinkName ?? '—'} #${selected.switchPort ?? '—'}` : `${selected.ssid ?? '—'} · ${selected.uplinkName ?? ''}` }}</dd></div>
            <div><dt class="text-dimmed">{{ t('clients.firstSeen') }}</dt><dd class="text-toned">{{ fmt.dateTime(selected.firstSeen) }}</dd></div>
            <div><dt class="text-dimmed">{{ t('clients.lastSeen') }}</dt><dd class="text-toned"><TimeAgo :ts="selected.lastSeen" /></dd></div>
          </dl>

          <div>
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-[13px] font-semibold text-highlighted">{{ t('clients.usage') }}</h3>
              <UTabs v-model="usageRange" :content="false" size="xs" :items="[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]" />
            </div>
            <div class="flex gap-4 text-[12px] mb-1">
              <span class="text-dimmed">{{ t('dashboard.download') }} <b class="text-highlighted uf-num">{{ fmt.bytes(usage?.totals.rxBytes) }}</b></span>
              <span class="text-dimmed">{{ t('dashboard.upload') }} <b class="text-highlighted uf-num">{{ fmt.bytes(usage?.totals.txBytes) }}</b></span>
              <span class="text-dimmed">{{ t('clients.active') }} <b class="text-highlighted">{{ fmt.minutes(usage?.totals.activeMinutes) }}</b></span>
            </div>
            <UfChart :option="usageChart" height="180px" />
          </div>

          <ClientRoaming v-if="!selected.wired" :mac="selected.mac" :sticky="stickyByMac.get(selected.mac) ?? null" class="pt-4 border-t border-(--ui-border-muted)" />

          <div class="space-y-3 pt-4 border-t border-(--ui-border-muted)">
            <h3 class="text-[13px] font-semibold text-highlighted">{{ t('clients.identity') }}</h3>
            <UFormField :label="t('clients.alias')" :hint="t('clients.aliasHint')"><UInput v-model="edit.alias" class="w-full" :placeholder="selected.unifiName ?? selected.hostname ?? ''" /></UFormField>
            <UFormField :label="t('clients.person')"><PersonAssignSelect :model-value="edit.personId || null" :placeholder="t('clients.noPerson')" @update:model-value="v => (edit.personId = v ?? '')" /></UFormField>
            <UFormField :label="t('clients.note')"><UTextarea v-model="edit.note" :rows="2" class="w-full" /></UFormField>
            <div class="flex justify-end"><UButton size="sm" icon="i-lucide-save" @click="saveEdit">{{ t('common.save') }}</UButton></div>
          </div>

          <div class="space-y-3 pt-4 border-t border-(--ui-border-muted)">
            <h3 class="text-[13px] font-semibold text-highlighted">{{ t('clients.actions') }}</h3>
            <template v-if="!selected.blocked">
              <DurationPicker v-model="blockMinutes" :options="[15, 60, 240, 1440, null]" />
              <div class="flex gap-2">
                <UButton color="error" variant="soft" icon="i-lucide-ban" @click="action('block')">{{ t('clients.block') }}</UButton>
                <UButton color="neutral" variant="outline" icon="i-lucide-unplug" :disabled="!selected.online" @click="action('kick')">{{ t('clients.kick') }}</UButton>
              </div>
            </template>
            <UButton v-else color="success" variant="soft" icon="i-lucide-circle-check" @click="action('unblock')">{{ t('clients.unblock') }}</UButton>
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>
