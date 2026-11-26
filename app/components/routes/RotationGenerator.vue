<script setup lang="ts">
import type { EgressT } from '#shared/schemas/egress'
import type { RotationGeneratorT } from '#shared/schemas/routes'
import { generateGrid, type Grid } from '#shared/utils/schedule'
import { egressKindIcon, onColor } from '~/utils/egress'

const props = defineProps<{ egresses: EgressT[], initial: RotationGeneratorT | null, base: Grid, defaultEgressId: string }>()
const emit = defineEmits<{ apply: [grid: Grid, gen: RotationGeneratorT] }>()
const open = defineModel<boolean>('open', { default: false })
const { t } = useI18n()
const fmt = useFormat()

const gen = reactive<RotationGeneratorT>(structuredClone(toRaw(props.initial)) ?? { pinned: [], cycle: [], continuity: 'daily-reset', days: [0, 1, 2, 3, 4, 5, 6] })
watch(open, (v) => {
  if (v) Object.assign(gen, structuredClone(toRaw(props.initial)) ?? { pinned: [], cycle: [], continuity: 'daily-reset', days: [0, 1, 2, 3, 4, 5, 6] })
})

const egMap = computed(() => new Map(props.egresses.map(e => [e.id, e])))
const preview = computed(() => generateGrid(gen, props.base))

function addCycle(id: string) { gen.cycle.push(id) }
function removeCycle(i: number) { gen.cycle.splice(i, 1) }
function moveCycle(i: number, dir: -1 | 1) {
  const j = i + dir
  if (j < 0 || j >= gen.cycle.length) return
  const tmp = gen.cycle[i]!
  gen.cycle[i] = gen.cycle[j]!
  gen.cycle[j] = tmp
}
const newPin = reactive<{ hour: number, egressId: string | undefined }>({ hour: 0, egressId: props.egresses[0]?.id })
function addPin() {
  if (!newPin.egressId) return
  gen.pinned = [...gen.pinned.filter(p => p.hour !== newPin.hour), { hour: newPin.hour, egressId: newPin.egressId }].sort((a, b) => a.hour - b.hour)
}
function toggleDay(d: number) {
  gen.days = gen.days.includes(d) ? gen.days.filter(x => x !== d) : [...gen.days, d].sort()
}

/** Preset matching the go-gost behaviour: 00:00 on WAN1, rest rotates through VPNs. */
function presetMidnightWan() {
  const wan = props.egresses.find(e => e.kind === 'wan')
  const vpns = props.egresses.filter(e => e.kind !== 'wan').slice(0, 5).map(e => e.id)
  if (wan) gen.pinned = [{ hour: 0, egressId: wan.id }]
  gen.cycle = vpns
  gen.continuity = 'daily-reset'
}

const hourItems = Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, '0')}:00`, value: h }))
const egressItems = computed(() => props.egresses.map(e => ({ label: e.name, value: e.id })))

function apply() {
  emit('apply', preview.value, structuredClone(toRaw(gen)))
  open.value = false
}
</script>

<template>
  <UModal v-model:open="open" :title="t('routes.gen.title')" :description="t('routes.gen.desc')" :ui="{ content: 'sm:max-w-3xl' }">
    <template #body>
      <div class="space-y-6">
        <!-- Cycle -->
        <section>
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-[13px] font-semibold text-highlighted">{{ t('routes.gen.cycle') }}</h3>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-wand-sparkles" @click="presetMidnightWan">{{ t('routes.gen.preset') }}</UButton>
          </div>
          <p class="text-[12px] text-muted mb-3">{{ t('routes.gen.cycleHint') }}</p>
          <div class="flex flex-wrap items-center gap-1.5 min-h-10 p-2 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted)">
            <TransitionGroup name="uf-list">
              <span
                v-for="(id, i) in gen.cycle"
                :key="`${id}-${i}`"
                class="inline-flex items-center gap-1 h-7 pl-1 pr-1 rounded-full text-[12px] font-medium"
                :style="{ background: egMap.get(id)?.color, color: onColor(egMap.get(id)?.color ?? '#888888') }"
              >
                <span class="size-5 rounded-full bg-black/15 flex items-center justify-center text-[10px] uf-num">{{ i + 1 }}</span>
                <span class="px-1">{{ egMap.get(id)?.name }}</span>
                <button type="button" class="opacity-70 hover:opacity-100" :aria-label="t('common.moveLeft')" @click="moveCycle(i, -1)"><UIcon name="i-lucide-chevron-left" class="size-3.5" /></button>
                <button type="button" class="opacity-70 hover:opacity-100" :aria-label="t('common.moveRight')" @click="moveCycle(i, 1)"><UIcon name="i-lucide-chevron-right" class="size-3.5" /></button>
                <button type="button" class="opacity-70 hover:opacity-100" :aria-label="t('common.remove')" @click="removeCycle(i)"><UIcon name="i-lucide-x" class="size-3.5" /></button>
              </span>
            </TransitionGroup>
            <span v-if="!gen.cycle.length" class="text-[12px] text-dimmed px-1">{{ t('routes.gen.cycleEmpty') }}</span>
          </div>
          <div class="flex flex-wrap gap-1.5 mt-2">
            <button
              v-for="e in egresses"
              :key="e.id"
              type="button"
              class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] ring-1 ring-(--ui-border-muted) hover:ring-(--ui-border-accented) text-toned transition"
              @click="addCycle(e.id)"
            >
              <UIcon name="i-lucide-plus" class="size-3" />
              <span class="size-2 rounded-full" :style="{ background: e.color }" />
              <UIcon :name="egressKindIcon[e.kind]" class="size-3 opacity-70" />{{ e.name }}
            </button>
          </div>
        </section>

        <!-- Pinned -->
        <section>
          <h3 class="text-[13px] font-semibold text-highlighted mb-1">{{ t('routes.gen.pinned') }}</h3>
          <p class="text-[12px] text-muted mb-3">{{ t('routes.gen.pinnedHint') }}</p>
          <div class="flex flex-wrap gap-1.5 mb-2">
            <span v-for="p in gen.pinned" :key="p.hour" class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] ring-1 ring-(--ui-border) bg-(--uf-surface-2)">
              <UIcon name="i-lucide-pin" class="size-3 text-dimmed" />
              <span class="uf-num font-medium text-highlighted">{{ String(p.hour).padStart(2, '0') }}:00</span>
              <EgressChip :id="p.egressId" size="xs" />
              <button type="button" class="text-dimmed hover:text-error" :aria-label="t('common.remove')" @click="gen.pinned = gen.pinned.filter(x => x.hour !== p.hour)"><UIcon name="i-lucide-x" class="size-3.5" /></button>
            </span>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <USelect v-model="newPin.hour" :items="hourItems" class="w-28" size="sm" />
            <USelect v-model="newPin.egressId" :items="egressItems" class="w-48" size="sm" />
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-pin" @click="addPin">{{ t('routes.gen.addPin') }}</UButton>
          </div>
        </section>

        <!-- Days & continuity -->
        <section class="grid sm:grid-cols-2 gap-5">
          <div>
            <h3 class="text-[13px] font-semibold text-highlighted mb-2">{{ t('routes.gen.days') }}</h3>
            <div class="flex gap-1">
              <button
                v-for="d in 7"
                :key="d"
                type="button"
                class="size-9 rounded-lg text-[12px] font-medium ring-1 transition"
                :class="gen.days.includes(d - 1) ? 'bg-primary text-white ring-primary' : 'ring-(--ui-border-muted) text-toned hover:ring-(--ui-border-accented)'"
                @click="toggleDay(d - 1)"
              >{{ fmt.weekday(d - 1, 'narrow') }}</button>
            </div>
          </div>
          <div>
            <h3 class="text-[13px] font-semibold text-highlighted mb-2">{{ t('routes.gen.continuity') }}</h3>
            <URadioGroup
              v-model="gen.continuity"
              :items="[
                { value: 'daily-reset', label: t('routes.gen.dailyReset'), description: t('routes.gen.dailyResetHint') },
                { value: 'continuous', label: t('routes.gen.continuous'), description: t('routes.gen.continuousHint') },
              ]"
            />
          </div>
        </section>

        <!-- Preview -->
        <section>
          <h3 class="text-[13px] font-semibold text-highlighted mb-2">{{ t('routes.gen.preview') }}</h3>
          <div class="rounded-lg ring-1 ring-(--ui-border-muted) p-3 bg-(--uf-surface-2)">
            <ScheduleGrid :model-value="preview" :egresses="egresses" :default-egress-id="defaultEgressId" timezone="Asia/Taipei" readonly />
          </div>
        </section>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
        <UButton icon="i-lucide-wand-sparkles" :disabled="!gen.cycle.length || !gen.days.length" @click="apply">{{ t('routes.gen.apply') }}</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.uf-list-move, .uf-list-enter-active, .uf-list-leave-active { transition: all 180ms var(--ease-uf); }
.uf-list-enter-from, .uf-list-leave-to { opacity: 0; transform: scale(0.9); }
</style>
