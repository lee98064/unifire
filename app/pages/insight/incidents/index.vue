<script setup lang="ts">
import type { IncidentT } from '#shared/schemas/infra'

const { t, te } = useI18n()
const fmt = useFormat()
const route = useRoute()
const router = useRouter()
const status = computed<'all' | 'open' | 'resolved'>({
  get: () => (route.query.status === 'open' || route.query.status === 'resolved' ? route.query.status : 'all'),
  set: v => router.replace({ query: { ...route.query, status: v === 'all' ? undefined : v } }),
})
const { data, status: loadStatus, error } = useFetch<{ items: IncidentT[], nextCursor: string | null }>('/api/incidents', {
  key: 'incidents',
  query: computed(() => ({ limit: 100, ...(status.value === 'all' ? {} : { status: status.value }) })),
  default: () => ({ items: [], nextCursor: null }),
})
const title = (i: IncidentT) => (te(i.titleKey) ? t(i.titleKey, i.titleParams) : i.titleKey)
const open = computed(() => data.value.items.filter(i => i.status === 'open'))
const past = computed(() => data.value.items.filter(i => i.status === 'resolved'))
const duration = (i: IncidentT) => fmt.duration((i.resolvedAt ?? Date.now()) - i.openedAt)
const rootIcon: Record<string, string> = {
  egress_down: 'i-lucide-cloud-off', wan_down: 'i-lucide-cable', device_offline: 'i-lucide-server-off', device_rebooted: 'i-lucide-rotate-ccw',
  uplink_down: 'i-lucide-unplug', port_issue: 'i-lucide-cable', mass_disconnect: 'i-lucide-users-round',
}
/** Group resolved incidents by local day for the timeline. */
const days = computed(() => {
  const m = new Map<string, IncidentT[]>()
  for (const i of past.value) {
    const k = fmt.date(i.openedAt)
    m.set(k, [...(m.get(k) ?? []), i])
  }
  return [...m.entries()]
})
</script>

<template>
  <div>
    <PageHeader :title="t('nav.incidents')" :description="t('incidents.desc')" icon="i-lucide-siren">
      <template #actions>
        <UTabs v-model="status" :content="false" size="sm" :items="[{ value: 'all', label: t('incidents.filter.all') }, { value: 'open', label: t('incidents.filter.open') }, { value: 'resolved', label: t('incidents.filter.resolved') }]" />
      </template>
    </PageHeader>

    <div v-if="error && !data.items.length" class="uf-card"><EmptyState icon="i-lucide-siren" :title="t('incidents.unavailable')" :description="t('incidents.unavailableDesc')" /></div>
    <USkeleton v-else-if="loadStatus === 'pending' && !data.items.length" class="h-40 rounded-xl" />
    <div v-else-if="!data.items.length" class="uf-card">
      <EmptyState icon="i-lucide-shield-check" :title="t('incidents.empty')" :description="t('incidents.emptyDesc')" />
    </div>

    <template v-else>
      <section v-if="open.length" class="mb-7">
        <h2 class="uf-section-title mb-2.5">{{ t('incidents.ongoing') }}</h2>
        <div class="space-y-3">
          <NuxtLink
            v-for="i in open"
            :key="i.id"
            :to="`/insight/incidents/${i.id}`"
            class="block rounded-xl p-4 ring-1 transition hover:-translate-y-px hover:shadow-(--uf-shadow-lg)"
            :class="i.severity === 'critical' ? 'bg-error/6 ring-error/35' : 'bg-warning/6 ring-warning/35'"
          >
            <div class="flex items-start gap-3">
              <span class="relative size-10 rounded-xl flex items-center justify-center shrink-0" :class="i.severity === 'critical' ? 'bg-error/15 text-error' : 'bg-warning/15 text-warning'">
                <span class="absolute inset-0 rounded-xl animate-ping opacity-25" :class="i.severity === 'critical' ? 'bg-error' : 'bg-warning'" />
                <UIcon :name="rootIcon[i.root?.kind ?? ''] ?? 'i-lucide-siren'" class="size-5 relative" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[14.5px] font-semibold text-highlighted">{{ title(i) }}</span>
                  <UBadge :color="i.severity === 'critical' ? 'error' : 'warning'" variant="solid" size="xs">{{ t(`incidents.severity.${i.severity}`) }}</UBadge>
                  <UBadge v-if="i.acknowledged" color="neutral" variant="soft" size="xs" icon="i-lucide-eye">{{ t('incidents.acked') }}</UBadge>
                </div>
                <div class="mt-1 text-[12.5px] text-muted flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>{{ t('incidents.startedAgo') }} <TimeAgo :ts="i.openedAt" /> · {{ duration(i) }}</span>
                  <span>{{ t('incidents.impact', { devices: i.impact.devices.length, clients: i.impact.clients }) }}</span>
                  <span v-if="i.suspectCount" class="text-warning flex items-center gap-1"><UIcon name="i-lucide-git-compare-arrows" class="size-3.5" />{{ t('incidents.suspectsN', { n: i.suspectCount }) }}</span>
                </div>
              </div>
              <UIcon name="i-lucide-chevron-right" class="size-4 text-dimmed mt-3" />
            </div>
          </NuxtLink>
        </div>
      </section>

      <section v-if="past.length">
        <h2 class="uf-section-title mb-2.5">{{ t('incidents.history') }}</h2>
        <div class="space-y-5">
          <div v-for="[day, items] in days" :key="day">
            <div class="text-[12px] font-medium text-dimmed mb-2">{{ day }}</div>
            <div class="uf-card divide-y divide-(--ui-border-muted)">
              <NuxtLink v-for="i in items" :key="i.id" :to="`/insight/incidents/${i.id}`" class="flex items-center gap-3 px-4 py-3 hover:bg-(--uf-hover) transition first:rounded-t-xl last:rounded-b-xl">
                <span class="size-8 rounded-lg flex items-center justify-center shrink-0" :class="i.severity === 'critical' ? 'bg-error/10 text-error' : 'bg-warning/10 text-warning'">
                  <UIcon :name="rootIcon[i.root?.kind ?? ''] ?? 'i-lucide-siren'" class="size-4" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-[13px] font-medium text-highlighted truncate">{{ title(i) }}</div>
                  <div class="text-[11.5px] text-dimmed uf-num">{{ fmt.time(i.openedAt) }} → {{ fmt.time(i.resolvedAt) }} · {{ duration(i) }} · {{ t('incidents.impact', { devices: i.impact.devices.length, clients: i.impact.clients }) }}</div>
                </div>
                <UIcon v-if="i.note" name="i-lucide-sticky-note" class="size-3.5 text-dimmed" />
                <UBadge color="success" variant="soft" size="xs" icon="i-lucide-check">{{ t('incidents.resolved') }}</UBadge>
              </NuxtLink>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
