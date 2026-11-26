<script setup lang="ts">
const props = withDefaults(defineProps<{ avatar: string, color: string, size?: number, home?: boolean | null, ring?: boolean }>(), { size: 36, home: null, ring: false })
const isEmoji = computed(() => /\p{Extended_Pictographic}/u.test(props.avatar))
</script>

<template>
  <span class="relative inline-flex shrink-0" :style="{ width: `${size}px`, height: `${size}px` }">
    <span
      class="flex items-center justify-center rounded-full size-full font-semibold select-none"
      :class="ring ? 'ring-2 ring-offset-2 ring-offset-(--uf-surface)' : ''"
      :style="{
        background: isEmoji ? `color-mix(in oklab, ${color} 18%, var(--uf-surface))` : color,
        color: isEmoji ? undefined : '#fff',
        fontSize: `${size * (isEmoji ? 0.52 : 0.4)}px`,
        '--tw-ring-color': color,
      }"
    >{{ avatar }}</span>
    <span
      v-if="home !== null"
      class="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-(--uf-surface)"
      :class="home ? 'bg-success' : 'bg-(--color-ufgray-400)'"
      :style="{ width: `${Math.max(8, size * 0.28)}px`, height: `${Math.max(8, size * 0.28)}px` }"
    />
  </span>
</template>
