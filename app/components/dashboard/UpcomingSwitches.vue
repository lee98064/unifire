<script setup lang="ts">
import type { UpcomingSwitchT } from '#shared/schemas/system'

defineProps<{ items: UpcomingSwitchT[] }>()
const { t } = useI18n()
const fmt = useFormat()
const now = useNow({ interval: 30_000 })
</script>

<template>
  <ol v-if="items.length" class="relative space-y-0">
    <li v-for="(s, i) in items" :key="`${s.managedRouteId}-${s.at}`" class="relative flex gap-3 pb-4 last:pb-0">
      <div class="flex flex-col items-center">
        <span class="size-2.5 rounded-full ring-4 ring-(--uf-surface) mt-1.5" :class="i === 0 ? 'bg-primary' : 'bg-(--ui-border-accented)'" />
        <span v-if="i < items.length - 1" class="flex-1 w-px bg-(--ui-border-muted) mt-1" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-2">
          <span class="text-[13px] font-semibold text-highlighted uf-num">{{ fmt.time(s.at) }}</span>
          <span class="text-[11.5px] text-dimmed">{{ fmt.until(s.at, now.getTime()) }}</span>
        </div>
        <NuxtLink :to="`/routes/${s.managedRouteId}`" class="text-[12.5px] text-toned hover:text-primary truncate block">{{ s.routeName }}</NuxtLink>
        <div class="mt-1 flex items-center gap-1.5 flex-wrap">
          <EgressChip v-if="s.fromEgressId" :id="s.fromEgressId" size="xs" />
          <UIcon name="i-lucide-arrow-right" class="size-3 text-dimmed" />
          <EgressChip :id="s.toEgressId" size="xs" />
        </div>
      </div>
    </li>
  </ol>
  <div v-else class="text-[13px] text-dimmed py-6 text-center">{{ t('dashboard.noUpcoming') }}</div>
</template>
