<script setup lang="ts">
import type { IncidentDetailT, IncidentSignalT, IncidentT, TopologyT, TopologyNodeT } from '#shared/schemas/infra'

const route = useRoute()
const { t, te, locale } = useI18n()
const listFmt = computed(() => new Intl.ListFormat(locale.value === 'zh-TW' ? 'zh-Hant' : 'en', { type: 'conjunction' }))
const fmt = useFormat()
const api = useApi()
const id = computed(() => String(route.params.id))
const { data: inc, error, refresh } = useFetch<IncidentDetailT>(() => `/api/incidents/${encodeURIComponent(id.value)}`, { key: 'incident-detail' })
const { data: topo } = useFetch<TopologyT>('/api/topology', { key: 'topology', dedupe: 'defer' })
const { get: person } = usePeople()
const { get: device } = useDevices()
const { byId: egressById } = useEgresses()
const now = useClock(30_000)
useHead(() => ({ title: inc.value ? txt(inc.value.titleKey, inc.value.titleParams) : t('nav.incidents') }))

const txt = (k: string, p: Record<string, string>) => (te(k) ? t(k, p) : k)
const elapsed = computed(() => (inc.value ? (inc.value.resolvedAt ?? now.value.getTime()) - inc.value.openedAt : 0))
const rel = (ts: number) => {
  const d = Math.round((ts - (inc.value?.openedAt ?? ts)) / 1000)
  const sign = d < 0 ? '−' : '+'
  const a = Math.abs(d)
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}
const signals = computed(() => [...(inc.value?.signals ?? [])].sort((a, b) => a.ts - b.ts))
const suspects = computed(() => signals.value.filter(s => s.suspect))
const kindUi: Record<string, { icon: string, tone: string }> = {
  egress_down: { icon: 'i-lucide-cloud-off', tone: 'bg-error/12 text-error' },
  egress_up: { icon: 'i-lucide-cloud', tone: 'bg-success/12 text-success' },
  wan_down: { icon: 'i-lucide-cable', tone: 'bg-error/12 text-error' },
  wan_up: { icon: 'i-lucide-cable', tone: 'bg-success/12 text-success' },
  device_offline: { icon: 'i-lucide-server-off', tone: 'bg-error/12 text-error' },
  device_online: { icon: 'i-lucide-server', tone: 'bg-success/12 text-success' },
  device_rebooted: { icon: 'i-lucide-rotate-ccw', tone: 'bg-warning/12 text-warning' },
  uplink_down: { icon: 'i-lucide-unplug', tone: 'bg-error/12 text-error' },
  uplink_up: { icon: 'i-lucide-plug', tone: 'bg-success/12 text-success' },
  port_issue: { icon: 'i-lucide-cable', tone: 'bg-warning/12 text-warning' },
  mass_disconnect: { icon: 'i-lucide-users-round', tone: 'bg-error/12 text-error' },
  clients_returned: { icon: 'i-lucide-users-round', tone: 'bg-success/12 text-success' },
  config_change: { icon: 'i-lucide-git-compare-arrows', tone: 'bg-vpn/12 text-vpn' },
}
const refLink = (s: IncidentSignalT) => {
  const r = s.ref
  if (!r) return null
  if (r.type === 'device') return `/devices/${encodeURIComponent(r.id)}`
  if (r.type === 'port') { const [mac, idx] = [r.id.slice(0, 17), r.id.slice(18)]; return `/devices/${encodeURIComponent(mac)}?tab=ports&port=${idx}` }
  if (r.type === 'egress') return '/egresses'
  if (r.type === 'client') return `/clients?mac=${r.id}`
  if (r.type === 'audit') return '/insight/audit'
  return null
}
const diffLink = computed(() => {
  const d = inc.value?.diff
  if (!d) return null
  return d.toSnapshotId ? `/insight/snapshots?snapshot=${d.toSnapshotId}&compare=previous` : `/insight/snapshots?snapshot=${d.fromSnapshotId}&compare=live`
})

/* affected subtree as an indented tree (ancestors shown for context) */
const tree = computed(() => {
  const nodes = topo.value?.nodes ?? []
  const affected = new Set(inc.value?.affectedNodes ?? [])
  if (!affected.size) return []
  const byId = new Map(nodes.map(n => [n.id, n]))
  const keep = new Set<string>()
  for (const idx of affected) {
    let cur: TopologyNodeT | undefined = byId.get(idx)
    while (cur) { keep.add(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined }
  }
  const out: { node: TopologyNodeT, depth: number, hit: boolean }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const n of nodes.filter(x => x.parentId === parent && keep.has(x.id) && x.kind !== 'egress' && !(x.kind === 'client_group' && !x.clients))) {
      out.push({ node: n, depth, hit: affected.has(n.id) })
      walk(n.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
})

const note = ref('')
watch(inc, (v) => { if (v) note.value = v.note ?? '' }, { immediate: true })
const savingNote = ref(false)
async function patch(body: { acknowledged?: boolean, note?: string | null }) {
  savingNote.value = true
  try {
    await api.patch<IncidentT>(`/api/incidents/${encodeURIComponent(id.value)}`, body, { success: t('common.saved') })
    await refresh()
  }
  finally { savingNote.value = false }
}
</script>

<template>
  <div>
    <UButton to="/insight/incidents" color="neutral" variant="link" icon="i-lucide-arrow-left" class="-ml-2.5 mb-2" size="sm">{{ t('nav.incidents') }}</UButton>
    <div v-if="error && !inc" class="uf-card"><EmptyState icon="i-lucide-siren" :title="t('incidents.notFound')" /></div>
    <USkeleton v-else-if="!inc" class="h-40 rounded-xl" />
    <template v-else>
      <!-- hero -->
      <div class="rounded-2xl p-5 mb-5 ring-1" :class="inc.status === 'resolved' ? 'bg-success/5 ring-success/25' : inc.severity === 'critical' ? 'bg-error/6 ring-error/35' : 'bg-warning/6 ring-warning/35'">
        <div class="flex flex-col lg:flex-row lg:items-start gap-4">
          <span class="relative size-12 rounded-2xl flex items-center justify-center shrink-0" :class="inc.status === 'resolved' ? 'bg-success/15 text-success' : inc.severity === 'critical' ? 'bg-error/15 text-error' : 'bg-warning/15 text-warning'">
            <span v-if="inc.status === 'open'" class="absolute inset-0 rounded-2xl animate-ping opacity-20" :class="inc.severity === 'critical' ? 'bg-error' : 'bg-warning'" />
            <UIcon :name="inc.status === 'resolved' ? 'i-lucide-shield-check' : 'i-lucide-siren'" class="size-6 relative" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap mb-1">
              <UBadge :color="inc.severity === 'critical' ? 'error' : 'warning'" variant="solid" size="sm">{{ t(`incidents.severity.${inc.severity}`) }}</UBadge>
              <UBadge :color="inc.status === 'open' ? 'error' : 'success'" variant="soft" size="sm">{{ inc.status === 'open' ? t('incidents.ongoingShort') : t('incidents.resolved') }}</UBadge>
              <span class="text-[12px] text-muted uf-num">{{ fmt.dateTime(inc.openedAt) }} · {{ fmt.duration(elapsed) }}</span>
            </div>
            <h1 class="text-xl sm:text-[22px] font-semibold tracking-tight text-highlighted">{{ txt(inc.titleKey, inc.titleParams) }}</h1>
            <p v-if="inc.root" class="text-[13px] text-muted mt-1">{{ t('incidents.rootIs') }} <span class="text-highlighted font-medium">{{ inc.root.ref?.label ?? t(`incidents.kind.${inc.root.kind}`) }}</span> · {{ t(`incidents.kind.${inc.root.kind}`) }}</p>
          </div>
          <UButton v-if="inc.status === 'open'" :color="inc.acknowledged ? 'neutral' : 'primary'" :variant="inc.acknowledged ? 'soft' : 'solid'" :icon="inc.acknowledged ? 'i-lucide-eye' : 'i-lucide-hand'" @click="patch({ acknowledged: !inc.acknowledged })">
            {{ inc.acknowledged ? t('incidents.acked') : t('incidents.ack') }}
          </UButton>
        </div>

        <!-- impact -->
        <div class="flex flex-wrap items-center gap-2 mt-4">
          <NuxtLink v-for="mac in inc.impact.devices" :key="mac" :to="`/devices/${encodeURIComponent(mac)}`" class="flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-full bg-(--uf-surface) ring-1 ring-(--ui-border-muted) text-[12px] text-highlighted hover:ring-(--ui-border-accented)">
            <UIcon name="i-lucide-server" class="size-3.5 text-dimmed" />{{ device(mac)?.name ?? mac }}
          </NuxtLink>
          <span v-for="eid in inc.impact.egresses" :key="eid" class="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-(--uf-surface) ring-1 ring-(--ui-border-muted) text-[12px]">
            <span class="size-2 rounded-full" :style="{ background: egressById.get(eid)?.color }" />{{ egressById.get(eid)?.name ?? eid }}
          </span>
          <span class="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-(--uf-surface) ring-1 ring-(--ui-border-muted) text-[12px] text-toned"><UIcon name="i-lucide-monitor-smartphone" class="size-3.5 text-dimmed" />{{ t('incidents.clientsN', { n: inc.impact.clients }, inc.impact.clients) }}</span>
          <div v-if="inc.impact.people.length" class="flex items-center gap-1.5 h-7 pl-1 pr-2.5 rounded-full bg-(--uf-surface) ring-1 ring-(--ui-border-muted)">
            <div class="flex -space-x-1.5"><PersonAvatar v-for="pid in inc.impact.people.slice(0, 5)" :key="pid" :avatar="person(pid)?.avatar ?? '?'" :color="person(pid)?.color ?? '#888'" :size="20" class="ring-2 ring-(--uf-surface) rounded-full" /></div>
            <span class="text-[12px] text-toned">{{ listFmt.format(inc.impact.people.map(p => person(p)?.name).filter((n): n is string => !!n)) }}</span>
          </div>
        </div>
      </div>

      <div class="grid xl:grid-cols-[1fr_360px] gap-4">
        <!-- signal timeline -->
        <UCard>
          <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('incidents.timeline') }}</h2></template>
          <ol class="relative ml-3 border-l border-(--ui-border-muted) space-y-4 py-1">
            <li v-for="s in signals" :key="s.id" class="pl-6 relative">
              <span class="absolute -left-3.5 top-0 size-7 rounded-full flex items-center justify-center ring-4 ring-(--uf-surface)" :class="kindUi[s.kind]?.tone">
                <UIcon :name="kindUi[s.kind]?.icon ?? 'i-lucide-dot'" class="size-3.5" />
              </span>
              <div class="flex items-start gap-2 flex-wrap">
                <component :is="refLink(s) ? resolveComponent('NuxtLink') : 'span'" :to="refLink(s) ?? undefined" class="text-[13px] font-medium text-highlighted" :class="refLink(s) ? 'hover:text-primary' : ''">{{ txt(s.messageKey, s.messageParams) }}</component>
                <UBadge v-if="s.suspect" color="warning" variant="soft" size="xs" icon="i-lucide-search">{{ t('incidents.suspect') }}</UBadge>
                <UBadge v-if="inc.root?.ref && s.ref?.id === inc.root.ref.id && s.kind === inc.root.kind" color="error" variant="soft" size="xs" icon="i-lucide-crosshair">{{ t('incidents.root') }}</UBadge>
              </div>
              <div class="text-[11.5px] text-dimmed uf-num">{{ fmt.time(s.ts, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }} · {{ rel(s.ts) }}</div>
            </li>
          </ol>
        </UCard>

        <div class="space-y-4">
          <UCard v-if="tree.length">
            <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('incidents.affected') }}</h2></template>
            <div class="space-y-0.5 -mx-1">
              <div v-for="r in tree" :key="r.node.id" class="flex items-center gap-2 rounded-md px-1 py-1 text-[12.5px]" :class="r.hit ? 'bg-error/8' : ''" :style="{ paddingLeft: `${4 + r.depth * 16}px` }">
                <UIcon v-if="r.depth" name="i-lucide-corner-down-right" class="size-3 text-dimmed shrink-0" />
                <StatusDot :status="r.hit ? 'down' : r.node.state === 'down' ? 'down' : r.node.state === 'warning' ? 'degraded' : 'healthy'" :size="7" />
                <span class="truncate" :class="r.hit ? 'text-error font-medium' : 'text-toned'">{{ r.node.kind === 'client_group' ? t('topology.clientsN', { n: r.node.clients }, r.node.clients) : r.node.label }}</span>
              </div>
            </div>
            <template #footer><UButton to="/devices/topology" size="xs" color="neutral" variant="ghost" trailing-icon="i-lucide-arrow-right">{{ t('nav.topology') }}</UButton></template>
          </UCard>

          <UCard>
            <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('incidents.before') }}</h2></template>
            <div v-if="suspects.length" class="space-y-2">
              <div v-for="s in suspects" :key="s.id" class="flex items-start gap-2 text-[12.5px]">
                <UIcon name="i-lucide-git-compare-arrows" class="size-3.5 text-vpn mt-0.5 shrink-0" />
                <div><div class="text-highlighted">{{ txt(s.messageKey, s.messageParams) }}</div><div class="text-[11px] text-dimmed uf-num">{{ fmt.time(s.ts) }} · {{ rel(s.ts) }}</div></div>
              </div>
              <UButton v-if="diffLink" :to="diffLink" size="sm" color="neutral" variant="outline" block icon="i-lucide-file-diff" class="mt-2">{{ t('incidents.viewDiff') }}</UButton>
            </div>
            <p v-else class="text-[12.5px] text-dimmed">{{ t('incidents.noSuspects') }}</p>
          </UCard>

          <UCard>
            <template #header><h2 class="text-sm font-semibold text-highlighted">{{ t('incidents.note') }}</h2></template>
            <UTextarea v-model="note" :rows="3" class="w-full" :placeholder="t('incidents.notePh')" />
            <div class="flex justify-end mt-2"><UButton size="sm" :loading="savingNote" :disabled="note === (inc.note ?? '')" @click="patch({ note: note || null })">{{ t('common.save') }}</UButton></div>
          </UCard>
        </div>
      </div>
    </template>
  </div>
</template>
