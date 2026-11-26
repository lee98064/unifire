<script setup lang="ts">
import type { EgressT } from '#shared/schemas/egress'
import { egressKindIcon } from '~/utils/egress'

/** Tile grid to pick an egress; shows health & public IP so users avoid unhealthy exits. */
const props = withDefaults(defineProps<{ egresses: EgressT[], exclude?: string[], compact?: boolean }>(), { exclude: () => [], compact: false })
const model = defineModel<string | null>()
const fmt = useFormat()
const { t } = useI18n()
const list = computed(() => props.egresses.filter(e => !props.exclude.includes(e.id)))
</script>

<template>
  <div class="grid gap-2" :class="compact ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'">
    <button
      v-for="e in list"
      :key="e.id"
      type="button"
      class="relative text-left p-2.5 rounded-lg ring-1 transition-all duration-150"
      :class="model === e.id ? 'ring-2 shadow-(--uf-shadow)' : 'ring-(--ui-border-muted) hover:ring-(--ui-border-accented) bg-(--uf-surface)'"
      :style="model === e.id ? { '--tw-ring-color': e.color, background: `color-mix(in oklab, ${e.color} 8%, var(--uf-surface))` } : {}"
      @click="model = e.id"
    >
      <div class="flex items-center gap-2">
        <span class="size-6 rounded-md flex items-center justify-center shrink-0" :style="{ background: `color-mix(in oklab, ${e.color} 16%, transparent)`, color: e.color }">
          <UIcon :name="egressKindIcon[e.kind]" class="size-3.5" />
        </span>
        <span class="text-[12.5px] font-medium text-highlighted truncate flex-1">{{ e.name }}</span>
        <CountryFlag v-if="e.publicIp" :code="e.publicIp.country" :size="13" />
      </div>
      <div class="mt-1.5 flex items-center gap-1.5 text-[11px] text-dimmed">
        <StatusDot :status="e.health.status" :size="6" />
        <span class="uf-num">{{ e.health.status === 'down' ? t('health.down') : fmt.ms(e.health.latencyMs) }}</span>
        <span v-if="e.health.lossPct" class="uf-num">· {{ fmt.pct(e.health.lossPct) }} {{ t('health.loss') }}</span>
      </div>
      <UIcon v-if="model === e.id" name="i-lucide-circle-check" class="absolute top-2 right-2 size-4" :style="{ color: e.color }" />
    </button>
  </div>
</template>
