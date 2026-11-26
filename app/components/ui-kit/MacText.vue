<script setup lang="ts">
const props = defineProps<{ value: string | null | undefined, copy?: boolean }>()
const { copy: doCopy, copied } = useClipboard()
const { t } = useI18n()
</script>

<template>
  <span class="inline-flex items-center gap-1 uf-mono text-toned">
    <span>{{ value ?? '—' }}</span>
    <UTooltip v-if="copy && value" :text="copied ? t('common.copied') : t('common.copy')">
      <button class="text-dimmed hover:text-highlighted transition" :aria-label="t('common.copy')" @click.stop="doCopy(props.value!)">
        <UIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3" />
      </button>
    </UTooltip>
  </span>
</template>
