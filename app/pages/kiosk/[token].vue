<script setup lang="ts">
import type { KioskPayloadT } from '#shared/schemas/automation'

definePageMeta({ layout: 'blank' })
const route = useRoute()
const { t } = useI18n()
const fmt = useFormat()
const { data, error, refresh } = useFetch<KioskPayloadT>(() => `/api/kiosk/${route.params.token}`)
useIntervalFn(() => refresh(), 5 * 60_000)
const now = useClock(1000)
const { request: keepAwake, isSupported } = useWakeLock()
onMounted(() => { if (isSupported.value) keepAwake('screen').catch(() => {}) })
useHead({ title: computed(() => data.value?.title ?? 'Wi-Fi'), meta: [{ name: 'theme-color', content: '#131416' }] })
</script>

<template>
  <div class="fixed inset-0 overflow-hidden flex flex-col items-center justify-center bg-[radial-gradient(ellipse_at_20%_0%,#0b3a7a_0%,#131416_55%),radial-gradient(ellipse_at_100%_100%,#3a1f7a_0%,transparent_50%)] text-white px-6 py-10 select-none">
    <div class="absolute top-6 left-0 right-0 flex justify-between px-8 text-white/60 text-sm">
      <span class="flex items-center gap-2"><AppLogo :size="22" /><span class="font-medium text-white/80">{{ data?.title }}</span></span>
      <span class="uf-num text-lg font-medium text-white/80">{{ fmt.time(now.getTime()) }}</span>
    </div>
    <template v-if="data">
      <div class="p-5 bg-white rounded-[28px] shadow-[0_30px_80px_-20px_rgba(0,111,255,0.55)]">
        <QrCode :value="data.wifiUri" :size="300" />
      </div>
      <p class="mt-6 text-white/60 text-base">{{ t('kiosk.scan') }}</p>
      <div class="mt-8 grid sm:grid-cols-2 gap-6 text-center sm:text-left">
        <div>
          <div class="text-[13px] uppercase tracking-[0.25em] text-white/45">{{ t('kiosk.network') }}</div>
          <div class="text-4xl font-semibold mt-1">{{ data.ssid }}</div>
        </div>
        <div>
          <div class="text-[13px] uppercase tracking-[0.25em] text-white/45">{{ t('kiosk.password') }}</div>
          <div class="text-4xl font-semibold mt-1 uf-mono tracking-wide">{{ data.passphrase }}</div>
        </div>
      </div>
      <p v-if="data.validUntil" class="mt-10 text-white/40 text-sm">{{ t('kiosk.validUntil', { time: fmt.dateTime(data.validUntil) }) }}</p>
    </template>
    <div v-else-if="error" class="text-center">
      <UIcon name="i-lucide-link-2-off" class="size-10 text-white/40" />
      <p class="mt-3 text-white/60">{{ t('kiosk.invalid') }}</p>
    </div>
  </div>
</template>
