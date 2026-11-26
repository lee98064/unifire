<script setup lang="ts">
import { activeNavTo, adminNav, mobileTabs, navGroupLabels, settingsNav, type NavItem } from '~/utils/nav'

const { t } = useI18n()
const route = useRoute()
const badges = useBadges()
const moreOpen = ref(false)

const activeTo = computed(() => activeNavTo(route.path))
function isActive(to: string) {
  return activeTo.value === to
}
function badgeCount(item: NavItem) {
  if (item.badge === 'approvals') return badges.approvals.value
  if (item.badge === 'requests') return badges.requests.value
  if (item.badge === 'incidents') return badges.incidents.value
  return 0
}
const moreActive = computed(() => !mobileTabs.some(i => isActive(i.to)))
watch(() => route.fullPath, () => (moreOpen.value = false))
</script>

<template>
  <nav class="lg:hidden fixed bottom-0 inset-x-0 z-30 uf-glass border-t border-(--ui-border-muted) pb-[env(safe-area-inset-bottom)]" :aria-label="t('nav.main')">
    <div class="grid grid-cols-5 h-[58px]">
      <NuxtLink
        v-for="item in mobileTabs"
        :key="item.key"
        :to="item.to"
        class="relative flex flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium transition-colors"
        :class="isActive(item.to) ? 'text-primary' : 'text-dimmed'"
      >
        <span class="relative">
          <UIcon :name="item.icon" class="size-[22px]" />
          <span v-if="badgeCount(item)" class="absolute -top-1 -right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-error text-white text-[9.5px] font-bold leading-[16px] text-center">{{ badgeCount(item) }}</span>
        </span>
        {{ t(item.label) }}
      </NuxtLink>
      <button
        class="flex flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium"
        :class="moreActive ? 'text-primary' : 'text-dimmed'"
        @click="moreOpen = true"
      >
        <UIcon name="i-lucide-layout-grid" class="size-[22px]" />
        {{ t('nav.more') }}
      </button>
    </div>

    <UDrawer v-model:open="moreOpen" :title="t('nav.more')" :ui="{ content: 'bg-(--uf-surface)' }">
      <template #body>
        <div class="space-y-4 pb-4">
          <div v-for="(group, gi) in adminNav.slice(1)" :key="gi">
            <div class="uf-section-title mb-2 px-1">{{ t(navGroupLabels[gi + 1]!) }}</div>
            <div class="grid grid-cols-4 gap-2">
              <NuxtLink
                v-for="item in group"
                :key="item.key"
                :to="item.to"
                class="flex flex-col items-center gap-1.5 py-3 rounded-xl ring-1 ring-(--ui-border-muted) bg-(--uf-surface-2) text-center"
                :class="isActive(item.to) ? 'text-primary ring-primary/40' : 'text-toned'"
              >
                <UIcon :name="item.icon" class="size-5" />
                <span class="text-[11px] font-medium leading-tight px-1">{{ t(item.label) }}</span>
              </NuxtLink>
            </div>
          </div>
          <NuxtLink :to="settingsNav.to" class="flex items-center gap-3 px-3 h-12 rounded-xl ring-1 ring-(--ui-border-muted) bg-(--uf-surface-2) text-toned">
            <UIcon :name="settingsNav.icon" class="size-5" />
            <span class="text-sm font-medium">{{ t(settingsNav.label) }}</span>
            <UIcon name="i-lucide-chevron-right" class="ml-auto size-4 text-dimmed" />
          </NuxtLink>
        </div>
      </template>
    </UDrawer>
  </nav>
</template>
