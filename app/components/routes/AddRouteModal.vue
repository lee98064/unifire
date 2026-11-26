<script setup lang="ts">
import type { ManagedRouteT, UnifiRouteT, RouteTargetT, MatchingTargetT } from '#shared/schemas/routes'
import type { ClientT } from '#shared/schemas/access'

const props = defineProps<{ unifiRoutes: UnifiRouteT[], preselect?: string | null }>()
const open = defineModel<boolean>('open', { default: false })
const { t, te } = useI18n()
const toast = useToast()
const matchLabel = (v: string) => (te(`routes.match.${v}`) ? t(`routes.match.${v}`) : v)
const api = useApi()
const { egresses } = useEgresses()
const { people } = usePeople()
const { networks } = useNetworks()
const { data: clients } = useFetch<ClientT[]>('/api/clients', { key: 'clients', default: () => [] })

const mode = ref<'adopt' | 'create'>('create')
const busy = ref(false)

/* adopt */
const adoptId = ref<string | null>(null)
// Only routes Unifire can model: known matching type, egress-based (not next-hop), no unfamiliar target types.
const adoptable = computed(() => props.unifiRoutes.filter(r => r.ownership === 'external' && r.egressId && ['INTERNET', 'DOMAIN', 'IP', 'REGION'].includes(r.matchingTarget) && r.targets.every(tg => tg.type !== 'OTHER')))
watch(() => props.preselect, (v) => { if (v) { mode.value = 'adopt'; adoptId.value = v } }, { immediate: true })
// Routes another script keeps switching can be adopted once the admin confirms that script is stopped.
const adoptAck = ref(false)
const adoptSuspected = computed(() => !!adoptable.value.find(r => r.id === adoptId.value)?.suspectedAutomation)
watch(adoptId, () => { adoptAck.value = false })

/* create */
const form = reactive({
  name: '',
  sourceType: 'person' as 'person' | 'client' | 'network',
  personId: undefined as string | undefined,
  macs: [] as string[],
  networkId: undefined as string | undefined,
  matchingTarget: 'INTERNET' as MatchingTargetT,
  destinations: '',
  killSwitch: true,
  defaultEgressId: null as string | null,
})

const targets = computed<RouteTargetT[]>(() => {
  if (form.sourceType === 'network' && form.networkId) return [{ type: 'NETWORK', networkId: form.networkId }]
  if (form.sourceType === 'person' && form.personId) return (people.value.find(p => p.id === form.personId)?.deviceMacs ?? []).map(mac => ({ type: 'CLIENT' as const, mac }))
  return form.macs.map(mac => ({ type: 'CLIENT' as const, mac }))
})
const canCreate = computed(() => form.name && targets.value.length && form.defaultEgressId && (form.matchingTarget === 'INTERNET' || form.destinations.trim()))

const clientItems = computed(() => clients.value.map(c => ({ label: c.displayName, value: c.mac, description: `${c.ip ?? ''} · ${c.mac}` })))
const personItems = computed(() => people.value.map(p => ({ label: `${p.avatar} ${p.name}`, value: p.id, description: t('dashboard.devicesN', { n: p.deviceMacs.length }) })))
const networkItems = computed(() => networks.value.filter(n => n.purpose === 'corporate' || n.purpose === 'guest').map(n => ({ label: n.name, value: n.id, description: n.subnet ?? '' })))

async function submit() {
  busy.value = true
  try {
    const body = mode.value === 'adopt'
      ? { mode: 'adopt', unifiRouteId: adoptId.value, acknowledgeAutomation: adoptSuspected.value && adoptAck.value }
      : {
          mode: 'create',
          name: form.name,
          targets: targets.value,
          matchingTarget: form.matchingTarget,
          destinations: form.destinations.split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
          killSwitch: form.killSwitch,
          defaultEgressId: form.defaultEgressId,
        }
    const r = await api.post<ManagedRouteT>('/api/managed-routes', body)
    open.value = false
    // Dry-run creates return a transient preview (unifiRouteId "dry-run:…") that is never persisted.
    if (r.unifiRouteId.startsWith('dry-run:')) {
      toast.add({ title: t('routes.dryRunCreated'), description: t('routes.dryRunCreatedDesc'), color: 'warning', icon: 'i-lucide-flask-conical' })
      return
    }
    toast.add({ title: t('routes.addDone'), color: 'success', icon: 'i-lucide-check-circle-2' })
    refreshNuxtData(['managed-routes', 'routes'])
    await navigateTo(`/routes/${r.id}`)
  }
  finally { busy.value = false }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('routes.add')" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <div class="grid grid-cols-2 gap-2 p-1 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) mb-5">
        <button
          v-for="m in (['create', 'adopt'] as const)"
          :key="m"
          type="button"
          class="h-9 rounded-md text-[13px] font-medium transition flex items-center justify-center gap-2"
          :class="mode === m ? 'bg-(--uf-surface) text-highlighted shadow-(--uf-shadow) ring-1 ring-(--ui-border-muted)' : 'text-muted hover:text-highlighted'"
          @click="mode = m"
        >
          <UIcon :name="m === 'create' ? 'i-lucide-plus' : 'i-lucide-hand-helping'" class="size-4" />{{ t(`routes.mode.${m}`) }}
        </button>
      </div>

      <!-- Adopt -->
      <div v-if="mode === 'adopt'" class="space-y-3">
        <p class="text-[12.5px] text-muted">{{ t('routes.adoptHint') }}</p>
        <div class="max-h-[46vh] overflow-y-auto space-y-1.5 -mx-1 px-1">
          <button
            v-for="r in adoptable"
            :key="r.id"
            type="button"
            class="w-full flex items-center gap-3 p-3 rounded-lg ring-1 text-left transition"
            :class="adoptId === r.id ? 'ring-2 ring-primary bg-primary/5' : 'ring-(--ui-border-muted) hover:ring-(--ui-border-accented)'"
            @click="adoptId = r.id"
          >
            <URadioGroup :model-value="adoptId ?? undefined" :items="[{ value: r.id, label: '' }]" class="pointer-events-none" />
            <div class="min-w-0 flex-1">
              <div class="text-[13px] font-medium text-highlighted truncate">{{ r.description || t('routes.unnamed') }}</div>
              <div class="text-[11.5px] text-dimmed truncate">{{ matchLabel(r.matchingTarget) }} · {{ r.targets.length }} {{ t('routes.sources') }}</div>
            </div>
            <UBadge v-if="r.suspectedAutomation" color="warning" variant="subtle" size="sm" icon="i-lucide-bot">{{ t('routes.suspectedAutomation') }}</UBadge>
            <EgressChip :id="r.egressId" size="xs" />
          </button>
          <EmptyState v-if="!adoptable.length" icon="i-lucide-inbox" :title="t('routes.noAdoptable')" />
        </div>
        <UAlert v-if="adoptSuspected" color="warning" variant="subtle" icon="i-lucide-bot" :title="t('routes.suspectedAutomation')" :description="t('routes.suspectedAutomationHint')">
          <template #actions>
            <UCheckbox v-model="adoptAck" :label="t('routes.adoptAutomationAck')" />
          </template>
        </UAlert>
      </div>

      <!-- Create -->
      <div v-else class="space-y-5">
        <UFormField :label="t('routes.name')" required>
          <UInput v-model="form.name" class="w-full" :placeholder="t('routes.namePh')" />
        </UFormField>

        <div>
          <div class="text-[13px] font-medium text-highlighted mb-2">{{ t('routes.source') }}</div>
          <div class="flex gap-1.5 mb-3">
            <UButton v-for="s in (['person', 'client', 'network'] as const)" :key="s" size="sm" :color="form.sourceType === s ? 'primary' : 'neutral'" :variant="form.sourceType === s ? 'solid' : 'outline'" @click="form.sourceType = s">{{ t(`routes.sourceType.${s}`) }}</UButton>
          </div>
          <USelectMenu v-if="form.sourceType === 'person'" v-model="form.personId" :items="personItems" value-key="value" class="w-full" :placeholder="t('routes.pickPerson')" />
          <USelectMenu v-else-if="form.sourceType === 'client'" v-model="form.macs" :items="clientItems" value-key="value" multiple class="w-full" :placeholder="t('routes.pickClients')" />
          <USelectMenu v-else v-model="form.networkId" :items="networkItems" value-key="value" class="w-full" :placeholder="t('routes.pickNetwork')" />
        </div>

        <div class="grid sm:grid-cols-2 gap-4">
          <UFormField :label="t('routes.matching')">
            <USelect v-model="form.matchingTarget" :items="(['INTERNET', 'DOMAIN', 'IP', 'REGION'] as const).map(v => ({ value: v, label: t(`routes.match.${v}`) }))" class="w-full" />
          </UFormField>
          <UFormField :label="t('routes.killSwitch')" :description="t('routes.killSwitchHint')">
            <USwitch v-model="form.killSwitch" />
          </UFormField>
        </div>
        <UFormField v-if="form.matchingTarget !== 'INTERNET'" :label="t(`routes.destLabel.${form.matchingTarget}`)" :hint="t('routes.destHint')">
          <UTextarea v-model="form.destinations" :rows="3" class="w-full uf-mono" />
        </UFormField>

        <div>
          <div class="text-[13px] font-medium text-highlighted mb-2">{{ t('routes.defaultEgress') }}</div>
          <EgressPicker v-model="form.defaultEgressId" :egresses="egresses" compact />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
        <UButton :icon="mode === 'adopt' ? 'i-lucide-hand-helping' : 'i-lucide-plus'" :disabled="mode === 'adopt' ? !adoptId || (adoptSuspected && !adoptAck) : !canCreate" :loading="busy" @click="submit">
          {{ mode === 'adopt' ? t('routes.adopt') : t('routes.create') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
