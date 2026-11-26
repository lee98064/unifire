<script setup lang="ts">
const { t } = useI18n()
const { user, clear } = useUserSession()
const live = useLive()
onMounted(() => live.connect())
async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
  await clear()
  await navigateTo('/login')
}
</script>

<template>
  <div class="min-h-dvh">
    <header class="sticky top-0 z-20 uf-glass border-b border-(--ui-border-muted) pt-[env(safe-area-inset-top)]">
      <div class="mx-auto max-w-2xl h-14 px-4 flex items-center gap-3">
        <NuxtLink to="/me"><AppLogo :size="26" wordmark /></NuxtLink>
        <div class="flex-1" />
        <UDropdownMenu :items="[[{ label: t('topbar.account'), icon: 'i-lucide-user-round-cog', to: '/account' }], [{ label: t('topbar.logout'), icon: 'i-lucide-log-out', color: 'error', onSelect: logout }]]" :content="{ align: 'end' }">
          <UButton color="neutral" variant="ghost" class="px-1.5"><UAvatar :text="user?.displayName?.slice(0, 1)" size="sm" class="bg-primary text-white" /></UButton>
        </UDropdownMenu>
      </div>
    </header>
    <main class="mx-auto max-w-2xl px-4 py-6 pb-[calc(24px+env(safe-area-inset-bottom))]">
      <slot />
    </main>
    <PwaPrompts />
  </div>
</template>
