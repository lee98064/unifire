<script setup lang="ts">
import QRCode from 'qrcode'

const props = withDefaults(defineProps<{ value: string, size?: number, dark?: string, light?: string }>(), { size: 220, dark: '#131416', light: '#ffffff' })
const svg = ref('')
watchEffect(async () => {
  if (!props.value) { svg.value = ''; return }
  svg.value = await QRCode.toString(props.value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: props.dark, light: props.light } })
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="[&>svg]:w-full [&>svg]:h-full rounded-xl overflow-hidden" :style="{ width: `${size}px`, height: `${size}px` }" v-html="svg" />
</template>
