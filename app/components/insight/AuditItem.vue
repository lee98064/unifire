<script setup lang="ts">
import type { AuditEventT } from '#shared/schemas/insight'

const props = withDefaults(defineProps<{ event: AuditEventT, compact?: boolean }>(), { compact: false })
const { t, te } = useI18n()
const fmt = useFormat()

const icons: Record<string, string> = {
  route: 'i-lucide-waypoints', egress: 'i-lucide-globe', client: 'i-lucide-monitor-smartphone', approval: 'i-lucide-shield-check',
  quota: 'i-lucide-hourglass', pause: 'i-lucide-circle-pause', config: 'i-lucide-sliders-horizontal', auth: 'i-lucide-key-round',
  rule: 'i-lucide-workflow', poe: 'i-lucide-plug-zap', wifi: 'i-lucide-wifi', wol: 'i-lucide-power', snapshot: 'i-lucide-history', system: 'i-lucide-cpu',
}
const actorIcon: Record<string, string> = {
  unifire: 'i-lucide-flame', user: 'i-lucide-user-round', external: 'i-lucide-user-round-search', 'unifi-log': 'i-lucide-router', system: 'i-lucide-cpu', rule: 'i-lucide-workflow',
}
// Params arrive as raw identifiers (action "route.adopted", reason "failover", error codes, resource ids) — localise them.
const msg = useMsg()
const params = computed(() => {
  const p: Record<string, unknown> = { ...(props.event.messageParams ?? {}) }
  const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? p[k] as string : null)
  const tr = (key: string) => (te(key) ? t(key) : null)
  const action = str('action')
  if (action) p.action = tr(`audit.actionName.${action.replace(/-/g, '_')}`) ?? action
  const reason = str('reason')
  if (reason) p.reason = tr(`routes.reason.${reason}`) ?? tr(`snapshots.reason.${reason}`) ?? reason
  const error = str('error')
  if (error) p.error = msg(error)
  const method = str('method')
  if (method) p.method = tr(`audit.method.${method}`) ?? method
  const trigger = str('trigger')
  if (trigger) p.trigger = tr(`snapshots.trigger.${trigger}`) ?? trigger
  const resource = str('resource')
  if (resource) p.resource = tr(`snapshots.resourceShort.${resource}`) ?? resource
  const failed = str('failed')
  if (failed) p.failed = failed.split(',').map(r => tr(`snapshots.resource.${r.trim()}`) ?? r).join('、')
  const keys = str('keys')
  if (keys) p.keys = keys.split(',').map(k => tr(`audit.settingKey.${k.trim()}`) ?? k).join('、')
  if (p.from === '') p.from = '—'
  return p
})

// Field diff: hide identity noise, resolve egress ids to names, collapse long create/delete dumps.
const { egresses } = useEgresses()
const egressName = (path: string, v: unknown) => (/(^|\.)network_id$/.test(path) && typeof v === 'string' ? egresses.value.find(e => e.id === v)?.name : undefined)
type DiffRow = NonNullable<AuditEventT['diff']>[number]
const rows = computed(() => (props.event.diff ?? []).filter(f => f.path !== '_id' && f.path !== 'site_id'))
const created = computed(() => rows.value.length > 0 && rows.value.every(f => f.before === null || f.before === undefined))
const deleted = computed(() => rows.value.length > 0 && rows.value.every(f => f.after === null || f.after === undefined))
const showAll = ref(false)
const DIFF_PREVIEW = 4
const visibleRows = computed(() => (showAll.value ? rows.value : rows.value.slice(0, DIFF_PREVIEW)))
const show = (f: DiffRow, side: 'before' | 'after') => {
  if (f.secret) return '••••'
  const label = side === 'before' ? f.beforeLabel : f.afterLabel
  const value = side === 'before' ? f.before : f.after
  return label ?? egressName(f.path, value) ?? JSON.stringify(value)
}
const message = computed(() => te(props.event.messageKey) ? t(props.event.messageKey, params.value) : `${props.event.action} ${props.event.target?.label ?? ''}`)
const tone = computed(() => ({ info: 'text-primary bg-primary/10', success: 'text-success bg-success/10', warning: 'text-warning bg-warning/10', error: 'text-error bg-error/10' })[props.event.severity])
</script>

<template>
  <div class="flex gap-3 min-w-0">
    <span class="size-7 shrink-0 rounded-md flex items-center justify-center" :class="tone">
      <UIcon :name="icons[event.category] ?? 'i-lucide-dot'" class="size-3.5" />
    </span>
    <div class="min-w-0 flex-1">
      <div class="text-[13px] text-highlighted leading-snug" :class="compact ? 'line-clamp-2' : ''">
        {{ message }}
        <UBadge v-if="event.dryRun" color="warning" variant="subtle" size="xs" class="ml-1 align-middle">dry-run</UBadge>
      </div>
      <div class="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-dimmed">
        <UIcon :name="actorIcon[event.actor.type] ?? 'i-lucide-dot'" class="size-3" />
        <span class="truncate">{{ event.actor.name ?? t(`audit.actor.${event.actor.type}`) }}</span>
        <span>·</span>
        <TimeAgo :ts="event.ts" />
      </div>
      <div v-if="!compact && rows.length" class="mt-2 space-y-1">
        <div v-for="f in visibleRows" :key="f.path" class="text-[12px] flex items-center gap-1.5 flex-wrap">
          <code class="uf-mono text-dimmed">{{ f.path }}</code>
          <span v-if="!created" class="px-1.5 rounded bg-error/10 text-error line-through decoration-error/50">{{ show(f, 'before') }}</span>
          <UIcon v-if="!created && !deleted" name="i-lucide-arrow-right" class="size-3 text-dimmed" />
          <span v-if="!deleted" class="px-1.5 rounded bg-success/10 text-success">{{ show(f, 'after') }}</span>
        </div>
        <button v-if="rows.length > DIFF_PREVIEW" type="button" class="text-[11.5px] text-primary hover:underline" @click="showAll = !showAll">
          {{ showAll ? t('audit.diffLess') : t('audit.diffMore', { n: rows.length - DIFF_PREVIEW }) }}
        </button>
      </div>
    </div>
  </div>
</template>
