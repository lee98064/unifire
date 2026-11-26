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
const message = computed(() => te(props.event.messageKey) ? t(props.event.messageKey, props.event.messageParams) : `${props.event.action} ${props.event.target?.label ?? ''}`)
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
