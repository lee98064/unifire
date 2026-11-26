<script setup lang="ts">
import type { SnapshotT, SnapshotDiffT, RestorePlanT, DiffChangeT, SnapshotResourceT } from '#shared/schemas/insight'

const { t, te } = useI18n()
const fmt = useFormat()
const api = useApi()
const { data: snaps, refresh } = useFetch<{ items: SnapshotT[], nextCursor: string | null }>('/api/snapshots', { key: 'snapshots', query: { limit: 100 }, default: () => ({ items: [], nextCursor: null }) })

const selectedId = ref<string | null>(null)
const compareTo = ref<'previous' | 'live'>('previous')
watch(snaps, (v) => { if (!selectedId.value && v.items[0]) selectedId.value = v.items[0].id }, { immediate: true })
const selectedIdx = computed(() => snaps.value.items.findIndex(s => s.id === selectedId.value))
const diffQuery = computed(() => {
  const cur = snaps.value.items[selectedIdx.value]
  if (!cur) return null
  if (compareTo.value === 'live') return { from: cur.id }
  const prev = snaps.value.items[selectedIdx.value + 1]
  return prev ? { from: prev.id, to: cur.id } : null
})
const { data: diff, status: diffStatus, execute: loadDiff } = useFetch<SnapshotDiffT>('/api/snapshots/diff', { query: diffQuery, immediate: false, watch: false })
watch(diffQuery, (q) => { if (q) loadDiff() }, { immediate: true })

const byResource = computed(() => {
  const m = new Map<SnapshotResourceT, DiffChangeT[]>()
  for (const c of diff.value?.changes ?? []) {
    if (!m.has(c.resource)) m.set(c.resource, [])
    m.get(c.resource)!.push(c)
  }
  return [...m.entries()]
})
const expanded = ref(new Set<string>())
function toggleExpand(k: string) { expanded.value.has(k) ? expanded.value.delete(k) : expanded.value.add(k) }
const picked = ref(new Set<string>())
const key = (c: DiffChangeT) => `${c.resource}::${c.itemId}`
function togglePick(c: DiffChangeT) { const k = key(c); picked.value.has(k) ? picked.value.delete(k) : picked.value.add(k) }

const creating = ref(false)
async function create() {
  creating.value = true
  try { await api.post('/api/snapshots', {}, { success: t('snapshots.created') }); await refresh() }
  finally { creating.value = false }
}

/* restore */
const plan = ref<RestorePlanT | null>(null)
const planOpen = ref(false)
const restoring = ref(false)
// Restoring "from" state means: revert the selected snapshot's changes back to the older snapshot.
const restoreSource = computed(() => compareTo.value === 'live' ? snaps.value.items[selectedIdx.value]?.id : snaps.value.items[selectedIdx.value + 1]?.id)
async function previewRestore() {
  if (!restoreSource.value) return
  const items = [...picked.value].map(k => { const [resource, itemId] = k.split('::'); return { resource, itemId } })
  plan.value = await api.post<RestorePlanT>(`/api/snapshots/${restoreSource.value}/restore`, { items, dryRun: true })
  planOpen.value = true
}
async function applyRestore() {
  if (!restoreSource.value) return
  restoring.value = true
  try {
    const items = [...picked.value].map(k => { const [resource, itemId] = k.split('::'); return { resource, itemId } })
    plan.value = await api.post<RestorePlanT>(`/api/snapshots/${restoreSource.value}/restore`, { items, dryRun: false }, { success: t('snapshots.restored') })
    picked.value.clear()
    refresh()
  }
  finally { restoring.value = false }
}
const kindUi = { added: { color: 'success', icon: 'i-lucide-plus' }, removed: { color: 'error', icon: 'i-lucide-minus' }, modified: { color: 'warning', icon: 'i-lucide-pencil' } } as const
const triggerIcon: Record<string, string> = { scheduled: 'i-lucide-alarm-clock', 'pre-write': 'i-lucide-shield', manual: 'i-lucide-hand', 'pre-restore': 'i-lucide-undo-2' }
const msg = useMsg()
// Summary params carry raw ids (resource "trafficroutes", state "true") — localise before interpolating.
function summary(c: DiffChangeT) {
  if (!te(c.summaryKey)) return `${c.kind} ${c.itemLabel}`
  const p: Record<string, string> = { ...c.summaryParams }
  if (p.resource && te(`snapshots.resourceShort.${p.resource}`)) p.resource = t(`snapshots.resourceShort.${p.resource}`)
  if (p.state === 'true' || p.state === 'false') p.state = t(p.state === 'true' ? 'snapshots.state.on' : 'snapshots.state.off')
  return t(c.summaryKey, p)
}
const stepNote = (s: RestorePlanT['steps'][number]) => (s.error ? msg(s.error) : s.reason ? (te(`snapshots.reason.${s.reason}`) ? t(`snapshots.reason.${s.reason}`) : s.reason) : '')
const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))
</script>

<template>
  <div>
    <PageHeader :title="t('nav.snapshots')" :description="t('snapshots.desc')" icon="i-lucide-history">
      <template #actions><UButton icon="i-lucide-camera" :loading="creating" @click="create">{{ t('snapshots.create') }}</UButton></template>
    </PageHeader>

    <div class="grid lg:grid-cols-[300px_1fr] gap-5 items-start">
      <!-- timeline -->
      <div class="uf-card p-2 lg:sticky lg:top-20 max-h-[calc(100dvh-120px)] overflow-y-auto">
        <button
          v-for="(s, i) in snaps.items"
          :key="s.id"
          type="button"
          class="w-full text-left flex gap-3 px-2.5 py-2.5 rounded-lg transition relative"
          :class="s.id === selectedId ? 'bg-primary/10' : 'hover:bg-(--uf-hover)'"
          @click="selectedId = s.id"
        >
          <div class="flex flex-col items-center">
            <span class="size-7 rounded-full flex items-center justify-center ring-1" :class="s.id === selectedId ? 'bg-primary text-white ring-primary' : 'bg-(--uf-surface) ring-(--ui-border) text-toned'">
              <UIcon :name="triggerIcon[s.trigger] ?? 'i-lucide-camera'" class="size-3.5" />
            </span>
            <span v-if="i < snaps.items.length - 1" class="flex-1 w-px bg-(--ui-border-muted) mt-1 min-h-3" />
          </div>
          <div class="min-w-0 flex-1 pb-1">
            <div class="text-[13px] font-medium text-highlighted">{{ fmt.dateTime(s.ts) }}</div>
            <div class="text-[11.5px] text-dimmed">{{ t(`snapshots.trigger.${s.trigger}`) }}<template v-if="s.note"> · {{ s.note }}</template></div>
            <div class="mt-1 flex gap-1.5">
              <UBadge v-if="s.changeCount" color="warning" variant="subtle" size="xs">{{ t('snapshots.changesN', { n: s.changeCount }) }}</UBadge>
              <UBadge v-else-if="s.changeCount === 0" color="neutral" variant="subtle" size="xs">{{ t('snapshots.noChanges') }}</UBadge>
              <UBadge v-if="!s.complete" color="error" variant="subtle" size="xs">{{ t('snapshots.incomplete') }}</UBadge>
            </div>
          </div>
        </button>
        <EmptyState v-if="!snaps.items.length" icon="i-lucide-history" :title="t('snapshots.empty')" />
      </div>

      <!-- diff -->
      <div>
        <div class="flex flex-wrap items-center gap-3 mb-4">
          <UTabs v-model="compareTo" :content="false" size="sm" :items="[{ value: 'previous', label: t('snapshots.vsPrevious'), icon: 'i-lucide-git-compare' }, { value: 'live', label: t('snapshots.vsLive'), icon: 'i-lucide-radio' }]" />
          <span class="text-[12px] text-dimmed">{{ compareTo === 'live' ? t('snapshots.vsLiveHint') : t('snapshots.vsPreviousHint') }}</span>
          <UButton v-if="picked.size" class="ml-auto" color="warning" icon="i-lucide-undo-2" @click="previewRestore">{{ t('snapshots.restoreN', { n: picked.size }) }}</UButton>
        </div>

        <UAlert v-if="diff?.unavailableResources?.length" class="mb-4" color="warning" variant="subtle" icon="i-lucide-triangle-alert"
          :title="t('snapshots.unavailable')" :description="diff.unavailableResources.map(r => t(`snapshots.resource.${r}`)).join('、')" />
        <div v-if="diffStatus === 'pending'" class="space-y-3"><USkeleton v-for="i in 3" :key="i" class="h-24 rounded-xl" /></div>
        <div v-else-if="!diffQuery" class="uf-card"><EmptyState icon="i-lucide-git-compare" :title="t('snapshots.firstSnapshot')" /></div>
        <div v-else-if="!byResource.length" class="uf-card"><EmptyState icon="i-lucide-check-check" :title="t('snapshots.identical')" :description="t('snapshots.identicalDesc')" /></div>
        <div v-else class="space-y-4">
          <div v-for="[res, changes] in byResource" :key="res" class="uf-card overflow-hidden">
            <div class="px-4 py-2.5 border-b border-(--ui-border-muted) flex items-center gap-2 bg-(--uf-surface-2)">
              <span class="text-[13px] font-semibold text-highlighted">{{ t(`snapshots.resource.${res}`) }}</span>
              <UBadge color="neutral" variant="subtle" size="xs">{{ changes.length }}</UBadge>
            </div>
            <div class="divide-y divide-(--ui-border-muted)">
              <div v-for="c in changes" :key="key(c)">
                <div class="flex items-center gap-3 px-4 py-3">
                  <UCheckbox v-if="c.restorable" :model-value="picked.has(key(c))" @update:model-value="togglePick(c)" />
                  <span v-else class="size-4" />
                  <UBadge :color="kindUi[c.kind].color" variant="subtle" size="sm" :icon="kindUi[c.kind].icon">{{ t(`snapshots.kind.${c.kind}`) }}</UBadge>
                  <button type="button" class="min-w-0 flex-1 text-left" @click="toggleExpand(key(c))">
                    <div class="text-[13px] text-highlighted truncate">{{ summary(c) }}</div>
                    <div class="text-[11.5px] text-dimmed truncate">{{ c.itemLabel }} · {{ t('snapshots.fieldsN', { n: c.fields.length }) }}</div>
                  </button>
                  <UIcon name="i-lucide-chevron-down" class="size-4 text-dimmed transition-transform" :class="expanded.has(key(c)) ? 'rotate-180' : ''" />
                </div>
                <div v-if="expanded.has(key(c))" class="px-4 pb-4 pl-[60px]">
                  <div class="rounded-lg ring-1 ring-(--ui-border-muted) overflow-hidden text-[12px] uf-mono">
                    <div v-for="f in c.fields" :key="f.path" class="grid grid-cols-[minmax(120px,200px)_1fr_1fr] border-b last:border-b-0 border-(--ui-border-muted)">
                      <div class="px-2.5 py-1.5 bg-(--uf-surface-2) text-dimmed truncate" :title="f.path">{{ f.path }}</div>
                      <div class="px-2.5 py-1.5 bg-error/6 text-error break-all"><span class="opacity-60 mr-1">−</span>{{ f.secret ? '••••••' : (f.beforeLabel ?? show(f.before)) }}</div>
                      <div class="px-2.5 py-1.5 bg-success/6 text-success break-all"><span class="opacity-60 mr-1">+</span>{{ f.secret ? '••••••' : (f.afterLabel ?? show(f.after)) }}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <UModal v-model:open="planOpen" :title="plan?.dryRun ? t('snapshots.planTitle') : t('snapshots.resultTitle')" :description="plan?.dryRun ? t('snapshots.planDesc') : ''" :ui="{ content: 'sm:max-w-3xl' }">
      <template #body>
        <div v-if="plan" class="space-y-3">
          <div v-for="(s, i) in plan.steps" :key="i" class="rounded-lg ring-1 ring-(--ui-border-muted) overflow-hidden">
            <div class="flex items-center gap-2 px-3 py-2 bg-(--uf-surface-2)">
              <UBadge :color="s.method === 'DELETE' ? 'error' : s.method === 'POST' ? 'success' : 'primary'" variant="solid" size="xs" class="uf-mono">{{ s.method }}</UBadge>
              <code class="text-[11.5px] text-toned truncate flex-1">{{ s.path }}</code>
              <UBadge v-if="!s.supported" color="neutral" variant="subtle" size="xs">{{ t('snapshots.unsupported') }}</UBadge>
              <UBadge v-else-if="s.result !== 'pending'" :color="s.result === 'applied' ? 'success' : s.result === 'failed' ? 'error' : 'neutral'" variant="subtle" size="xs">{{ t(`snapshots.result.${s.result}`) }}</UBadge>
            </div>
            <div class="px-3 py-2 text-[12.5px] text-highlighted">{{ s.label }}<span v-if="s.reason || s.error" class="text-dimmed"> — {{ stepNote(s) }}</span></div>
            <pre v-if="s.body" class="px-3 py-2 text-[11px] uf-mono text-toned max-h-48 overflow-auto bg-(--uf-surface-2)/50 border-t border-(--ui-border-muted)">{{ JSON.stringify(s.body, null, 2) }}</pre>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" @click="planOpen = false">{{ plan?.dryRun ? t('common.cancel') : t('common.close') }}</UButton>
          <UButton v-if="plan?.dryRun" color="warning" icon="i-lucide-undo-2" :loading="restoring" :disabled="!plan.steps.some(s => s.supported)" @click="applyRestore">{{ t('snapshots.applyRestore') }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
