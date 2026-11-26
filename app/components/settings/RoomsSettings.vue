<script setup lang="ts">
import type { RoomT } from '#shared/schemas/infra'
import type { SettingsT } from '#shared/schemas/system'
import { identityPalette } from '~/utils/egress'

/**
 * Rooms for room-level presence: create rooms, then drag AP cards into them (or use the picker on
 * touch screens). A person's room = the room of the AP their phone is on (with dwell hysteresis).
 */
const settings = defineModel<SettingsT>({ required: true })
const emit = defineEmits<{ save: [] }>()
const { t } = useI18n()
const api = useApi()
const confirm = useConfirm()
const { devices } = useDevices()
const { get: person } = usePeople()
const { data: rooms, refresh, error } = useFetch<RoomT[]>('/api/rooms', { key: 'rooms', default: () => [] })

const aps = computed(() => devices.value.filter(d => d.type === 'ap'))
const roomOf = computed(() => {
  const m = new Map<string, string>()
  for (const r of rooms.value) for (const mac of r.apMacs) m.set(mac, r.id)
  return m
})
const unassigned = computed(() => aps.value.filter(a => !roomOf.value.has(a.mac)))
const floors = computed(() => {
  const m = new Map<string, RoomT[]>()
  for (const r of [...rooms.value].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))) {
    const k = r.floor ?? ''
    m.set(k, [...(m.get(k) ?? []), r])
  }
  return [...m.entries()]
})
const apName = (mac: string) => aps.value.find(a => a.mac === mac)?.name ?? mac

/* drag & drop */
const dragging = ref<string | null>(null)
const over = ref<string | null>(null)
function onDragStart(e: DragEvent, mac: string) {
  dragging.value = mac
  e.dataTransfer?.setData('text/plain', mac)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
async function assign(mac: string, roomId: string | null) {
  dragging.value = null
  over.value = null
  if ((roomOf.value.get(mac) ?? null) === roomId) return
  rooms.value = await api.put<RoomT[]>('/api/rooms/assign', { apMac: mac, roomId })
  refreshNuxtData(['devices'])
}
function onDrop(e: DragEvent, roomId: string | null) {
  const mac = e.dataTransfer?.getData('text/plain') || dragging.value
  if (mac) void assign(mac, roomId)
}

/* room editor */
const icons = ['sofa', 'bed-double', 'bed-single', 'baby', 'utensils', 'monitor', 'briefcase', 'bath', 'gamepad-2', 'book-open', 'dumbbell', 'tree-pine', 'car', 'door-open', 'warehouse', 'house']
const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ name: '', floor: '' as string, icon: 'sofa', color: identityPalette[0]! })
function openEditor(r: RoomT | null) {
  editingId.value = r?.id ?? null
  Object.assign(form, r ? { name: r.name, floor: r.floor ?? '', icon: r.icon ?? 'sofa', color: r.color ?? identityPalette[0] } : { name: '', floor: floors.value.at(-1)?.[0] ?? '', icon: 'sofa', color: identityPalette[rooms.value.length % identityPalette.length] })
  editorOpen.value = true
}
async function saveRoom() {
  const body = { name: form.name, floor: form.floor || null, icon: form.icon, color: form.color, order: editingId.value ? undefined : rooms.value.length }
  if (editingId.value) await api.patch(`/api/rooms/${editingId.value}`, body, { success: t('common.saved') })
  else await api.post('/api/rooms', body, { success: t('common.saved') })
  editorOpen.value = false
  refresh()
}
async function removeRoom() {
  if (!editingId.value || !(await confirm({ title: t('rooms.deleteConfirm', { name: form.name }), description: t('rooms.deleteDesc'), color: 'error' }))) return
  await api.del(`/api/rooms/${editingId.value}`, undefined, { success: t('common.deleted') })
  editorOpen.value = false
  refresh()
}
const floorItems = computed(() => [...new Set(rooms.value.map(r => r.floor).filter((f): f is string => !!f))])
</script>

<template>
  <div class="space-y-5">
    <div class="uf-card p-5">
      <div class="flex flex-col sm:flex-row sm:items-start gap-3">
        <span class="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0"><UIcon name="i-lucide-door-open" class="size-4" /></span>
        <div class="flex-1">
          <h3 class="text-[14px] font-semibold text-highlighted">{{ t('rooms.title') }}</h3>
          <p class="text-[12.5px] text-muted">{{ t('rooms.desc') }}</p>
        </div>
        <UButton icon="i-lucide-plus" @click="openEditor(null)">{{ t('rooms.add') }}</UButton>
      </div>
      <div v-if="settings.rooms" class="mt-4 flex flex-wrap items-center gap-3 text-[12.5px]">
        <span class="text-toned">{{ t('rooms.dwell') }}</span>
        <UInputNumber :model-value="settings.rooms.dwellMinutes" :min="1" :max="30" size="sm" class="w-28" @update:model-value="settings = { ...settings, rooms: { dwellMinutes: $event ?? 2 } }" />
        <span class="text-dimmed">{{ t('rooms.dwellHint') }}</span>
        <UButton size="sm" color="neutral" variant="outline" class="ml-auto" @click="emit('save')">{{ t('common.save') }}</UButton>
      </div>
    </div>

    <UAlert v-if="error" color="warning" variant="subtle" icon="i-lucide-clock" :title="t('rooms.unavailable')" />

    <!-- unassigned APs -->
    <div
      class="rounded-xl p-4 border-2 border-dashed transition"
      :class="over === '__none' ? 'border-primary bg-primary/5' : 'border-(--ui-border-accented)'"
      @dragover.prevent="over = '__none'"
      @dragleave="over = null"
      @drop.prevent="onDrop($event, null)"
    >
      <div class="uf-section-title mb-2.5">{{ t('rooms.unassigned') }} · {{ unassigned.length }}</div>
      <div v-if="unassigned.length" class="flex flex-wrap gap-2">
        <div v-for="ap in unassigned" :key="ap.mac" draggable="true" class="flex items-center gap-2 h-9 pl-1.5 pr-1 rounded-lg bg-(--uf-surface) ring-1 ring-(--ui-border-muted) shadow-(--uf-shadow) cursor-grab active:cursor-grabbing" @dragstart="onDragStart($event, ap.mac)" @dragend="dragging = null">
          <DeviceGlyph :type="ap.type" :model="ap.model" :state="ap.state" :size="26" />
          <span class="text-[12.5px] font-medium text-highlighted">{{ ap.name }}</span>
          <USelectMenu :model-value="undefined" :items="rooms.map(r => ({ label: r.name, value: r.id }))" value-key="value" size="xs" variant="ghost" :placeholder="t('rooms.moveTo')" class="w-28" @update:model-value="(v: string) => assign(ap.mac, v)" />
        </div>
      </div>
      <p v-else class="text-[12.5px] text-dimmed">{{ aps.length ? t('rooms.allAssigned') : t('rooms.noAps') }}</p>
    </div>

    <!-- rooms by floor -->
    <div v-for="[floor, list] in floors" :key="floor || 'none'">
      <div v-if="floor" class="uf-section-title mb-2.5 flex items-center gap-1.5"><UIcon name="i-lucide-layers" class="size-3.5" />{{ floor }}</div>
      <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
        <div
          v-for="r in list"
          :key="r.id"
          class="uf-card p-4 transition ring-2"
          :class="over === r.id ? 'ring-primary' : 'ring-transparent'"
          @dragover.prevent="over = r.id"
          @dragleave="over = null"
          @drop.prevent="onDrop($event, r.id)"
        >
          <div class="flex items-center gap-3 mb-3">
            <span class="size-10 rounded-xl flex items-center justify-center shrink-0" :style="{ background: `color-mix(in oklab, ${r.color ?? '#888'} 16%, transparent)`, color: r.color ?? undefined }">
              <UIcon :name="`i-lucide-${r.icon ?? 'house'}`" class="size-5" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="text-[14px] font-semibold text-highlighted truncate">{{ r.name }}</div>
              <div class="text-[11.5px] text-dimmed">{{ t('rooms.apsN', { n: r.apMacs.length }) }}</div>
            </div>
            <div v-if="r.occupants.length" class="flex -space-x-1.5">
              <PersonAvatar v-for="pid in r.occupants.slice(0, 3)" :key="pid" :avatar="person(pid)?.avatar ?? '?'" :color="person(pid)?.color ?? '#888'" :size="22" class="ring-2 ring-(--uf-surface) rounded-full" />
            </div>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="t('common.edit')" @click="openEditor(r)" />
          </div>
          <div class="min-h-12 rounded-lg bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) p-2 flex flex-wrap gap-1.5">
            <div v-for="mac in r.apMacs" :key="mac" draggable="true" class="flex items-center gap-1.5 h-7 pl-2 pr-0.5 rounded-md bg-(--uf-surface) ring-1 ring-(--ui-border-muted) cursor-grab text-[12px] text-highlighted" @dragstart="onDragStart($event, mac)" @dragend="dragging = null">
              <UIcon name="i-lucide-wifi" class="size-3.5 text-dimmed" />{{ apName(mac) }}
              <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="t('rooms.unassign')" @click="assign(mac, null)" />
            </div>
            <span v-if="!r.apMacs.length" class="text-[11.5px] text-dimmed self-center px-1">{{ t('rooms.dropHere') }}</span>
          </div>
        </div>
      </div>
    </div>
    <div v-if="!rooms.length && !error" class="uf-card"><EmptyState icon="i-lucide-door-open" :title="t('rooms.empty')" :description="t('rooms.emptyDesc')"><UButton icon="i-lucide-plus" @click="openEditor(null)">{{ t('rooms.add') }}</UButton></EmptyState></div>

    <UModal v-model:open="editorOpen" :title="editingId ? t('rooms.edit') : t('rooms.add')">
      <template #body>
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <UFormField :label="t('rooms.name')"><UInput v-model="form.name" class="w-full" :placeholder="t('rooms.namePh')" /></UFormField>
            <UFormField :label="t('rooms.floor')"><UInputMenu v-model="form.floor" :items="floorItems" create-item class="w-full" :placeholder="t('rooms.floorPh')" /></UFormField>
          </div>
          <UFormField :label="t('rooms.icon')">
            <div class="flex flex-wrap gap-1.5">
              <button v-for="ic in icons" :key="ic" type="button" class="size-9 rounded-lg flex items-center justify-center ring-1 transition" :class="form.icon === ic ? 'ring-primary bg-primary/10 text-primary' : 'ring-(--ui-border-muted) text-toned hover:ring-(--ui-border-accented)'" :aria-label="ic" @click="form.icon = ic">
                <UIcon :name="`i-lucide-${ic}`" class="size-4" />
              </button>
            </div>
          </UFormField>
          <UFormField :label="t('rooms.color')">
            <div class="flex flex-wrap gap-2">
              <button v-for="c in identityPalette" :key="c" type="button" class="size-7 rounded-full ring-2 ring-offset-2 ring-offset-(--uf-surface) transition" :class="form.color === c ? '' : 'ring-transparent hover:scale-110'" :style="{ background: c, '--tw-ring-color': c }" :aria-label="c" @click="form.color = c" />
            </div>
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton v-if="editingId" color="error" variant="ghost" icon="i-lucide-trash-2" @click="removeRoom">{{ t('common.delete') }}</UButton>
          <UButton class="ml-auto" color="neutral" variant="ghost" @click="editorOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton icon="i-lucide-save" :disabled="!form.name" @click="saveRoom">{{ t('common.save') }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
