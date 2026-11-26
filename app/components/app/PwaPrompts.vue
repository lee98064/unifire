<script setup lang="ts">
/** Update-available toast + install hint (incl. iOS "Add to Home Screen" guidance). */
const { $pwa } = useNuxtApp()
const { t } = useI18n()
const toast = useToast()
const dismissedIos = useLocalStorage('uf-ios-a2hs-dismissed', false)
const isIos = computed(() => import.meta.client && /iPhone|iPad|iPod/.test(navigator.userAgent) && !(window.navigator as Navigator & { standalone?: boolean }).standalone)
const showIos = computed(() => isIos.value && !dismissedIos.value)

watch(() => $pwa?.needRefresh, (v) => {
  if (!v) return
  toast.add({
    title: t('pwa.updateTitle'),
    description: t('pwa.updateBody'),
    icon: 'i-lucide-sparkles',
    duration: 0,
    actions: [{ label: t('pwa.reload'), color: 'primary', onClick: () => $pwa?.updateServiceWorker(true) }],
  })
}, { immediate: true })
</script>

<template>
  <div>
    <Transition enter-from-class="translate-y-4 opacity-0" enter-active-class="transition duration-300" leave-to-class="translate-y-4 opacity-0" leave-active-class="transition duration-200">
      <div
        v-if="$pwa?.showInstallPrompt && !$pwa?.offlineReady"
        class="fixed z-40 bottom-[calc(72px+env(safe-area-inset-bottom))] lg:bottom-6 right-4 left-4 sm:left-auto sm:w-[360px] uf-card shadow-(--uf-shadow-lg) p-4 flex gap-3"
      >
        <AppLogo :size="36" />
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold text-highlighted">{{ t('pwa.installTitle') }}</div>
          <div class="text-[12.5px] text-muted mt-0.5">{{ t('pwa.installBody') }}</div>
          <div class="mt-3 flex gap-2">
            <UButton size="sm" @click="$pwa?.install()">{{ t('pwa.install') }}</UButton>
            <UButton size="sm" color="neutral" variant="ghost" @click="$pwa?.cancelInstall()">{{ t('common.later') }}</UButton>
          </div>
        </div>
      </div>
    </Transition>
    <div
      v-if="showIos"
      class="lg:hidden fixed z-40 bottom-[calc(72px+env(safe-area-inset-bottom))] left-4 right-4 uf-card shadow-(--uf-shadow-lg) p-4 flex gap-3 items-start"
    >
      <UIcon name="i-lucide-share" class="size-5 text-primary mt-0.5" />
      <div class="flex-1 text-[12.5px] text-toned">{{ t('pwa.iosHint') }}</div>
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="t('common.close')" @click="dismissedIos = true" />
    </div>
  </div>
</template>
