<script setup lang="ts">
const props = defineProps<{ title: string, description?: string, confirmLabel?: string, color?: 'primary' | 'error' | 'warning', icon?: string }>()
const emit = defineEmits<{ close: [ok: boolean] }>()
const { t } = useI18n()
</script>

<template>
  <UModal :close="false" :dismissible="true" :ui="{ content: 'sm:max-w-md' }" @update:open="v => { if (!v) emit('close', false) }">
    <template #content>
      <div class="p-6">
        <div class="flex gap-4">
          <span class="size-10 rounded-full flex items-center justify-center shrink-0" :class="props.color === 'error' ? 'bg-error/12 text-error' : props.color === 'warning' ? 'bg-warning/12 text-warning' : 'bg-primary/12 text-primary'">
            <UIcon :name="props.icon ?? (props.color === 'error' ? 'i-lucide-trash-2' : 'i-lucide-circle-help')" class="size-5" />
          </span>
          <div class="min-w-0">
            <h3 class="text-[15px] font-semibold text-highlighted">{{ props.title }}</h3>
            <p v-if="props.description" class="mt-1.5 text-[13px] text-muted">{{ props.description }}</p>
          </div>
        </div>
        <div class="mt-6 flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="emit('close', false)">{{ t('common.cancel') }}</UButton>
          <UButton :color="props.color ?? 'primary'" autofocus @click="emit('close', true)">{{ props.confirmLabel ?? t('common.confirm') }}</UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
