<script setup lang="ts">
/** Chip row for quick durations (minutes). `null` option = indefinitely. */
const props = withDefaults(defineProps<{ options?: (number | null)[] }>(), { options: () => [15, 30, 60, 120, 240, 480] })
const model = defineModel<number | null>()
const fmt = useFormat()
const { t } = useI18n()
</script>

<template>
  <div class="flex flex-wrap gap-1.5">
    <button
      v-for="o in props.options"
      :key="String(o)"
      type="button"
      class="h-8 px-3 rounded-full text-[13px] font-medium ring-1 transition"
      :class="model === o ? 'bg-primary text-white ring-primary' : 'bg-(--uf-surface-2) ring-(--ui-border-muted) text-toned hover:ring-(--ui-border-accented)'"
      @click="model = o"
    >{{ o === null ? t('common.indefinitely') : fmt.minutes(o) }}</button>
  </div>
</template>
