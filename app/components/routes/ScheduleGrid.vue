<script setup lang="ts">
import type { EgressT } from '#shared/schemas/egress'
import { cloneGrid, gridStats, wallClock, type Grid } from '#shared/utils/schedule'
import { egressKindIcon, onColor } from '~/utils/egress'

/**
 * 7×24 egress painter.
 * - pick a brush (egress or "default"), drag across cells to paint (mouse, pen & touch)
 * - click a day label to fill the row, an hour label to fill the column
 * - keys 1–9 select brushes, ⌘Z / ⇧⌘Z undo/redo
 */
const props = withDefaults(defineProps<{ egresses: EgressT[], defaultEgressId: string, timezone: string, readonly?: boolean }>(), { readonly: false })
const grid = defineModel<Grid>({ required: true })
const { t } = useI18n()
const fmt = useFormat()

const brush = ref<string | null>(props.egresses[0]?.id ?? null)
const egMap = computed(() => new Map(props.egresses.map(e => [e.id, e])))
const defaultEg = computed(() => egMap.value.get(props.defaultEgressId))

/* history */
const past = ref<Grid[]>([])
const future = ref<Grid[]>([])
function commit(next: Grid) {
  past.value.push(cloneGrid(grid.value))
  if (past.value.length > 100) past.value.shift()
  future.value = []
  grid.value = next
}
function undo() {
  const prev = past.value.pop()
  if (!prev) return
  future.value.push(cloneGrid(grid.value))
  grid.value = prev
}
function redo() {
  const nxt = future.value.pop()
  if (!nxt) return
  past.value.push(cloneGrid(grid.value))
  grid.value = nxt
}
defineExpose({ undo, redo, commit })

/* painting */
const painting = ref(false)
let working: Grid | null = null
const gridEl = ref<HTMLElement | null>(null)

function cellFromPoint(x: number, y: number): { d: number, h: number } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const cell = el?.closest<HTMLElement>('[data-cell]')
  if (!cell || !gridEl.value?.contains(cell)) return null
  return { d: Number(cell.dataset.d), h: Number(cell.dataset.h) }
}
function paintAt(x: number, y: number) {
  const c = cellFromPoint(x, y)
  if (!c || !working) return
  if (working[c.d]![c.h] !== brush.value) {
    working[c.d]![c.h] = brush.value
    grid.value = cloneGrid(working)
  }
}
function onDown(e: PointerEvent) {
  if (props.readonly || e.button !== 0) return
  const c = cellFromPoint(e.clientX, e.clientY)
  if (!c) return
  e.preventDefault()
  past.value.push(cloneGrid(grid.value))
  future.value = []
  working = cloneGrid(grid.value)
  painting.value = true
  paintAt(e.clientX, e.clientY)
}
function onMove(e: PointerEvent) {
  if (!painting.value) {
    const c = cellFromPoint(e.clientX, e.clientY)
    hover.value = c
    return
  }
  paintAt(e.clientX, e.clientY)
}
function onUp() {
  painting.value = false
  working = null
}
useEventListener('pointerup', onUp)
useEventListener('pointercancel', onUp)

const hover = ref<{ d: number, h: number } | null>(null)

function fillRow(d: number) {
  if (props.readonly) return
  const g = cloneGrid(grid.value)
  g[d] = Array.from({ length: 24 }, () => brush.value)
  commit(g)
}
function fillCol(h: number) {
  if (props.readonly) return
  const g = cloneGrid(grid.value)
  for (const row of g) row[h] = brush.value
  commit(g)
}

/* keyboard */
const brushes = computed(() => [null, ...props.egresses.map(e => e.id)])
onKeyStroke((e) => {
  if (props.readonly) return
  const target = e.target as HTMLElement
  if (target?.closest('input, textarea, [contenteditable]')) return
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  const n = Number(e.key)
  if (n >= 1 && n <= 9 && brushes.value[n - 1] !== undefined) brush.value = brushes.value[n - 1]!
})

/* now indicator */
const now = useNow({ interval: 60_000 })
const nowWc = computed(() => wallClock(now.value.getTime(), props.timezone))

const stats = computed(() => gridStats(grid.value, props.defaultEgressId))

function cellStyle(id: string | null) {
  const e = id ? egMap.value.get(id) : defaultEg.value
  if (!e) return { background: 'var(--ui-bg-accented)' }
  if (!id) return { background: `repeating-linear-gradient(135deg, color-mix(in oklab, ${e.color} 22%, transparent) 0 4px, color-mix(in oklab, ${e.color} 10%, transparent) 4px 8px)` }
  return { background: e.color }
}
function cellLabel(d: number, h: number) {
  const id = grid.value[d]![h]
  const e = id ? egMap.value.get(id) : defaultEg.value
  return `${fmt.weekday(d)} ${String(h).padStart(2, '0')}:00 — ${e?.name ?? '—'}${id ? '' : ` (${t('routes.default')})`}`
}
function abbr(id: string | null) {
  const e = id ? egMap.value.get(id) : null
  if (!e) return ''
  return e.name.replace(/\(.*?\)/g, '').trim().slice(0, 2)
}
function sameAsLeft(d: number, h: number) {
  return h > 0 && grid.value[d]![h] === grid.value[d]![h - 1]
}
</script>

<template>
  <div class="select-none">
    <!-- Brush palette -->
    <div v-if="!readonly" class="flex flex-wrap items-center gap-1.5 mb-4">
      <span class="uf-section-title mr-1">{{ t('routes.brush') }}</span>
      <button
        v-for="(id, i) in brushes"
        :key="id ?? 'default'"
        type="button"
        class="group inline-flex items-center gap-1.5 h-8 pl-1.5 pr-2.5 rounded-full text-[12.5px] font-medium ring-1 transition-all duration-150"
        :class="brush === id ? 'ring-2 shadow-(--uf-shadow) scale-[1.03]' : 'ring-(--ui-border-muted) hover:ring-(--ui-border-accented) text-toned'"
        :style="brush === id ? { '--tw-ring-color': id ? egMap.get(id)?.color : 'var(--ui-text-dimmed)' } : {}"
        @click="brush = id"
      >
        <span class="size-5 rounded-full flex items-center justify-center" :style="id ? { background: egMap.get(id)?.color, color: onColor(egMap.get(id)!.color) } : cellStyle(null)">
          <UIcon v-if="id" :name="egressKindIcon[egMap.get(id)!.kind]" class="size-3" />
        </span>
        <span :class="brush === id ? 'text-highlighted' : ''">{{ id ? egMap.get(id)?.name : t('routes.defaultBrush', { name: defaultEg?.name ?? '—' }) }}</span>
        <span v-if="id && stats.get(id)" class="text-[10.5px] text-dimmed uf-num">{{ stats.get(id) }}h</span>
        <UKbd v-if="i < 9" size="sm" class="hidden lg:inline-flex opacity-0 group-hover:opacity-100 transition-opacity">{{ i + 1 }}</UKbd>
      </button>
    </div>

    <!-- Grid -->
    <div class="overflow-x-auto -mx-1 px-1 pb-1">
      <div
        ref="gridEl"
        class="relative min-w-[720px] touch-none"
        :class="readonly ? '' : painting ? 'cursor-crosshair' : 'cursor-cell'"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerleave="hover = null"
      >
        <!-- hour header -->
        <div class="grid grid-cols-[52px_repeat(24,minmax(0,1fr))] gap-[3px] mb-[3px]">
          <span />
          <button
            v-for="h in 24"
            :key="h"
            type="button"
            class="h-6 text-[10.5px] uf-num rounded transition-colors"
            :class="[nowWc.hour === h - 1 ? 'text-primary font-semibold' : 'text-dimmed', readonly ? 'cursor-default' : 'hover:bg-(--uf-hover) hover:text-highlighted']"
            :title="readonly ? undefined : t('routes.fillHour')"
            @click="fillCol(h - 1)"
          >{{ String(h - 1).padStart(2, '0') }}</button>
        </div>

        <div v-for="(row, d) in grid" :key="d" class="grid grid-cols-[52px_repeat(24,minmax(0,1fr))] gap-[3px] mb-[3px]">
          <button
            type="button"
            class="h-9 text-[12px] font-medium text-left px-1.5 rounded-md transition-colors flex items-center gap-1"
            :class="[nowWc.day === d ? 'text-primary' : 'text-toned', readonly ? 'cursor-default' : 'hover:bg-(--uf-hover)']"
            :title="readonly ? undefined : t('routes.fillDay')"
            @click="fillRow(d)"
          >
            <span v-if="nowWc.day === d" class="size-1.5 rounded-full bg-primary" />{{ fmt.weekday(d) }}
          </button>
          <div
            v-for="(cell, h) in row"
            :key="h"
            data-cell
            :data-d="d"
            :data-h="h"
            :aria-label="cellLabel(d, h)"
            :title="cellLabel(d, h)"
            class="relative h-9 rounded-[5px] transition-[transform,filter] duration-100 flex items-center justify-center text-[9.5px] font-semibold"
            :class="[
              hover?.d === d && hover?.h === h && !readonly ? 'brightness-110 scale-[1.08] z-10 shadow-(--uf-shadow-lg)' : '',
              nowWc.day === d && nowWc.hour === h ? 'ring-2 ring-offset-1 ring-offset-(--uf-surface) ring-(--ui-text-highlighted)' : '',
            ]"
            :style="{ ...cellStyle(cell), color: cell ? onColor(egMap.get(cell)?.color ?? '#888888') : 'var(--ui-text-muted)' }"
          >
            <span v-if="!sameAsLeft(d, h)" class="opacity-80 pointer-events-none">{{ abbr(cell) }}</span>
          </div>
        </div>

        <!-- now line -->
        <div
          class="absolute pointer-events-none top-[27px] bottom-0 w-[2px] rounded-full bg-(--ui-text-highlighted)/70"
          :style="{ left: `calc(52px + 3px + (100% - 52px - 3px) * ${(nowWc.hour + nowWc.minute / 60) / 24})` }"
        />
      </div>
    </div>

    <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-dimmed">
      <span class="flex items-center gap-1.5"><span class="size-3 rounded-[3px]" :style="cellStyle(null)" />{{ t('routes.legendDefault') }}</span>
      <span class="flex items-center gap-1.5"><span class="size-3 rounded-[3px] ring-2 ring-(--ui-text-highlighted)" />{{ t('routes.legendNow') }}</span>
      <span class="flex items-center gap-1.5"><UIcon name="i-lucide-globe-2" class="size-3.5" />{{ timezone }}</span>
      <span v-if="!readonly" class="hidden lg:flex items-center gap-1.5 ml-auto"><UIcon name="i-lucide-mouse-pointer-2" class="size-3.5" />{{ t('routes.paintHint') }}</span>
    </div>
  </div>
</template>
