<script setup lang="ts">
import { en, zh_tw } from '@nuxt/ui/locale'

// Nuxt UI's own strings (empty tables, "Create …" in select menus, close buttons) follow the app language.
const { locale } = useI18n()
const uiLocale = computed(() => (locale.value === 'en' ? en : zh_tw))
</script>

<template>
  <UApp :locale="uiLocale">
    <NuxtPwaManifest />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
