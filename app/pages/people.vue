<script setup lang="ts">
import type { PersonT, GroupT, ExtensionRequestT, ClientT } from '#shared/schemas/access'
import type { WeeklyWindowT } from '#shared/schemas/common'
import { identityPalette } from '~/utils/egress'

const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const confirm = useConfirm()
const route = useRoute()
const { people, refresh, get: getPerson } = usePeople()
const { data: groups, refresh: refreshGroups } = useFetch<GroupT[]>('/api/groups', { key: 'groups', default: () => [] })
const { data: requests, refresh: refreshRequests } = useFetch<ExtensionRequestT[]>('/api/extension-requests', { key: 'extension-requests', query: { status: 'pending' }, default: () => [] })
const { data: clients } = useFetch<ClientT[]>('/api/clients', { key: 'clients', default: () => [] })

const pending = computed(() => requests.value.filter(r => r.status === 'pending'))

async function decide(r: ExtensionRequestT, decision: 'approve' | 'deny') {
  await api.post(`/api/extension-requests/${r.id}`, { decision }, { success: decision === 'approve' ? t('people.reqApproved') : t('people.reqDenied') })
  refreshRequests()
  refreshNuxtData(['people', 'badges'])
}

async function groupAction(g: GroupT, action: 'pause' | 'resume') {
  await api.post(`/api/groups/${g.id}/${action}`, action === 'pause' ? { minutes: 60 } : undefined, { success: action === 'pause' ? t('people.groupPaused', { name: g.name }) : t('people.groupResumed', { name: g.name }) })
  refresh()
}

/* editor */
const editing = ref<PersonT | null>(null)
const creating = ref(false)
const emojis = ['🙂', '😎', '🧑‍💻', '👩', '👨', '👧', '👦', '👶', '👵', '👴', '🐱', '🐶', '🦊', '🐼', '🦄', '🚀', '🎮', '📚', '🎧', '🏀']
const form = reactive({ name: '', avatar: '🙂', color: identityPalette[0]!, deviceMacs: [] as string[], presenceMacs: [] as string[], groupIds: [] as string[], bedtime: [] as WeeklyWindowT[] })
function openEdit(p: PersonT | null) {
  creating.value = !p
  editing.value = p
  Object.assign(form, p
    ? { name: p.name, avatar: p.avatar, color: p.color, deviceMacs: [...p.deviceMacs], presenceMacs: [...p.presenceMacs], groupIds: [...p.groupIds], bedtime: structuredClone(toRaw(p.bedtime)) }
    : { name: '', avatar: '🙂', color: identityPalette[people.value.length % identityPalette.length], deviceMacs: [], presenceMacs: [], groupIds: [], bedtime: [] })
}
const editorOpen = computed({ get: () => creating.value || !!editing.value, set: (v) => { if (!v) { creating.value = false; editing.value = null } } })
watch(() => route.query.person, (id) => { const p = getPerson(id as string); if (p) openEdit(p) }, { immediate: true })

const clientItems = computed(() => clients.value.map(c => ({ label: c.displayName, value: c.mac, description: `${c.vendor ?? ''} · ${c.mac}`, icon: c.wired ? 'i-lucide-ethernet-port' : 'i-lucide-smartphone' })))
const presenceItems = computed(() => clientItems.value.filter(i => form.deviceMacs.includes(i.value)))
async function save() {
  const body = { ...form }
  if (creating.value) await api.post('/api/people', body, { success: t('common.saved') })
  else if (editing.value) await api.patch(`/api/people/${editing.value.id}`, body, { success: t('common.saved') })
  editorOpen.value = false
  refresh()
  refreshNuxtData('clients')
}
async function remove() {
  if (!editing.value || !(await confirm({ title: t('people.deleteConfirm', { name: editing.value.name }), color: 'error' })) return
  await api.del(`/api/people/${editing.value.id}`, undefined, { success: t('common.deleted') })
  editorOpen.value = false
  refresh()
}

/* groups */
const groupOpen = ref(false)
const groupForm = reactive({ id: null as string | null, name: '', color: identityPalette[2]!, personIds: [] as string[] })
function openGroup(g: GroupT | null) {
  Object.assign(groupForm, g ? { id: g.id, name: g.name, color: g.color, personIds: [...g.personIds] } : { id: null, name: '', color: identityPalette[2], personIds: [] })
  groupOpen.value = true
}
async function saveGroup() {
  const body = { name: groupForm.name, color: groupForm.color, personIds: groupForm.personIds }
  if (groupForm.id) await api.patch(`/api/groups/${groupForm.id}`, body, { success: t('common.saved') })
  else await api.post('/api/groups', body, { success: t('common.saved') })
  groupOpen.value = false
  refreshGroups()
  refresh()
}
</script>

<template>
  <div>
    <PageHeader :title="t('nav.people')" :description="t('people.desc')" icon="i-lucide-users">
      <template #actions>
        <UButton color="neutral" variant="outline" icon="i-lucide-users-round" @click="openGroup(null)">{{ t('people.addGroup') }}</UButton>
        <UButton icon="i-lucide-user-round-plus" @click="openEdit(null)">{{ t('people.add') }}</UButton>
      </template>
    </PageHeader>

    <!-- Extension requests -->
    <TransitionGroup tag="div" class="space-y-2 mb-5" enter-from-class="opacity-0 -translate-y-2" enter-active-class="transition duration-300" leave-to-class="opacity-0 scale-95" leave-active-class="transition duration-200">
      <div v-for="r in pending" :key="r.id" class="flex flex-wrap items-center gap-3 p-3.5 rounded-xl ring-1 ring-primary/30 bg-primary/5">
        <PersonAvatar v-if="getPerson(r.personId)" :avatar="getPerson(r.personId)!.avatar" :color="getPerson(r.personId)!.color" :size="36" />
        <div class="min-w-0 flex-1">
          <div class="text-[13.5px] font-medium text-highlighted">{{ t('people.reqTitle', { name: getPerson(r.personId)?.name ?? '?', amount: fmt.minutes(r.amount) }) }}</div>
          <div class="text-[12px] text-muted">{{ r.reason ? `“${r.reason}”` : t('people.reqNoReason') }} · <TimeAgo :ts="r.createdAt" /></div>
        </div>
        <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-x" @click="decide(r, 'deny')">{{ t('people.deny') }}</UButton>
        <UButton color="primary" size="sm" icon="i-lucide-check" @click="decide(r, 'approve')">{{ t('people.approve') }}</UButton>
      </div>
    </TransitionGroup>

    <!-- Groups -->
    <div v-if="groups.length" class="flex flex-wrap gap-2 mb-5">
      <div v-for="g in groups" :key="g.id" class="flex items-center gap-2 h-10 pl-3 pr-1.5 rounded-full ring-1 ring-(--ui-border-muted) bg-(--uf-surface)">
        <span class="size-2.5 rounded-full" :style="{ background: g.color }" />
        <button type="button" class="text-[13px] font-medium text-highlighted hover:text-primary" @click="openGroup(g)">{{ g.name }}</button>
        <div class="flex -space-x-1.5">
          <PersonAvatar v-for="pid in g.personIds.slice(0, 4)" :key="pid" :avatar="getPerson(pid)?.avatar ?? '?'" :color="getPerson(pid)?.color ?? '#888'" :size="22" class="ring-2 ring-(--uf-surface) rounded-full" />
        </div>
        <UTooltip :text="t('people.pauseGroup')"><UButton size="xs" color="warning" variant="soft" icon="i-lucide-circle-pause" class="rounded-full" :aria-label="t('people.pauseGroup')" @click="groupAction(g, 'pause')" /></UTooltip>
        <UTooltip :text="t('people.resumeGroup')"><UButton size="xs" color="success" variant="soft" icon="i-lucide-play" class="rounded-full" :aria-label="t('people.resumeGroup')" @click="groupAction(g, 'resume')" /></UTooltip>
      </div>
    </div>

    <div v-if="people.length" class="grid sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
      <PersonCard v-for="p in people" :key="p.id" :person="p" @edit="openEdit(p)" />
    </div>
    <div v-else class="uf-card">
      <EmptyState icon="i-lucide-users" :title="t('people.empty')" :description="t('people.emptyDesc')">
        <UButton icon="i-lucide-user-round-plus" @click="openEdit(null)">{{ t('people.add') }}</UButton>
      </EmptyState>
    </div>

    <!-- Person editor -->
    <USlideover v-model:open="editorOpen" :title="creating ? t('people.add') : t('people.edit')" :ui="{ content: 'sm:max-w-lg' }">
      <template #body>
        <div class="space-y-5">
          <div class="flex items-center gap-4">
            <PersonAvatar :avatar="form.avatar" :color="form.color" :size="64" />
            <UFormField :label="t('people.name')" class="flex-1"><UInput v-model="form.name" class="w-full" size="lg" /></UFormField>
          </div>
          <div>
            <div class="text-[12.5px] font-medium text-toned mb-2">{{ t('people.avatar') }}</div>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="e in emojis" :key="e" type="button" class="size-9 rounded-lg text-lg transition" :class="form.avatar === e ? 'bg-primary/15 ring-2 ring-primary' : 'hover:bg-(--uf-hover)'" @click="form.avatar = e">{{ e }}</button>
            </div>
          </div>
          <div>
            <div class="text-[12.5px] font-medium text-toned mb-2">{{ t('people.color') }}</div>
            <div class="flex flex-wrap gap-2">
              <button v-for="c in identityPalette" :key="c" type="button" class="size-7 rounded-full ring-2 ring-offset-2 ring-offset-(--uf-surface)" :class="form.color === c ? '' : 'ring-transparent'" :style="{ background: c, '--tw-ring-color': c }" :aria-label="c" @click="form.color = c" />
            </div>
          </div>
          <UFormField :label="t('people.devices')" :hint="t('people.devicesHint')">
            <USelectMenu v-model="form.deviceMacs" :items="clientItems" value-key="value" multiple class="w-full" :placeholder="t('people.pickDevices')" />
          </UFormField>
          <UFormField :label="t('people.presenceDevices')" :description="t('people.presenceHint')">
            <USelectMenu v-model="form.presenceMacs" :items="presenceItems" value-key="value" multiple class="w-full" />
          </UFormField>
          <UFormField :label="t('people.groups')">
            <USelectMenu v-model="form.groupIds" :items="groups.map(g => ({ label: g.name, value: g.id }))" value-key="value" multiple class="w-full" />
          </UFormField>
          <div>
            <div class="text-[13px] font-medium text-highlighted mb-1 flex items-center gap-1.5"><UIcon name="i-lucide-moon-star" class="size-4 text-vpn" />{{ t('people.bedtime') }}</div>
            <p class="text-[12px] text-muted mb-2">{{ t('people.bedtimeHint') }}</p>
            <WeeklyWindowsEditor v-model="form.bedtime" />
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton v-if="!creating" color="error" variant="ghost" icon="i-lucide-trash-2" @click="remove">{{ t('common.delete') }}</UButton>
          <UButton class="ml-auto" color="neutral" variant="ghost" @click="editorOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton icon="i-lucide-save" :disabled="!form.name" @click="save">{{ t('common.save') }}</UButton>
        </div>
      </template>
    </USlideover>

    <!-- Group editor -->
    <UModal v-model:open="groupOpen" :title="groupForm.id ? t('people.editGroup') : t('people.addGroup')">
      <template #body>
        <div class="space-y-4">
          <UFormField :label="t('people.groupName')"><UInput v-model="groupForm.name" class="w-full" /></UFormField>
          <div class="flex flex-wrap gap-2">
            <button v-for="c in identityPalette" :key="c" type="button" class="size-7 rounded-full ring-2 ring-offset-2 ring-offset-(--uf-surface)" :class="groupForm.color === c ? '' : 'ring-transparent'" :style="{ background: c, '--tw-ring-color': c }" :aria-label="c" @click="groupForm.color = c" />
          </div>
          <UFormField :label="t('people.members')">
            <USelectMenu v-model="groupForm.personIds" :items="people.map(p => ({ label: `${p.avatar} ${p.name}`, value: p.id }))" value-key="value" multiple class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" @click="groupOpen = false">{{ t('common.cancel') }}</UButton>
          <UButton icon="i-lucide-save" :disabled="!groupForm.name" @click="saveGroup">{{ t('common.save') }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
