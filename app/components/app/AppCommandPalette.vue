<script setup lang="ts">
import type { ClientT } from '#shared/schemas/access'
import type { ManagedRouteT } from '#shared/schemas/routes'
import { adminNav, settingsNav } from '~/utils/nav'
import { egressKindIcon } from '~/utils/egress'
import { compareDevices, deviceTypeIcon } from '~/utils/devices'
import type { InfraDeviceT } from '#shared/schemas/infra'

const open = useState('cmdk-open', () => false)
const { t } = useI18n()
const api = useApi()
const { egresses } = useEgresses()
const { people } = usePeople()
const fmt = useFormat()

const clients = useFetch<ClientT[]>('/api/clients', { key: 'clients', default: () => [], immediate: false, dedupe: 'defer' })
const routes = useFetch<ManagedRouteT[]>('/api/managed-routes', { key: 'managed-routes', default: () => [], immediate: false, dedupe: 'defer' })
const devices = useFetch<InfraDeviceT[]>('/api/devices', { key: 'devices', default: () => [], immediate: false, dedupe: 'defer' })
watch(open, (v) => {
  if (v) {
    if (!clients.data.value.length) clients.execute()
    if (!routes.data.value.length) routes.execute()
    if (!devices.data.value.length) devices.execute()
  }
})
const sortedDevices = computed(() => [...devices.data.value].sort(compareDevices))

defineShortcuts({
  meta_k: { usingInput: true, handler: () => (open.value = !open.value) },
})

const durations = [30, 60, 120, 240, 480]

const groups = computed(() => [
  {
    id: 'actions',
    label: t('cmdk.actions'),
    items: [
      {
        label: t('cmdk.overrideEgress'),
        icon: 'i-lucide-route',
        children: routes.data.value.map(r => ({
          label: r.name,
          suffix: egresses.value.find(e => e.id === r.actualEgressId)?.name,
          icon: 'i-lucide-waypoints',
          children: egresses.value.filter(e => e.id !== r.actualEgressId).map(e => ({
            label: e.name,
            icon: egressKindIcon[e.kind],
            children: durations.map(m => ({
              label: fmt.minutes(m),
              icon: 'i-lucide-timer',
              onSelect: async () => {
                open.value = false
                await api.post(`/api/managed-routes/${r.id}/override`, { egressId: e.id, minutes: m }, { success: t('cmdk.overrideDone', { route: r.name, egress: e.name }) })
                refreshNuxtData(['managed-routes', 'dashboard'])
              },
            })),
          })),
        })),
      },
      {
        label: t('cmdk.pausePerson'),
        icon: 'i-lucide-circle-pause',
        children: people.value.map(p => ({
          label: `${p.avatar} ${p.name}`,
          suffix: p.pause.active ? t('people.paused') : undefined,
          children: [...durations, null].map(m => ({
            label: m ? fmt.minutes(m) : t('people.untilResume'),
            icon: 'i-lucide-timer',
            onSelect: async () => {
              open.value = false
              await api.post(`/api/people/${p.id}/pause`, { minutes: m }, { success: t('people.pausedToast', { name: p.name }) })
              refreshNuxtData(['people'])
            },
          })),
        })),
      },
      {
        label: t('cmdk.locate'),
        icon: 'i-lucide-locate-fixed',
        children: sortedDevices.value.filter(d => d.state !== 'offline').map(d => ({
          label: d.name,
          suffix: d.modelName ?? d.model ?? undefined,
          icon: deviceTypeIcon[d.type],
          onSelect: async () => {
            open.value = false
            await api.post(`/api/devices/${encodeURIComponent(d.mac)}/locate`, { on: true, minutes: 5 }, { success: t('devices.locateStarted', { name: d.name, n: 5 }) })
            refreshNuxtData(['devices', 'device-detail'])
          },
        })),
      },
      { label: t('cmdk.sweep'), icon: 'i-lucide-radar', onSelect: async () => { open.value = false; await api.post('/api/egresses/sweep', {}, { success: t('egresses.sweepStarted') }) } },
      { label: t('cmdk.snapshot'), icon: 'i-lucide-camera', onSelect: async () => { open.value = false; await api.post('/api/snapshots', {}, { success: t('snapshots.created') }) } },
    ],
  },
  {
    id: 'nav',
    label: t('cmdk.navigate'),
    items: [...adminNav.flat(), settingsNav].map(i => ({ label: t(i.label), icon: i.icon, to: i.to, onSelect: () => (open.value = false) })),
  },
  {
    id: 'devices',
    label: t('nav.devices'),
    items: sortedDevices.value.map(d => ({
      label: d.name,
      suffix: `${d.modelName ?? d.model ?? ''} ${d.ip ?? ''} ${d.mac}`,
      icon: deviceTypeIcon[d.type],
      to: `/devices/${encodeURIComponent(d.mac)}`,
      onSelect: () => (open.value = false),
    })),
  },
  {
    id: 'people',
    label: t('nav.people'),
    items: people.value.map(p => ({ label: `${p.avatar} ${p.name}`, suffix: p.presence.home ? t('people.home') : t('people.away'), to: `/people?person=${p.id}`, onSelect: () => (open.value = false) })),
  },
  {
    id: 'clients',
    label: t('nav.clients'),
    items: clients.data.value.map(c => ({
      label: c.displayName,
      suffix: `${c.ip ?? ''} ${c.mac}`,
      icon: c.wired ? 'i-lucide-ethernet-port' : 'i-lucide-wifi',
      to: `/clients?mac=${c.mac}`,
      onSelect: () => (open.value = false),
    })),
  },
])
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'sm:max-w-2xl p-0 overflow-hidden' }" :title="t('topbar.search')" :description="t('cmdk.hint')">
    <template #content>
      <UCommandPalette
        :groups="groups"
        :placeholder="t('cmdk.placeholder')"
        :fuse="{ resultLimit: 8, fuseOptions: { keys: ['label', 'suffix'], threshold: 0.35 } }"
        class="h-[min(70vh,520px)]"
        close
        @update:open="open = $event"
      />
    </template>
  </UModal>
</template>
