<script setup lang="ts">
defineProps<{ title: string, description?: string, icon?: string }>()
</script>

<template>
  <div class="flex flex-col sm:flex-row sm:items-end gap-3 sm:gap-4 mb-5 sm:mb-6">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2.5">
        <span v-if="icon" class="hidden sm:flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
          <UIcon :name="icon" class="size-[18px]" />
        </span>
        <h1 class="text-xl sm:text-[22px] font-semibold tracking-tight text-highlighted truncate">{{ title }}</h1>
        <slot name="badge" />
      </div>
      <p v-if="description" class="mt-1 text-[13px] text-muted max-w-3xl">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="flex items-center gap-2 flex-wrap">
      <slot name="actions" />
    </div>
  </div>
</template>
