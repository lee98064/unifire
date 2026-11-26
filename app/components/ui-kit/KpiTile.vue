<script setup lang="ts">
defineProps<{ label: string, value: string | number, icon?: string, hint?: string, tone?: 'primary' | 'success' | 'warning' | 'error' | 'vpn' | 'neutral', to?: string }>()
</script>

<template>
  <component :is="to ? resolveComponent('NuxtLink') : 'div'" :to="to" class="uf-card uf-card-hover p-4 flex flex-col gap-3 min-w-0">
    <div class="flex items-center justify-between gap-2">
      <span class="text-[12.5px] font-medium text-muted truncate">{{ label }}</span>
      <span
        v-if="icon"
        class="size-7 rounded-md flex items-center justify-center shrink-0"
        :class="{
          'bg-primary/10 text-primary': !tone || tone === 'primary',
          'bg-success/10 text-success': tone === 'success',
          'bg-warning/10 text-warning': tone === 'warning',
          'bg-error/10 text-error': tone === 'error',
          'bg-vpn/10 text-vpn': tone === 'vpn',
          'bg-(--uf-hover) text-toned': tone === 'neutral',
        }"
      ><UIcon :name="icon" class="size-4" /></span>
    </div>
    <div class="flex items-end justify-between gap-2">
      <span class="text-[26px] leading-none font-semibold tracking-tight text-highlighted uf-num">{{ value }}</span>
      <slot />
    </div>
    <span v-if="hint" class="text-[12px] text-dimmed -mt-1 truncate">{{ hint }}</span>
  </component>
</template>
