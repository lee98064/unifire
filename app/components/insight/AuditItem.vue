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
// Params arrive as raw identifiers (action "route.adopted", reason "failover", error keys) — localise them first.
const params = computed(() => {
  const p: Record<string, unknown> = { ...(props.event.messageParams ?? {}) }
  const action = typeof p.action === 'string' ? `audit.actionName.${p.action.replace(/-/g, '_')}` : null
  if (action && te(action)) p.action = t(action)
  if (typeof p.reason === 'string' && te(`routes.reason.${p.reason}`)) p.reason = t(`routes.reason.${p.reason}`)
  if (typeof p.error === 'string') {
    // Error codes are SCREAMING_CASE (UNIFI_ROUTE_DRIFT → errors.unifiRouteDrift); keys pass through.
    const key = /^[A-Z0-9_]+$/.test(p.error) ? `errors.${p.error.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())}` : p.error
    if (te(key)) p.error = t(key)
  }
  if (typeof p.method === 'string' && te(`audit.method.${p.method}`)) p.method = t(`audit.method.${p.method}`)
  if (p.from === '') p.from = '—'
  return p
})
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
      <div v-if="!compact && event.diff?.length" class="mt-2 space-y-1">
        <div v-for="f in event.diff" :key="f.path" class="text-[12px] flex items-center gap-1.5 flex-wrap">
          <code class="uf-mono text-dimmed">{{ f.path }}</code>
          <span class="px-1.5 rounded bg-error/10 text-error line-through decoration-error/50">{{ f.secret ? '••••' : (f.beforeLabel ?? JSON.stringify(f.before)) }}</span>
          <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed" />
          <span class="px-1.5 rounded bg-success/10 text-success">{{ f.secret ? '••••' : (f.afterLabel ?? JSON.stringify(f.after)) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
