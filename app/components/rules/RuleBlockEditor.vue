<script setup lang="ts">
import type { FieldSpec } from '~/utils/rules'
import type { ClientT, GroupT, QuotaT } from '#shared/schemas/access'
import type { ManagedRouteT } from '#shared/schemas/routes'
import type { NotificationChannelT } from '#shared/schemas/system'
import type { WlanT, WolTargetT, PoePortT } from '#shared/schemas/automation'
import { cronPresets } from '~/utils/rules'

/** Metadata-driven field editor for one trigger / condition / action block. */
const props = defineProps<{ fields: FieldSpec[], prefix: string }>()
const block = defineModel<Record<string, any>>({ required: true })
const { t } = useI18n()
const fmt = useFormat()

const { egresses } = useEgresses()
const { people } = usePeople()
const clients = useFetch<ClientT[]>('/api/clients', { key: 'clients', default: () => [], dedupe: 'defer' }).data
const groups = useFetch<GroupT[]>('/api/groups', { key: 'groups', default: () => [], dedupe: 'defer' }).data
const routes = useFetch<ManagedRouteT[]>('/api/managed-routes', { key: 'managed-routes', default: () => [], dedupe: 'defer' }).data
const needs = (k: string) => props.fields.some(f => f.kind === k)
const quotas = useFetch<QuotaT[]>('/api/quotas', { key: 'quotas', default: () => [], immediate: needs('quotaOpt'), dedupe: 'defer' }).data
const channels = useFetch<NotificationChannelT[]>('/api/notifications/channels', { key: 'channels', default: () => [], immediate: needs('channels'), dedupe: 'defer' }).data
const wlans = useFetch<WlanT[]>('/api/wlans', { key: 'wlans', default: () => [], immediate: needs('wlan'), dedupe: 'defer' }).data
const wols = useFetch<WolTargetT[]>('/api/wol', { key: 'wol', default: () => [], immediate: needs('wol'), dedupe: 'defer' }).data
const ports = useFetch<PoePortT[]>('/api/watchdogs/ports', { key: 'poe-ports', default: () => [], immediate: needs('switchport'), dedupe: 'defer' }).data

const clientItems = computed(() => clients.value.map(c => ({ label: c.displayName, value: c.mac, description: c.mac })))
const personItems = computed(() => people.value.map(p => ({ label: `${p.avatar} ${p.name}`, value: p.id })))
const egressItems = computed(() => egresses.value.map(e => ({ label: e.name, value: e.id })))
const anyItem = (label: string) => ({ label, value: null })

function set(key: string, v: unknown) { block.value = { ...block.value, [key]: v } }
const label = (f: FieldSpec) => t(`rules.field.${f.key}`)

const targetItems = computed(() => {
  const tg = block.value.target ?? block.value.scope
  if (!tg) return []
  if (tg.type === 'person') return personItems.value
  if (tg.type === 'group') return groups.value.map(g => ({ label: g.name, value: g.id }))
  return clientItems.value
})
function setTarget(key: 'target' | 'scope', patch: Record<string, unknown>) {
  set(key, { ...(block.value[key] ?? {}), ...patch })
}
const gbValue = computed({
  get: () => Math.round(((block.value.bytes ?? 0) / 1e9) * 10) / 10,
  set: v => set('bytes', Math.round(v * 1e9)),
})
const portItems = computed(() => ports.value.filter(p => p.poe && !p.isUplink).map(p => ({ label: `${p.switchName} #${p.portIdx}${p.connectedClientName ? ` · ${p.connectedClientName}` : ''}`, value: `${p.switchMac}|${p.portIdx}` })))
const headerText = computed({
  get: () => Object.entries(block.value.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'),
  set: (v: string) => set('headers', Object.fromEntries(v.split('\n').map(l => l.split(':')).filter(p => p.length >= 2).map(([k, ...r]) => [k!.trim(), r.join(':').trim()]))),
})
const times = Array.from({ length: 96 }, (_, k) => `${String(Math.floor(k / 4)).padStart(2, '0')}:${String((k % 4) * 15).padStart(2, '0')}`)
</script>

<template>
  <div v-if="fields.length" class="grid sm:grid-cols-2 gap-3">
    <template v-for="f in fields" :key="f.key">
      <UFormField v-if="f.kind === 'macs'" :label="label(f)" class="sm:col-span-2" :hint="t('rules.anyIfEmpty')">
        <USelectMenu :model-value="block.macs" :items="clientItems" value-key="value" multiple class="w-full" @update:model-value="set('macs', $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'mac'" :label="label(f)">
        <USelectMenu :model-value="block.mac" :items="clientItems" value-key="value" class="w-full" @update:model-value="set('mac', $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'person' || f.kind === 'personOpt'" :label="label(f)">
        <USelectMenu :model-value="block[f.key]" :items="f.kind === 'personOpt' ? [anyItem(t('rules.anyone')), ...personItems] : personItems" value-key="value" class="w-full" @update:model-value="set(f.key, $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'egress' || f.kind === 'egressOpt'" :label="label(f)">
        <USelectMenu :model-value="block[f.key]" :items="f.kind === 'egressOpt' ? [anyItem(t('rules.anyEgress')), ...egressItems] : egressItems" value-key="value" class="w-full" @update:model-value="set(f.key, $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'route'" :label="label(f)">
        <USelectMenu :model-value="block[f.key]" :items="routes.map(r => ({ label: r.name, value: r.id }))" value-key="value" class="w-full" @update:model-value="set(f.key, $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'quotaOpt'" :label="label(f)">
        <USelectMenu :model-value="block[f.key]" :items="[anyItem(t('rules.anyQuota')), ...quotas.map(q => ({ label: q.name, value: q.id }))]" value-key="value" class="w-full" @update:model-value="set(f.key, $event)" />
      </UFormField>
      <div v-else-if="f.kind === 'cron'" class="sm:col-span-2 space-y-2">
        <UFormField :label="label(f)" :hint="t('rules.cronHint')">
          <UInput :model-value="block.cron" class="w-full uf-mono" placeholder="0 22 * * *" @update:model-value="set('cron', $event)" />
        </UFormField>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="p in cronPresets" :key="p.cron" type="button" class="h-7 px-2.5 rounded-full text-[12px] ring-1 transition" :class="block.cron === p.cron ? 'bg-primary/10 text-primary ring-primary/30' : 'ring-(--ui-border-muted) text-toned hover:ring-(--ui-border-accented)'" @click="set('cron', p.cron)">{{ t(`rules.cron.${p.key}`) }}</button>
        </div>
      </div>
      <UFormField v-else-if="f.kind === 'tz'" :label="label(f)">
        <UInput :model-value="block.timezone" class="w-full" @update:model-value="set('timezone', $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'number'" :label="label(f)">
        <UInputNumber :model-value="block[f.key]" :min="1" class="w-full" @update:model-value="set(f.key, $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'minutes' || f.kind === 'minutesOpt'" :label="label(f)">
        <div class="flex items-center gap-2">
          <UInputNumber :model-value="block[f.key] ?? undefined" :min="1" class="flex-1" :placeholder="f.kind === 'minutesOpt' ? t('common.indefinitely') : ''" @update:model-value="set(f.key, $event ?? null)" />
          <span class="text-[12px] text-dimmed">{{ t('rules.minutesUnit') }}</span>
        </div>
      </UFormField>
      <UFormField v-else-if="f.kind === 'bytes'" :label="label(f)">
        <div class="flex items-center gap-2"><UInputNumber v-model="gbValue" :min="0.1" :step="0.5" class="flex-1" /><span class="text-[12px] text-dimmed">GB</span></div>
      </UFormField>
      <UFormField v-else-if="f.kind === 'text' || f.kind === 'url'" :label="label(f)" :class="f.kind === 'url' ? 'sm:col-span-2' : 'sm:col-span-2'">
        <UInput :model-value="block[f.key]" class="w-full" :class="f.kind === 'url' ? 'uf-mono' : ''" @update:model-value="set(f.key, $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'textarea'" :label="label(f)" class="sm:col-span-2" :hint="t('rules.placeholderHint', { examples: '{{name}} {{mac}} {{egress}} {{person}}' })">
        <UTextarea :model-value="block[f.key] ?? ''" :rows="3" class="w-full" @update:model-value="set(f.key, $event || (f.key === 'body' && block.type === 'webhook' ? null : ''))" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'headers'" :label="label(f)" class="sm:col-span-2">
        <UTextarea v-model="headerText" :rows="2" class="w-full uf-mono" placeholder="Authorization: Bearer …" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'method'" :label="label(f)">
        <USelect :model-value="block.method" :items="['POST', 'PUT', 'GET']" class="w-full" @update:model-value="set('method', $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'days'" :label="label(f)" class="sm:col-span-2">
        <div class="flex gap-1">
          <button v-for="d in 7" :key="d" type="button" class="size-8 rounded-md text-[12px] font-medium transition" :class="block.days?.includes(d - 1) ? 'bg-primary text-white' : 'ring-1 ring-(--ui-border-muted) text-toned'" @click="set('days', block.days?.includes(d - 1) ? block.days.filter((x: number) => x !== d - 1) : [...(block.days ?? []), d - 1].sort())">{{ fmt.weekday(d - 1, 'narrow') }}</button>
        </div>
      </UFormField>
      <UFormField v-else-if="f.kind === 'time'" :label="label(f)">
        <USelect :model-value="block[f.key]" :items="times" class="w-full" @update:model-value="set(f.key, $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'bool'" :label="label(f)">
        <USelect :model-value="block[f.key]" :items="[{ value: true, label: t(`rules.bool.${prefix}.${f.key}.true`) }, { value: false, label: t(`rules.bool.${prefix}.${f.key}.false`) }]" class="w-full" @update:model-value="set(f.key, $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'channels'" :label="label(f)" class="sm:col-span-2" :hint="t('rules.allChannelsIfEmpty')">
        <USelectMenu :model-value="block.channelIds" :items="channels.map(c => ({ label: c.name, value: c.id }))" value-key="value" multiple class="w-full" @update:model-value="set('channelIds', $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'wlan'" :label="label(f)">
        <USelectMenu :model-value="block.wlanId" :items="wlans.map(w => ({ label: w.name, value: w.id }))" value-key="value" class="w-full" @update:model-value="set('wlanId', $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'wol'" :label="label(f)">
        <USelectMenu :model-value="block.targetId" :items="wols.map(w => ({ label: w.name, value: w.id }))" value-key="value" class="w-full" @update:model-value="set('targetId', $event)" />
      </UFormField>
      <UFormField v-else-if="f.kind === 'switchport'" :label="label(f)" class="sm:col-span-2">
        <USelectMenu :model-value="block.switchMac ? `${block.switchMac}|${block.portIdx}` : undefined" :items="portItems" value-key="value" class="w-full" @update:model-value="(v: string) => { const [m, p] = v.split('|'); block = { ...block, switchMac: m, portIdx: Number(p) } }" />
      </UFormField>
      <div v-else-if="f.kind === 'target' || f.kind === 'scope'" class="sm:col-span-2 grid grid-cols-[auto_1fr] gap-2 items-end">
        <UFormField :label="label(f)">
          <USelect :model-value="block[f.key]?.type" :items="(f.kind === 'target' ? ['person', 'group', 'client'] : ['person', 'client']).map(v => ({ value: v, label: t(`quotas.scopeType.${v}`) }))" class="w-28" @update:model-value="setTarget(f.key as 'target' | 'scope', { type: $event, id: '' })" />
        </UFormField>
        <USelectMenu :model-value="block[f.key]?.id" :items="targetItems" value-key="value" class="w-full" @update:model-value="setTarget(f.key as 'target' | 'scope', { id: $event })" />
      </div>
    </template>
  </div>
</template>
