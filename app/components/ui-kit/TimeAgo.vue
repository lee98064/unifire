<script setup lang="ts">
const props = defineProps<{ ts: number | null | undefined }>()
const fmt = useFormat()
const now = useClock(30_000)
const label = computed(() => fmt.ago(props.ts, now.value.getTime()))
</script>

<template>
  <UTooltip :text="fmt.dateTime(ts)" :disabled="!ts"><span class="uf-num">{{ label }}</span></UTooltip>
</template>
