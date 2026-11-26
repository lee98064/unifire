<script setup lang="ts">
import type { ManagedRouteT } from '#shared/schemas/routes'

const props = defineProps<{ route: ManagedRouteT }>()
const emit = defineEmits<{ changed: [route: ManagedRouteT] }>()
const { t } = useI18n()
const api = useApi()
const fmt = useFormat()
const { egresses } = useEgresses()
const now = useClock(1000)

const egressId = ref<string | null>(null)
const minutes = ref<number | null>(120)
const reason = ref('')
const busy = ref(false)

const remaining = computed(() => props.route.activeOverride ? Math.max(0, props.route.activeOverride.endsAt - now.value.getTime()) : 0)
const progress = computed(() => {
  const o = props.route.activeOverride
  if (!o) return 0
  return 100 * (1 - remaining.value / (o.endsAt - o.startsAt))
})
function countdown(ms: number) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

async function apply() {
  if (!egressId.value || !minutes.value) return
  busy.value = true
  try {
    const r = await api.post<ManagedRouteT>(`/api/managed-routes/${props.route.id}/override`, { egressId: egressId.value, minutes: minutes.value, reason: reason.value || undefined }, { success: t('routes.override.applied') })
    emit('changed', r)
    egressId.value = null
    reason.value = ''
  }
  finally { busy.value = false }
}
async function clear() {
  busy.value = true
  try {
    const r = await api.del<ManagedRouteT>(`/api/managed-routes/${props.route.id}/override`, undefined, { success: t('routes.override.cleared') })
    emit('changed', r)
  }
  finally { busy.value = false }
}
</script>

<template>
  <div>
    <div v-if="route.activeOverride" class="relative overflow-hidden rounded-xl ring-1 ring-vpn/30 bg-vpn/6 p-4 mb-5">
      <div class="absolute inset-y-0 left-0 bg-vpn/8 transition-[width] duration-1000 ease-linear" :style="{ width: `${progress}%` }" />
      <div class="relative flex items-center gap-4">
        <span class="size-11 rounded-full bg-vpn text-white flex items-center justify-center shrink-0 shadow-[0_0_0_6px_color-mix(in_oklab,var(--color-ufpurple-500)_18%,transparent)]">
          <UIcon name="i-lucide-timer" class="size-5" />
        </span>
        <div class="flex-1 min-w-0">
          <div class="text-[12px] text-vpn font-semibold uppercase tracking-wide">{{ t('routes.override.active') }}</div>
          <div class="flex items-center gap-2 mt-0.5 flex-wrap">
            <EgressChip :id="route.activeOverride.egressId" size="md" show-health />
            <span class="text-[12.5px] text-muted">{{ t('routes.override.until', { time: fmt.time(route.activeOverride.endsAt) }) }}</span>
          </div>
          <div v-if="route.activeOverride.reason" class="text-[12px] text-dimmed mt-1 truncate">“{{ route.activeOverride.reason }}”</div>
        </div>
        <div class="text-right">
          <div class="text-2xl font-semibold text-highlighted uf-num tracking-tight">{{ countdown(remaining) }}</div>
          <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-x" class="mt-1" :loading="busy" @click="clear">{{ t('routes.override.end') }}</UButton>
        </div>
      </div>
    </div>

    <div class="space-y-4">
      <div>
        <div class="text-[12.5px] font-medium text-toned mb-2">{{ t('routes.override.pick') }}</div>
        <EgressPicker v-model="egressId" :egresses="egresses" :exclude="route.actualEgressId ? [route.actualEgressId] : []" />
      </div>
      <div>
        <div class="text-[12.5px] font-medium text-toned mb-2">{{ t('routes.override.duration') }}</div>
        <DurationPicker v-model="minutes" :options="[30, 60, 120, 240, 480, 1440]" />
      </div>
      <UInput v-model="reason" :placeholder="t('routes.override.reasonPh')" icon="i-lucide-message-square-text" class="w-full" />
      <div class="flex justify-end">
        <UButton icon="i-lucide-zap" :disabled="!egressId || !minutes" :loading="busy" @click="apply">{{ t('routes.override.apply') }}</UButton>
      </div>
    </div>
  </div>
</template>
