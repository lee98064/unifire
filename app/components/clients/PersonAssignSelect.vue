<script setup lang="ts">
import type { PersonT } from '#shared/schemas/access'
import { identityPalette } from '~/utils/egress'

/**
 * Pick the person a device belongs to. Typing a name that does not exist offers to create that person.
 * `compact` renders a borderless trigger for table cells ("＋ 指派" when unassigned).
 */
const props = withDefaults(defineProps<{ modelValue: string | null, compact?: boolean, loading?: boolean, placeholder?: string }>(), { compact: false, loading: false })
const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>()
const { t } = useI18n()
const api = useApi()
const toast = useToast()
const { people, refresh, get } = usePeople()

const NONE = '__none__'
type Item = { label: string, value: string, emoji?: string, color?: string }
const items = computed<Item[]>(() => [
  { label: t('clients.noPerson'), value: NONE },
  ...people.value.map(p => ({ label: p.name, value: p.id, emoji: p.avatar, color: p.color })),
])
const value = computed({
  get: () => props.modelValue ?? undefined,
  set: (v: string | undefined) => emit('update:modelValue', !v || v === NONE ? null : v),
})
const current = computed(() => get(props.modelValue))

const creating = ref(false)
async function create(name: string) {
  const trimmed = name.trim().slice(0, 40)
  if (!trimmed) return
  creating.value = true
  try {
    const person = await api.post<PersonT>('/api/people', { name: trimmed, color: identityPalette[people.value.length % identityPalette.length] })
    toast.add({ title: t('clients.personCreated', { name: person.name }), color: 'success', icon: 'i-lucide-user-plus' })
    await refresh()
    emit('update:modelValue', person.id)
  }
  finally { creating.value = false }
}
</script>

<template>
  <USelectMenu
    v-model="value"
    :items="items"
    value-key="value"
    :search-input="{ placeholder: t('clients.searchPerson') }"
    create-item
    :loading="loading || creating"
    :variant="compact ? 'ghost' : 'outline'"
    :size="compact ? 'sm' : 'md'"
    :trailing-icon="compact ? '' : undefined"
    :placeholder="placeholder ?? (compact ? t('clients.assign') : t('clients.assignTo'))"
    :class="compact ? '-ml-2 max-w-[180px]' : 'w-full'"
    :ui="compact ? { base: 'px-2', content: 'min-w-60' } : { content: 'min-w-60' }"
    :content="{ align: 'start' }"
    @create="create"
  >
    <template #default>
      <span v-if="current" class="inline-flex items-center gap-1.5 min-w-0">
        <PersonAvatar :avatar="current.avatar" :color="current.color" :size="compact ? 20 : 22" />
        <span class="truncate text-[12.5px] text-toned">{{ current.name }}</span>
      </span>
      <span v-else class="inline-flex items-center gap-1 text-[12.5px] text-dimmed">
        <UIcon v-if="compact" name="i-lucide-user-plus" class="size-3.5" />{{ placeholder ?? (compact ? t('clients.assign') : t('clients.assignTo')) }}
      </span>
    </template>
    <template #item-leading="{ item }">
      <PersonAvatar v-if="(item as Item).emoji" :avatar="(item as Item).emoji!" :color="(item as Item).color!" :size="20" />
      <UIcon v-else-if="(item as Item).value === NONE" name="i-lucide-user-x" class="size-4 text-dimmed" />
    </template>
  </USelectMenu>
</template>
