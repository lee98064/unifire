<script setup lang="ts">
import { adminNav, navGroupLabels, settingsNav, type NavItem } from '~/utils/nav'

const { t } = useI18n()
const route = useRoute()
const expanded = useLocalStorage('uf-rail-expanded', false)
const badges = useBadges()

function isActive(item: NavItem) {
  if (item.to === '/') return route.path === '/'
  return route.path === item.to || route.path.startsWith(`${item.to}/`)
}
function badgeCount(item: NavItem) {
  if (item.badge === 'approvals') return badges.approvals.value
  if (item.badge === 'requests') return badges.requests.value
  return 0
}
</script>

<template>
  <nav
    class="hidden lg:flex flex-col shrink-0 h-dvh sticky top-0 z-30 border-r border-(--ui-border-muted) bg-(--uf-rail) transition-[width] duration-200 ease-(--ease-uf)"
    :class="expanded ? 'w-[232px]' : 'w-[64px]'"
    :aria-label="t('nav.main')"
  >
    <div class="h-14 flex items-center px-[18px] gap-2 shrink-0">
      <NuxtLink to="/" class="flex items-center" :aria-label="t('nav.dashboard')">
        <AppLogo :size="28" :wordmark="expanded" />
      </NuxtLink>
    </div>

    <div class="flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-3">
      <template v-for="(group, gi) in adminNav" :key="gi">
        <div v-if="gi > 0" class="mt-3 mb-1.5 h-4 flex items-center">
          <span v-if="expanded" class="uf-section-title px-2.5 truncate">{{ t(navGroupLabels[gi]!) }}</span>
          <span v-else class="mx-auto w-5 border-t border-(--ui-border-muted)" />
        </div>
        <UTooltip
          v-for="item in group"
          :key="item.key"
          :text="t(item.label)"
          :content="{ side: 'right', sideOffset: 10 }"
          :disabled="expanded"
          :delay-duration="150"
        >
          <NuxtLink
            :to="item.to"
            class="group relative flex items-center h-10 rounded-lg mb-0.5 transition-colors duration-150"
            :class="[
              expanded ? 'px-2.5 gap-3' : 'justify-center',
              isActive(item) ? 'bg-primary/10 text-primary' : 'text-toned hover:bg-(--uf-hover) hover:text-highlighted',
            ]"
            :aria-current="isActive(item) ? 'page' : undefined"
          >
            <span
              v-if="isActive(item)"
              class="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-primary"
              :class="expanded ? '-ml-2.5' : '-ml-2.5'"
            />
            <UIcon :name="item.icon" class="size-[19px] shrink-0" />
            <span v-if="expanded" class="text-[13.5px] font-medium truncate flex-1">{{ t(item.label) }}</span>
            <span
              v-if="badgeCount(item)"
              class="min-w-[18px] h-[18px] px-1 rounded-full bg-error text-white text-[10.5px] font-semibold leading-[18px] text-center uf-num"
              :class="expanded ? '' : 'absolute top-1 right-1.5 scale-90'"
            >{{ badgeCount(item) > 99 ? '99+' : badgeCount(item) }}</span>
          </NuxtLink>
        </UTooltip>
      </template>
    </div>

    <div class="px-2.5 pb-3 pt-2 border-t border-(--ui-border-muted) space-y-0.5">
      <UTooltip :text="t(settingsNav.label)" :content="{ side: 'right', sideOffset: 10 }" :disabled="expanded">
        <NuxtLink
          :to="settingsNav.to"
          class="flex items-center h-10 rounded-lg transition-colors"
          :class="[
            expanded ? 'px-2.5 gap-3' : 'justify-center',
            isActive(settingsNav) ? 'bg-primary/10 text-primary' : 'text-toned hover:bg-(--uf-hover) hover:text-highlighted',
          ]"
        >
          <UIcon :name="settingsNav.icon" class="size-[19px]" />
          <span v-if="expanded" class="text-[13.5px] font-medium">{{ t(settingsNav.label) }}</span>
        </NuxtLink>
      </UTooltip>
      <button
        class="w-full flex items-center h-9 rounded-lg text-dimmed hover:text-highlighted hover:bg-(--uf-hover) transition-colors"
        :class="expanded ? 'px-2.5 gap-3' : 'justify-center'"
        :aria-label="expanded ? t('nav.collapse') : t('nav.expand')"
        @click="expanded = !expanded"
      >
        <UIcon :name="expanded ? 'i-lucide-panel-left-close' : 'i-lucide-panel-left-open'" class="size-[18px]" />
        <span v-if="expanded" class="text-[13px]">{{ t('nav.collapse') }}</span>
      </button>
    </div>
  </nav>
</template>
