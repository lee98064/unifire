<script setup lang="ts">
import type { PoeOverviewT, PoeQualificationT, PortViewT } from '#shared/schemas/infra'

/**
 * One-time supervised PoE write check: the user picks a non-critical PoE port, Unifire powers it off,
 * reads back, powers it on again and reads back. Only after that are "active" schedules written.
 */
const props = defineProps<{ switches: PoeOverviewT['switches'], dryRun: boolean }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [PoeQualificationT] }>()
const { t } = useI18n()
const api = useApi()

const swMac = ref<string | null>(null)
const idx = ref<number | null>(null)
const ack = ref(false)
const understood = ref(false)
const running = ref(false)
const result = ref<PoeQualificationT | null>(null)
watch(open, (v) => {
  if (!v) return
  swMac.value = props.switches[0]?.mac ?? null
  idx.value = null
  ack.value = false
  understood.value = false
  result.value = null
})
const sw = computed(() => props.switches.find(s => s.mac === swMac.value) ?? null)
const port = computed<PortViewT | null>(() => sw.value?.ports.find(p => p.idx === idx.value) ?? null)
const reason = computed(() => {
  const p = port.value
  if (!p) return null
  if (!p.poe?.capable) return 'not_poe'
  if (p.poe.mode === 'off') return 'already_off'
  return p.poeSafety.reasons.find(r => r !== 'powers_ap') ?? null
})
const ready = computed(() => !!port.value && !reason.value && understood.value && (!port.value.poeSafety.requiresAck || ack.value) && !props.dryRun)

async function run() {
  if (!port.value || !sw.value) return
  running.value = true
  try {
    result.value = await api.post<PoeQualificationT>('/api/poe/qualify', { switchMac: sw.value.mac, portIdx: port.value.idx, confirm: true, acknowledgedAp: ack.value })
    if (result.value.qualified) emit('done', result.value)
  }
  finally { running.value = false }
}
</script>

<template>
  <UModal v-model:open="open" :title="t('poe.qualify.title')" :description="t('poe.qualify.desc')" :ui="{ content: 'sm:max-w-3xl' }" :dismissible="!running">
    <template #body>
      <div v-if="result?.qualified" class="py-6 text-center space-y-2">
        <span class="mx-auto size-12 rounded-full bg-success/15 text-success flex items-center justify-center"><UIcon name="i-lucide-shield-check" class="size-6" /></span>
        <div class="text-[15px] font-semibold text-highlighted">{{ t('poe.qualify.ok') }}</div>
        <p class="text-[13px] text-muted max-w-md mx-auto">{{ t('poe.qualify.okDesc') }}</p>
      </div>
      <div v-else class="space-y-4">
        <UAlert v-if="dryRun" color="warning" variant="subtle" icon="i-lucide-flask-conical" :title="t('poe.qualify.dryRun')" />
        <ol class="grid sm:grid-cols-4 gap-2 text-[12px]">
          <li v-for="(s, i) in ['pick', 'off', 'on', 'done']" :key="s" class="rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) px-3 py-2">
            <span class="uf-num text-primary font-semibold mr-1">{{ i + 1 }}</span>{{ t(`poe.qualify.step.${s}`) }}
          </li>
        </ol>

        <div v-if="switches.length > 1" class="flex flex-wrap gap-1.5">
          <UButton v-for="s in switches" :key="s.mac" size="sm" :color="swMac === s.mac ? 'primary' : 'neutral'" :variant="swMac === s.mac ? 'soft' : 'outline'" @click="swMac = s.mac; idx = null">{{ s.name }}</UButton>
        </div>
        <SwitchFaceplate v-if="sw" :ports="sw.ports" :selected="idx" pick-poe size="md" @select="i => (idx = i)" />

        <div v-if="port" class="rounded-lg ring-1 ring-(--ui-border-muted) p-3 space-y-2">
          <div class="flex items-center gap-2 text-[13px]">
            <span class="font-medium text-highlighted">{{ t('ports.port', { n: port.idx }) }}</span>
            <span class="text-muted truncate">· {{ port.peer?.name ?? t('ports.unknownPeer') }}</span>
            <span class="ml-auto uf-num text-toned">{{ (port.poe?.powerW ?? 0).toFixed(1) }} W</span>
          </div>
          <UAlert v-if="reason" color="error" variant="subtle" icon="i-lucide-shield-x" :title="t(`poe.safety.${reason}`)" />
          <UCheckbox v-if="!reason && port.poeSafety.requiresAck" v-model="ack" :label="t('poe.apAck')" />
          <UCheckbox v-if="!reason" v-model="understood" :label="t('poe.qualify.understand', { name: port.peer?.name ?? t('ports.port', { n: port.idx }) })" />
        </div>
        <p v-else class="text-[12.5px] text-dimmed">{{ t('poe.qualify.pickHint') }}</p>

        <UAlert v-if="result && !result.qualified" color="error" variant="subtle" icon="i-lucide-circle-x" :title="t('poe.qualify.failed')" :description="result.error ?? undefined" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full gap-2">
        <UButton class="ml-auto" color="neutral" variant="ghost" :disabled="running" @click="open = false">{{ result?.qualified ? t('common.close') : t('common.cancel') }}</UButton>
        <UButton v-if="!result?.qualified" color="warning" icon="i-lucide-zap" :loading="running" :disabled="!ready" @click="run">{{ running ? t('poe.qualify.running') : t('poe.qualify.start') }}</UButton>
      </div>
    </template>
  </UModal>
</template>
