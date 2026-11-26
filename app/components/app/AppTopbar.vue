<script setup lang="ts">
const { t, locale, locales, setLocale } = useI18n()
const colorMode = useColorMode()
const { user, clear } = useUserSession()
const live = useLive()
const { status, isDryRun, isMock } = useControllerStatus()
const { wans } = useEgresses()
const fmt = useFormat()
const palette = useState('cmdk-open', () => false)
const badges = useBadges()
const isMac = computed(() => import.meta.client && /Mac|iPhone|iPad/.test(navigator.platform))

const notifCount = computed(() => badges.approvals.value + badges.requests.value)

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
  await clear()
  await navigateTo('/login')
}

const userMenu = computed(() => [
  [{ label: user.value?.displayName ?? '', type: 'label' as const, avatar: { text: user.value?.displayName?.slice(0, 1) } }],
  [
    { label: t('topbar.account'), icon: 'i-lucide-user-round-cog', to: '/settings?tab=account' },
    {
      label: t('topbar.theme'),
      icon: colorMode.value === 'dark' ? 'i-lucide-moon' : 'i-lucide-sun',
      children: [
        { label: t('topbar.themeLight'), icon: 'i-lucide-sun', onSelect: () => (colorMode.preference = 'light') },
        { label: t('topbar.themeDark'), icon: 'i-lucide-moon', onSelect: () => (colorMode.preference = 'dark') },
        { label: t('topbar.themeSystem'), icon: 'i-lucide-monitor', onSelect: () => (colorMode.preference = 'system') },
      ],
    },
    {
      label: t('topbar.language'),
      icon: 'i-lucide-languages',
      children: locales.value.map(l => ({ label: l.name, checked: locale.value === l.code, type: 'checkbox' as const, onSelect: () => setLocale(l.code) })),
    },
  ],
  [{ label: t('topbar.logout'), icon: 'i-lucide-log-out', color: 'error' as const, onSelect: logout }],
])
</script>

<template>
  <header class="sticky top-0 z-20 h-14 shrink-0 flex items-center gap-2 sm:gap-3 px-3 sm:px-5 uf-glass border-b border-(--ui-border-muted) pt-[env(safe-area-inset-top)] box-content">
    <NuxtLink to="/" class="lg:hidden">
      <AppLogo :size="26" />
    </NuxtLink>

    <!-- Site -->
    <div class="hidden md:flex items-center gap-2 min-w-0">
      <div class="flex items-center gap-2 px-2.5 h-8 rounded-md bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) min-w-0">
        <UIcon name="i-lucide-router" class="size-4 text-primary shrink-0" />
        <span class="text-[13px] font-medium text-highlighted truncate max-w-[180px]">{{ status?.model ?? 'UniFi' }}</span>
        <span v-if="status?.site" class="text-[12px] text-dimmed truncate">· {{ status.site }}</span>
        <span
          class="size-1.5 rounded-full shrink-0"
          :class="status?.connected ? 'bg-success' : 'bg-error'"
          :title="status?.connected ? t('topbar.connected') : t('topbar.disconnected')"
        />
      </div>
    </div>

    <!-- Search -->
    <button
      class="flex-1 md:flex-none md:w-[300px] flex items-center gap-2 h-8 px-2.5 rounded-md bg-(--uf-surface-2) ring-1 ring-(--ui-border-muted) text-dimmed hover:ring-(--ui-border-accented) transition text-left"
      @click="palette = true"
    >
      <UIcon name="i-lucide-search" class="size-4" />
      <span class="text-[13px] flex-1 truncate">{{ t('topbar.search') }}</span>
      <span class="hidden sm:flex gap-0.5">
        <UKbd size="sm">{{ isMac ? '⌘' : 'Ctrl' }}</UKbd><UKbd size="sm">K</UKbd>
      </span>
    </button>

    <div class="flex-1 hidden md:block" />

    <!-- WAN pills -->
    <div class="hidden xl:flex items-center gap-1.5">
      <UTooltip v-for="w in wans" :key="w.id" :text="`${w.name} · ${w.publicIp?.ip ?? '—'}`">
        <NuxtLink
          to="/egresses"
          class="flex items-center gap-1.5 h-7 px-2 rounded-full ring-1 ring-(--ui-border-muted) bg-(--uf-surface) text-[12px] hover:ring-(--ui-border-accented) transition"
        >
          <StatusDot :status="w.health.status" pulse />
          <span class="font-medium text-highlighted">{{ w.wanGroup?.replace('WAN', 'WAN') ?? w.name }}</span>
          <span class="text-dimmed uf-num">{{ fmt.ms(w.health.latencyMs) }}</span>
        </NuxtLink>
      </UTooltip>
    </div>

    <!-- Safety mode -->
    <UTooltip v-if="isDryRun || isMock" :text="isMock ? t('topbar.mockHint') : t('topbar.dryRunHint')">
      <NuxtLink
        to="/settings?tab=controller"
        class="flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] font-semibold ring-1"
        :class="isMock ? 'bg-vpn/10 text-vpn ring-vpn/30' : 'bg-warning/10 text-warning ring-warning/30'"
      >
        <UIcon :name="isMock ? 'i-lucide-flask-conical' : 'i-lucide-shield-alert'" class="size-3.5" />
        <span class="hidden sm:inline">{{ isMock ? t('topbar.mock') : t('topbar.dryRun') }}</span>
      </NuxtLink>
    </UTooltip>

    <UTooltip :text="live.connected.value ? t('topbar.liveOn') : t('topbar.liveOff')">
      <span class="hidden sm:flex items-center justify-center size-8">
        <span class="relative flex size-2">
          <span v-if="live.connected.value" class="absolute inline-flex size-full rounded-full bg-success opacity-60 animate-ping" />
          <span class="relative inline-flex size-2 rounded-full" :class="live.connected.value ? 'bg-success' : 'bg-(--ui-text-dimmed)'" />
        </span>
      </span>
    </UTooltip>

    <UButton
      to="/approvals"
      color="neutral"
      variant="ghost"
      square
      class="relative"
      :aria-label="t('topbar.notifications')"
    >
      <UIcon name="i-lucide-bell" class="size-[18px]" />
      <span v-if="notifCount" class="absolute top-1 right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-error text-white text-[9.5px] font-bold leading-[15px] text-center">{{ notifCount }}</span>
    </UButton>

    <UDropdownMenu :items="userMenu" :content="{ align: 'end' }" :ui="{ content: 'w-56' }">
      <UButton color="neutral" variant="ghost" class="px-1.5" :aria-label="t('topbar.userMenu')">
        <UAvatar :text="user?.displayName?.slice(0, 1) ?? '?'" size="sm" class="bg-primary text-white" />
      </UButton>
    </UDropdownMenu>
  </header>
</template>
