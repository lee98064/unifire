<script setup lang="ts">
import type { CapabilityT } from '#shared/schemas/controller'

defineProps<{ caps: CapabilityT[], labels: Record<string, string> }>()
const { t } = useI18n()
const msg = useMsg()
const icon = { ok: 'i-lucide-circle-check', fail: 'i-lucide-circle-x', unknown: 'i-lucide-circle-help', skipped: 'i-lucide-circle-minus' } as const
const color = { ok: 'text-success', fail: 'text-error', unknown: 'text-dimmed', skipped: 'text-warning' } as const
</script>

<template>
  <div class="grid sm:grid-cols-2 gap-x-4 gap-y-0.5 rounded-lg ring-1 ring-(--ui-border-muted) bg-(--uf-surface-2) p-2">
    <UTooltip v-for="(c, i) in caps" :key="c.key" :text="c.detail ? msg(c.detail) : t(`caps.status.${c.status}`)" :content="{ side: 'top' }">
      <div
        class="flex items-center gap-2 px-2 py-1.5 rounded-md text-[12.5px] hover:bg-(--uf-hover) transition-colors"
        :style="{ animation: `uf-cap-in 300ms ${i * 35}ms both var(--ease-uf)` }"
      >
        <UIcon :name="icon[c.status]" class="size-4 shrink-0" :class="color[c.status]" />
        <span class="text-toned truncate flex-1">{{ labels[c.key] ?? c.key }}</span>
        <span class="text-[11px] uppercase tracking-wide" :class="color[c.status]">{{ t(`caps.status.${c.status}`) }}</span>
      </div>
    </UTooltip>
  </div>
</template>

<style>
@keyframes uf-cap-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
</style>
