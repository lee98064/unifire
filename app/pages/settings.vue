<script setup lang="ts">
import type { SettingsT } from '#shared/schemas/system'

const { t } = useI18n()
const api = useApi()
const route = useRoute()
const router = useRouter()
const tab = computed({ get: () => (route.query.tab as string) || 'general', set: v => router.replace({ query: { tab: v } }) })
const { data: settings } = useFetch<SettingsT>('/api/settings', { key: 'settings' })
const local = ref<SettingsT | null>(null)
watch(settings, v => { if (v) local.value = structuredClone(toRaw(v)) }, { immediate: true })
async function save() {
  if (!local.value) return
  settings.value = await api.patch<SettingsT>('/api/settings', local.value, { success: t('common.saved') })
  useState('site-tz').value = settings.value.timezone
}
const tabs = [
  { value: 'general', icon: 'i-lucide-sliders-horizontal' },
  { value: 'controller', icon: 'i-lucide-router' },
  { value: 'probes', icon: 'i-lucide-radio-tower' },
  { value: 'notifications', icon: 'i-lucide-bell' },
  { value: 'users', icon: 'i-lucide-users-round' },
  { value: 'account', icon: 'i-lucide-user-round-cog' },
]
</script>

<template>
  <div>
    <PageHeader :title="t('nav.settings')" icon="i-lucide-settings" />
    <div class="grid lg:grid-cols-[220px_1fr] gap-6 items-start">
      <nav class="flex lg:flex-col gap-1 overflow-x-auto -mx-1 px-1 lg:sticky lg:top-20">
        <button
          v-for="tb in tabs"
          :key="tb.value"
          type="button"
          class="flex items-center gap-2.5 h-9 px-3 rounded-lg text-[13px] font-medium whitespace-nowrap transition"
          :class="tab === tb.value ? 'bg-primary/10 text-primary' : 'text-toned hover:bg-(--uf-hover) hover:text-highlighted'"
          @click="tab = tb.value"
        >
          <UIcon :name="tb.icon" class="size-4" />{{ t(`settings.tab.${tb.value}`) }}
        </button>
      </nav>
      <div class="min-w-0">
        <GeneralSettings v-if="tab === 'general' && local" v-model="local" @save="save" />
        <ControllerSettings v-else-if="tab === 'controller'" />
        <ProbeSettings v-else-if="tab === 'probes' && local" v-model="local" @save="save" />
        <NotificationSettings v-else-if="tab === 'notifications'" />
        <UsersSettings v-else-if="tab === 'users'" />
        <AccountSettings v-else-if="tab === 'account'" />
        <USkeleton v-else class="h-64 rounded-xl" />
      </div>
    </div>
  </div>
</template>
