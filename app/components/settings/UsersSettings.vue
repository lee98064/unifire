<script setup lang="ts">
import type { UserT } from '#shared/schemas/auth'

const { t } = useI18n()
const api = useApi()
const confirm = useConfirm()
const { user: me } = useUserSession()
const { data: users, refresh } = useFetch<UserT[]>('/api/users', { key: 'users', default: () => [] })
const { people, get: getPerson } = usePeople()

const open = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ username: '', displayName: '', password: '', role: 'member' as 'admin' | 'member', personId: null as string | null, locale: 'zh-TW' as 'zh-TW' | 'en' })
function openEditor(u: UserT | null) {
  editingId.value = u?.id ?? null
  Object.assign(form, u ? { username: u.username, displayName: u.displayName, password: '', role: u.role, personId: u.personId, locale: u.locale } : { username: '', displayName: '', password: '', role: 'member', personId: null, locale: 'zh-TW' })
  open.value = true
}
async function save() {
  const body: Record<string, unknown> = { username: form.username, displayName: form.displayName, role: form.role, personId: form.personId, locale: form.locale }
  if (form.password) body.password = form.password
  if (editingId.value) await api.patch(`/api/users/${editingId.value}`, body, { success: t('common.saved') })
  else await api.post('/api/users', body, { success: t('common.saved') })
  open.value = false
  refresh()
}
async function remove(u: UserT) {
  if (!(await confirm({ title: t('settings.users.deleteConfirm', { name: u.displayName }), color: 'error' }))) return
  await api.del(`/api/users/${u.id}`, undefined, { success: t('common.deleted') })
  refresh()
}
</script>

<template>
  <div class="uf-card p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h3 class="text-[14px] font-semibold text-highlighted">{{ t('settings.users.title') }}</h3>
        <p class="text-[12.5px] text-muted">{{ t('settings.users.desc') }}</p>
      </div>
      <UButton size="sm" icon="i-lucide-user-round-plus" @click="openEditor(null)">{{ t('settings.users.add') }}</UButton>
    </div>
    <div class="divide-y divide-(--ui-border-muted) rounded-lg ring-1 ring-(--ui-border-muted)">
      <div v-for="u in users" :key="u.id" class="flex items-center gap-3 px-3 py-3">
        <UAvatar :text="u.displayName.slice(0, 1)" size="sm" :class="u.role === 'admin' ? 'bg-primary text-white' : 'bg-(--ui-bg-accented)'" />
        <div class="min-w-0 flex-1">
          <div class="text-[13.5px] font-medium text-highlighted flex items-center gap-2">{{ u.displayName }} <span class="text-[12px] text-dimmed font-normal">@{{ u.username }}</span><UBadge v-if="u.id === me?.id" color="neutral" variant="outline" size="xs">{{ t('settings.users.you') }}</UBadge></div>
          <div class="text-[11.5px] text-dimmed flex items-center gap-1.5">
            <UBadge :color="u.role === 'admin' ? 'primary' : 'neutral'" variant="subtle" size="xs">{{ t(`settings.users.role.${u.role}`) }}</UBadge>
            <span v-if="getPerson(u.personId)">→ {{ getPerson(u.personId)!.avatar }} {{ getPerson(u.personId)!.name }}</span>
            <UIcon v-if="u.hasPasskey" name="i-lucide-fingerprint" class="size-3.5 text-success" />
            <span>· {{ t('settings.users.lastLogin') }} <TimeAgo :ts="u.lastLoginAt" /></span>
          </div>
        </div>
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="t('common.edit')" @click="openEditor(u)" />
        <UButton v-if="u.id !== me?.id" size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" :aria-label="t('common.delete')" @click="remove(u)" />
      </div>
    </div>

    <UModal v-model:open="open" :title="editingId ? t('settings.users.edit') : t('settings.users.add')">
      <template #body>
        <div class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <UFormField :label="t('login.username')"><UInput v-model="form.username" class="w-full" autocomplete="off" /></UFormField>
            <UFormField :label="t('setup.admin.displayName')"><UInput v-model="form.displayName" class="w-full" /></UFormField>
          </div>
          <UFormField :label="t('login.password')" :hint="editingId ? t('settings.users.keepPw') : t('setup.admin.pwHint')"><UInput v-model="form.password" type="password" class="w-full" autocomplete="new-password" /></UFormField>
          <UFormField :label="t('settings.users.roleLabel')">
            <URadioGroup v-model="form.role" orientation="horizontal" :items="[{ value: 'member', label: t('settings.users.role.member'), description: t('settings.users.memberHint') }, { value: 'admin', label: t('settings.users.role.admin'), description: t('settings.users.adminHint') }]" />
          </UFormField>
          <UFormField :label="t('settings.users.person')" :description="t('settings.users.personHint')">
            <USelectMenu v-model="form.personId" :items="[{ label: '—', value: null }, ...people.map(p => ({ label: `${p.avatar} ${p.name}`, value: p.id }))]" value-key="value" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton color="neutral" variant="ghost" @click="open = false">{{ t('common.cancel') }}</UButton>
          <UButton icon="i-lucide-save" :disabled="!form.username || !form.displayName || (!editingId && form.password.length < 8) || (form.role === 'member' && !form.personId)" @click="save">{{ t('common.save') }}</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
