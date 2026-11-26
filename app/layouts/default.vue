<script setup lang="ts">
const live = useLive()
onMounted(() => live.connect())
</script>

<template>
  <div class="flex min-h-dvh overflow-x-clip">
    <AppRail />
    <div class="flex-1 min-w-0 flex flex-col">
      <AppTopbar />
      <main class="flex-1 min-w-0 px-3 sm:px-5 lg:px-7 pt-4 sm:pt-6 pb-[calc(76px+env(safe-area-inset-bottom))] lg:pb-10">
        <div class="mx-auto w-full max-w-[1480px]">
          <slot />
        </div>
      </main>
    </div>
    <AppMobileNav />
    <AppCommandPalette />
    <PwaPrompts />
  </div>
</template>
