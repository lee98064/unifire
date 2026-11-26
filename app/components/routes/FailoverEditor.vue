<script setup lang="ts">
import type { FailoverPolicyT } from '#shared/schemas/routes'
import { egressKindIcon } from '~/utils/egress'

const policy = defineModel<FailoverPolicyT>({ required: true })
defineProps<{ desiredEgressId: string }>()
const { t } = useI18n()
const fmt = useFormat()
const { egresses, get } = useEgresses()

const available = computed(() => egresses.value.filter(e => !policy.value.chain.includes(e.id)))
function add(id: string) { policy.value = { ...policy.value, chain: [...policy.value.chain, id] } }
function remove(i: number) { policy.value = { ...policy.value, chain: policy.value.chain.filter((_, j) => j !== i) } }
function move(i: number, dir: -1 | 1) {
  const c = [...policy.value.chain]
  const j = i + dir
  if (j < 0 || j >= c.length) return
  ;[c[i], c[j]] = [c[j]!, c[i]!]
  policy.value = { ...policy.value, chain: c }
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-start gap-3">
      <USwitch :model-value="policy.enabled" @update:model-value="policy = { ...policy, enabled: $event }" />
      <div>
        <div class="text-[13.5px] font-medium text-highlighted">{{ t('routes.failover.enable') }}</div>
        <div class="text-[12.5px] text-muted">{{ t('routes.failover.enableHint') }}</div>
      </div>
    </div>

    <div :class="policy.enabled ? '' : 'opacity-50 pointer-events-none'" class="space-y-5 transition-opacity">
      <!-- chain visual -->
      <div>
        <div class="text-[12.5px] font-medium text-toned mb-2">{{ t('routes.failover.chain') }}</div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-2 h-9 px-3 rounded-lg ring-1 ring-primary/40 bg-primary/6">
            <UIcon name="i-lucide-calendar-clock" class="size-3.5 text-primary" />
            <span class="text-[12.5px] font-medium text-highlighted">{{ t('routes.failover.primary') }}</span>
            <EgressChip :id="desiredEgressId" size="xs" />
          </div>
          <template v-for="(id, i) in policy.chain" :key="id">
            <UIcon name="i-lucide-arrow-right" class="size-4 text-dimmed" />
            <div class="group flex items-center gap-1.5 h-9 pl-2 pr-1 rounded-lg ring-1 ring-(--ui-border) bg-(--uf-surface)">
              <span class="text-[10.5px] text-dimmed uf-num w-3">{{ i + 1 }}</span>
              <span class="size-2 rounded-full" :style="{ background: get(id)?.color }" />
              <UIcon v-if="get(id)" :name="egressKindIcon[get(id)!.kind]" class="size-3.5 text-dimmed" />
              <span class="text-[12.5px] font-medium text-highlighted">{{ get(id)?.name ?? id }}</span>
              <StatusDot v-if="get(id)" :status="get(id)!.health.status" :size="6" />
              <div class="flex opacity-60 group-hover:opacity-100">
                <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-chevron-left" :aria-label="t('common.moveLeft')" @click="move(i, -1)" />
                <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-chevron-right" :aria-label="t('common.moveRight')" @click="move(i, 1)" />
                <UButton size="xs" color="error" variant="ghost" icon="i-lucide-x" :aria-label="t('common.remove')" @click="remove(i)" />
              </div>
            </div>
          </template>
          <UDropdownMenu :items="available.map(e => ({ label: e.name, icon: egressKindIcon[e.kind], onSelect: () => add(e.id) }))">
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus">{{ t('routes.failover.addFallback') }}</UButton>
          </UDropdownMenu>
        </div>
      </div>

      <div class="grid sm:grid-cols-3 gap-5">
        <UFormField :label="t('routes.failover.threshold')" :description="t('routes.failover.thresholdHint')">
          <div class="flex items-center gap-3">
            <USlider :model-value="policy.failThreshold" :min="1" :max="10" class="flex-1" @update:model-value="policy = { ...policy, failThreshold: $event as number }" />
            <span class="w-14 text-right text-[13px] font-medium text-highlighted uf-num">{{ t('routes.failover.rounds', { n: policy.failThreshold }) }}</span>
          </div>
        </UFormField>
        <UFormField :label="t('routes.failover.loss')" :description="t('routes.failover.lossHint')">
          <div class="flex items-center gap-3">
            <USlider :model-value="policy.lossPct" :min="5" :max="100" :step="5" class="flex-1" @update:model-value="policy = { ...policy, lossPct: $event as number }" />
            <span class="w-14 text-right text-[13px] font-medium text-highlighted uf-num">{{ policy.lossPct }}%</span>
          </div>
        </UFormField>
        <UFormField :label="t('routes.failover.recover')" :description="t('routes.failover.recoverHint')">
          <div class="flex items-center gap-3">
            <USlider :model-value="policy.recoverMinutes" :min="1" :max="60" class="flex-1" @update:model-value="policy = { ...policy, recoverMinutes: $event as number }" />
            <span class="w-14 text-right text-[13px] font-medium text-highlighted uf-num">{{ fmt.minutes(policy.recoverMinutes) }}</span>
          </div>
        </UFormField>
      </div>
    </div>
  </div>
</template>
