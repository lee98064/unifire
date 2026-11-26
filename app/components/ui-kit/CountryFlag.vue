<script setup lang="ts">
import { countryIcon } from '~/utils/egress'

const props = withDefaults(defineProps<{ code: string | null | undefined, size?: number }>(), { size: 16 })
const icon = computed(() => countryIcon(props.code))
</script>

<template>
  <UIcon v-if="icon" :name="icon" :style="{ width: `${size}px`, height: `${size}px` }" class="shrink-0 rounded-full ring-1 ring-black/5" />
  <UIcon v-else name="i-lucide-globe" :style="{ width: `${size}px`, height: `${size}px` }" class="shrink-0 text-dimmed" />
</template>
