<script setup lang="ts">
// PoE watchdogs moved into the PoE page (phase 2). Keep old links and PWA shortcuts working.
definePageMeta({ middleware: () => navigateTo({ path: '/devices/poe', query: { tab: 'watchdogs' } }, { replace: true }) })
</script>

<template>
  <div />
</template>
