<script setup lang="ts">
import { egressKindIcon } from '~/utils/egress'

const props = withDefaults(defineProps<{ id: string | null | undefined, size?: 'xs' | 'sm' | 'md', showHealth?: boolean, fallback?: string }>(), { size: 'sm', showHealth: false })
const { get } = useEgresses()
const { t } = useI18n()
const e = computed(() => get(props.id))
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 max-w-full rounded-md ring-1 ring-inset font-medium align-middle"
    :class="[
      {
        'h-5 px-1.5 text-[11px]': size === 'xs',
        'h-6 px-2 text-[12px]': size === 'sm',
        'h-7 px-2.5 text-[13px]': size === 'md',
      },
      !e ? 'ring-(--ui-border) text-dimmed' : '',
    ]"
    :style="e ? { background: `color-mix(in oklab, ${e.color} 12%, transparent)`, color: `color-mix(in oklab, ${e.color} 78%, var(--ui-text-highlighted))`, '--tw-ring-color': `color-mix(in oklab, ${e.color} 30%, transparent)` } : {}"
  >
    <span class="size-1.5 rounded-full shrink-0" :style="{ background: e?.color ?? 'var(--ui-text-dimmed)' }" />
    <UIcon v-if="e && size !== 'xs'" :name="egressKindIcon[e.kind]" class="size-3.5 shrink-0 opacity-80" />
    <span class="truncate">{{ e?.name ?? fallback ?? t('common.unknownEgress') }}</span>
    <StatusDot v-if="showHealth && e" :status="e.health.status" :size="6" />
  </span>
</template>
