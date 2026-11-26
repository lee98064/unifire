<script setup lang="ts">
import type { ManagedRouteT, RouteTargetT } from '#shared/schemas/routes'
import type { ClientT, PersonT } from '#shared/schemas/access'
import type { EgressT } from '#shared/schemas/egress'
import { egressKindIcon, latencyColor } from '~/utils/egress'

/**
 * "出口星圖" — sources (people / devices / networks) → managed routes → egresses → Internet.
 * HTML nodes laid out in columns; an SVG overlay draws bezier links measured from the DOM,
 * with packets (animateMotion) flowing along active paths in the egress color.
 */
const props = defineProps<{ routes: ManagedRouteT[], egresses: EgressT[], people: PersonT[], clients: ClientT[] }>()
const { t } = useI18n()
const fmt = useFormat()
const { networks } = useNetworks()
const reduceMotion = usePreferredReducedMotion()

interface SourceNode { id: string, kind: 'person' | 'client' | 'network' | 'all', label: string, sub: string, avatar?: string, color?: string, online?: boolean }

const personByMac = computed(() => {
  const m = new Map<string, PersonT>()
  for (const p of props.people) for (const mac of p.deviceMacs) m.set(mac, p)
  return m
})
const clientByMac = computed(() => new Map(props.clients.map(c => [c.mac, c])))

function sourceFor(target: RouteTargetT): SourceNode {
  if (target.type === 'CLIENT') {
    const p = personByMac.value.get(target.mac)
    const c = clientByMac.value.get(target.mac)
    if (p) return { id: `p:${p.id}`, kind: 'person', label: p.name, sub: t('dashboard.devicesN', { n: p.deviceMacs.length }), avatar: p.avatar, color: p.color, online: p.presence.home }
    return { id: `c:${target.mac}`, kind: 'client', label: c?.displayName ?? target.mac, sub: c?.ip ?? target.mac, online: c?.online }
  }
  if (target.type === 'NETWORK') {
    const n = networks.value.find(x => x.id === target.networkId)
    return { id: `n:${target.networkId}`, kind: 'network', label: n?.name ?? t('common.network'), sub: n?.subnet ?? '' }
  }
  return { id: 'all', kind: 'all', label: t('dashboard.allClients'), sub: '' }
}

const sources = computed(() => {
  const map = new Map<string, SourceNode>()
  for (const r of props.routes) for (const tg of r.targets) { const s = sourceFor(tg); map.set(s.id, s) }
  return [...map.values()]
})

const links = computed(() => {
  const srcLinks: { from: string, to: string, color: string, active: boolean }[] = []
  const egLinks: { from: string, to: string, color: string, active: boolean, dashed: boolean }[] = []
  for (const r of props.routes) {
    const eg = props.egresses.find(e => e.id === (r.actualEgressId ?? r.desired.egressId))
    const color = eg?.color ?? 'var(--ui-text-dimmed)'
    const active = r.enabled && r.state === 'active'
    for (const tg of r.targets) srcLinks.push({ from: sourceFor(tg).id, to: `r:${r.id}`, color, active })
    if (eg) egLinks.push({ from: `r:${r.id}`, to: `e:${eg.id}`, color, active, dashed: r.desired.reason === 'failover' || r.desired.reason === 'override' })
  }
  return { srcLinks, egLinks }
})

const usedEgressIds = computed(() => new Set(links.value.egLinks.map(l => l.to.slice(2))))
const egressNodes = computed(() => {
  const used = props.egresses.filter(e => usedEgressIds.value.has(e.id))
  const wans = props.egresses.filter(e => e.kind === 'wan' && !usedEgressIds.value.has(e.id))
  return [...used, ...wans].sort((a, b) => (a.kind === 'wan' ? 0 : 1) - (b.kind === 'wan' ? 0 : 1))
})

/* ── geometry ── */
const root = ref<HTMLElement | null>(null)
const nodeEls = new Map<string, HTMLElement>()
function setEl(id: string) {
  return (el: unknown) => {
    if (el instanceof HTMLElement) nodeEls.set(id, el)
    else nodeEls.delete(id)
  }
}
const paths = ref<{ key: string, d: string, color: string, active: boolean, dashed: boolean, delay: number }[]>([])
const size = reactive({ w: 0, h: 0 })

function measure() {
  const r = root.value
  if (!r) return
  const box = r.getBoundingClientRect()
  size.w = box.width
  size.h = box.height
  const anchor = (id: string, side: 'l' | 'r') => {
    const el = nodeEls.get(id)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: (side === 'r' ? b.right : b.left) - box.left, y: b.top + b.height / 2 - box.top }
  }
  const curve = (a: { x: number, y: number }, b: { x: number, y: number }) => {
    const dx = Math.max(40, (b.x - a.x) * 0.5)
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`
  }
  const out: typeof paths.value = []
  let i = 0
  for (const l of links.value.srcLinks) {
    const a = anchor(l.from, 'r'); const b = anchor(l.to, 'l')
    if (a && b) out.push({ key: `s${i}`, d: curve(a, b), color: l.color, active: l.active, dashed: false, delay: (i++ % 7) * 0.37 })
  }
  for (const l of links.value.egLinks) {
    const a = anchor(l.from, 'r'); const b = anchor(l.to, 'l')
    if (a && b) out.push({ key: `e${i}`, d: curve(a, b), color: l.color, active: l.active, dashed: l.dashed, delay: (i++ % 7) * 0.37 })
  }
  for (const e of egressNodes.value) {
    const a = anchor(`e:${e.id}`, 'r'); const b = anchor('internet', 'l')
    if (a && b) out.push({ key: `i${e.id}`, d: curve(a, b), color: e.color, active: e.health.status !== 'down', dashed: e.health.status === 'down', delay: (i++ % 7) * 0.37 })
  }
  paths.value = out
}

useResizeObserver(root, () => measure())
watch(() => [props.routes, props.egresses, props.people, props.clients], () => nextTick(measure), { deep: true })
onMounted(() => nextTick(measure))
</script>

<template>
  <div class="relative">
    <!-- Desktop constellation -->
    <div v-show="routes.length" ref="root" class="relative hidden md:grid grid-cols-[minmax(150px,1fr)_minmax(180px,1.15fr)_minmax(170px,1fr)_64px] gap-x-14 items-center py-2 min-h-[300px]">
      <svg class="absolute inset-0 pointer-events-none overflow-visible" :width="size.w" :height="size.h" aria-hidden="true">
        <g v-for="p in paths" :key="p.key">
          <path :d="p.d" fill="none" :stroke="p.color" :stroke-opacity="p.active ? 0.38 : 0.14" stroke-width="1.75" :stroke-dasharray="p.dashed ? '5 5' : undefined" />
          <circle v-if="p.active && reduceMotion !== 'reduce'" r="2.6" :fill="p.color">
            <animateMotion :dur="`${2.6 + (p.delay % 1.2)}s`" :begin="`${p.delay}s`" repeatCount="indefinite" :path="p.d" />
          </circle>
        </g>
      </svg>

      <!-- Sources -->
      <div class="relative flex flex-col gap-2.5">
        <div class="uf-section-title mb-0.5">{{ t('dashboard.colSources') }}</div>
        <div
          v-for="s in sources"
          :key="s.id"
          :ref="setEl(s.id)"
          class="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-(--uf-surface) ring-1 ring-(--ui-border-muted) shadow-(--uf-shadow) min-w-0"
        >
          <PersonAvatar v-if="s.kind === 'person'" :avatar="s.avatar!" :color="s.color!" :size="28" :home="s.online ?? null" />
          <span v-else class="size-7 rounded-full flex items-center justify-center bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) text-toned shrink-0">
            <UIcon :name="s.kind === 'network' ? 'i-lucide-network' : s.kind === 'all' ? 'i-lucide-users' : 'i-lucide-monitor-smartphone'" class="size-3.5" />
          </span>
          <div class="min-w-0">
            <div class="text-[13px] font-medium text-highlighted truncate">{{ s.label }}</div>
            <div class="text-[11px] text-dimmed truncate uf-mono">{{ s.sub }}</div>
          </div>
        </div>
      </div>

      <!-- Routes -->
      <div class="relative flex flex-col gap-2.5">
        <div class="uf-section-title mb-0.5">{{ t('dashboard.colRoutes') }}</div>
        <NuxtLink
          v-for="r in routes"
          :key="r.id"
          :ref="(el: any) => setEl(`r:${r.id}`)(el?.$el ?? el)"
          :to="`/routes/${r.id}`"
          class="group block px-3 py-2.5 rounded-lg bg-(--uf-surface) ring-1 shadow-(--uf-shadow) transition hover:shadow-(--uf-shadow-lg)"
          :class="r.state === 'drift' || r.state === 'error' ? 'ring-warning/50' : 'ring-(--ui-border-muted) hover:ring-(--ui-border-accented)'"
        >
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-waypoints" class="size-3.5 text-dimmed" />
            <span class="text-[13px] font-medium text-highlighted truncate flex-1">{{ r.name }}</span>
            <UIcon v-if="r.state === 'drift'" name="i-lucide-triangle-alert" class="size-3.5 text-warning" />
            <UIcon v-else-if="r.activeOverride" name="i-lucide-timer" class="size-3.5 text-vpn" />
            <UIcon v-else-if="r.schedule" name="i-lucide-calendar-clock" class="size-3.5 text-primary" />
          </div>
          <div v-if="r.next" class="mt-1 text-[11px] text-dimmed flex items-center gap-1 truncate">
            <UIcon name="i-lucide-arrow-right-left" class="size-3" />
            {{ fmt.time(r.next.at) }} → {{ egresses.find(e => e.id === r.next!.egressId)?.name }}
          </div>
          <div v-else class="mt-1 text-[11px] text-dimmed">{{ t(`routes.reason.${r.desired.reason}`) }}</div>
        </NuxtLink>
      </div>

      <!-- Egresses -->
      <div class="relative flex flex-col gap-2.5">
        <div class="uf-section-title mb-0.5">{{ t('dashboard.colEgresses') }}</div>
        <div
          v-for="e in egressNodes"
          :key="e.id"
          :ref="setEl(`e:${e.id}`)"
          class="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-(--uf-surface) ring-1 shadow-(--uf-shadow) min-w-0"
          :style="{ '--tw-ring-color': `color-mix(in oklab, ${e.color} 35%, transparent)` }"
        >
          <span class="relative size-8 shrink-0 rounded-full flex items-center justify-center" :style="{ background: `color-mix(in oklab, ${e.color} 14%, transparent)`, color: e.color }">
            <svg class="absolute inset-0 -rotate-90" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14.5" fill="none" :stroke="latencyColor(e.health.latencyMs)" stroke-width="2" :stroke-dasharray="`${e.health.status === 'down' ? 91 : Math.max(8, 91 - (e.health.latencyMs ?? 0) / 3)} 91`" stroke-linecap="round" /></svg>
            <UIcon :name="egressKindIcon[e.kind]" class="size-3.5" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="text-[13px] font-medium text-highlighted truncate">{{ e.name }}</span>
              <CountryFlag v-if="e.publicIp" :code="e.publicIp.country" :size="13" />
            </div>
            <div class="text-[11px] text-dimmed flex items-center gap-1.5">
              <StatusDot :status="e.health.status" :size="6" />
              <span class="uf-num">{{ e.health.status === 'down' ? t('health.down') : fmt.ms(e.health.latencyMs) }}</span>
              <span v-if="e.publicIp" class="uf-mono truncate">· {{ e.publicIp.ip }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Internet -->
      <div class="relative flex items-center justify-center self-stretch">
        <div :ref="setEl('internet')" class="relative size-14 rounded-full bg-(--uf-surface) ring-1 ring-(--ui-border) shadow-(--uf-shadow-lg) flex items-center justify-center">
          <div class="absolute inset-0 rounded-full bg-primary/10 animate-ping [animation-duration:3s]" />
          <UIcon name="i-lucide-globe" class="size-6 text-primary relative" />
        </div>
      </div>
    </div>

    <!-- Mobile: compact route list -->
    <div class="md:hidden space-y-2">
      <NuxtLink v-for="r in routes" :key="r.id" :to="`/routes/${r.id}`" class="flex items-center gap-3 p-3 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted)">
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium text-highlighted truncate">{{ r.name }}</div>
          <div class="text-[11px] text-dimmed truncate">{{ r.targets.map(tg => sourceFor(tg).label).join(', ') }}</div>
        </div>
        <UIcon name="i-lucide-arrow-right" class="size-3.5 text-dimmed" />
        <EgressChip :id="r.actualEgressId ?? r.desired.egressId" size="xs" show-health />
      </NuxtLink>
    </div>

    <div v-if="!routes.length" class="py-4">
      <EmptyState icon="i-lucide-waypoints" :title="t('dashboard.noRoutes')" :description="t('dashboard.noRoutesDesc')">
        <UButton to="/routes" icon="i-lucide-plus">{{ t('routes.add') }}</UButton>
      </EmptyState>
      <div v-if="egresses.length" class="flex flex-wrap justify-center gap-1.5 max-w-2xl mx-auto -mt-2">
        <EgressChip v-for="e in egresses" :key="e.id" :id="e.id" size="sm" show-health />
      </div>
    </div>
  </div>
</template>
