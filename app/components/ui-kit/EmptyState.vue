<script setup lang="ts">
defineProps<{ icon?: string, title: string, description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center text-center py-12 px-6">
    <div class="relative mb-4">
      <div class="absolute inset-0 rounded-2xl bg-primary/15 blur-xl" />
      <div class="relative size-14 rounded-2xl bg-(--uf-surface) ring-1 ring-(--ui-border) flex items-center justify-center text-primary shadow-(--uf-shadow)">
        <UIcon :name="icon ?? 'i-lucide-sparkles'" class="size-6" />
      </div>
    </div>
    <h3 class="text-[15px] font-semibold text-highlighted">{{ title }}</h3>
    <p v-if="description" class="mt-1.5 text-[13px] text-muted max-w-sm">{{ description }}</p>
    <div v-if="$slots.default" class="mt-5 flex gap-2"><slot /></div>
  </div>
</template>
