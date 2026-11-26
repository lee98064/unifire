<script setup lang="ts">
import type { GuestWifiT, WlanT } from '#shared/schemas/automation'

const { t } = useI18n()
const fmt = useFormat()
const api = useApi()
const confirm = useConfirm()
const { data: gw, refresh } = useFetch<GuestWifiT>('/api/guest-wifi', { key: 'guest-wifi' })
const { data: wlans } = useFetch<WlanT[]>('/api/wlans', { key: 'wlans', default: () => [] })
const showPw = ref(false)
const { copy, copied } = useClipboard()

const form = reactive({ wlanId: null as string | null, enabled: false, cron: '0 4 * * 1', timezone: 'Asia/Taipei', style: 'words' as 'words' | 'digits' | 'random', length: 12 })
watch(gw, (v) => { if (v) Object.assign(form, { wlanId: v.wlanId, enabled: v.enabled, ...v.rotation }) }, { immediate: true })
const presets = [
  { cron: '0 4 * * *', key: 'daily' },
  { cron: '0 4 * * 1', key: 'weekly' },
  { cron: '0 4 1 * *', key: 'monthly' },
]
async function save() {
  gw.value = await api.put<GuestWifiT>('/api/guest-wifi', { wlanId: form.wlanId, enabled: form.enabled, rotation: { cron: form.cron, timezone: form.timezone, style: form.style, length: form.length } }, { success: t('common.saved') })
}
const rotating = ref(false)
async function rotate() {
  if (!(await confirm({ title: t('guestWifi.rotateConfirm'), color: 'warning' })) return
  rotating.value = true
  try { gw.value = await api.post<GuestWifiT>('/api/guest-wifi/rotate', undefined, { success: t('guestWifi.rotated') }) }
  finally { rotating.value = false }
}
async function resetToken() {
  if (!(await confirm({ title: t('guestWifi.resetTokenConfirm'), color: 'warning' })) return
  gw.value = await api.post<GuestWifiT>('/api/guest-wifi/kiosk-token', undefined, { success: t('guestWifi.tokenReset') })
}
const wifiUri = computed(() => gw.value?.ssid && gw.value.passphrase ? `WIFI:T:WPA;S:${gw.value.ssid.replace(/([\;,:"])/g, '\\$1')};P:${gw.value.passphrase.replace(/([\;,:"])/g, '\\$1')};;` : '')
const kioskHref = computed(() => gw.value?.kioskUrl ?? (gw.value?.kioskToken ? `${location.origin}/kiosk/${gw.value.kioskToken}` : null))
</script>

<template>
  <div>
    <PageHeader :title="t('nav.guestWifi')" :description="t('guestWifi.desc')" icon="i-lucide-qr-code" />

    <div class="grid lg:grid-cols-[1fr_380px] gap-5 items-start">
      <UCard>
        <div class="space-y-5">
          <UFormField :label="t('guestWifi.ssid')" :description="t('guestWifi.ssidHint')">
            <USelectMenu v-model="form.wlanId" :items="wlans.map(w => ({ label: w.name, value: w.id, description: `${w.security}${w.isGuest ? ` · ${t('guestWifi.guestNet')}` : ''}`, icon: w.enabled ? 'i-lucide-wifi' : 'i-lucide-wifi-off' }))" value-key="value" class="w-full" />
          </UFormField>
          <div class="flex items-center justify-between">
            <div>
              <div class="text-[13.5px] font-medium text-highlighted">{{ t('guestWifi.autoRotate') }}</div>
              <div class="text-[12.5px] text-muted">{{ t('guestWifi.autoRotateHint') }}</div>
            </div>
            <USwitch v-model="form.enabled" />
          </div>
          <div :class="form.enabled ? '' : 'opacity-50 pointer-events-none'" class="space-y-4 transition-opacity">
            <UFormField :label="t('guestWifi.when')">
              <div class="flex flex-wrap gap-1.5 mb-2">
                <button v-for="p in presets" :key="p.cron" type="button" class="h-8 px-3 rounded-full text-[12.5px] ring-1 transition" :class="form.cron === p.cron ? 'bg-primary/10 text-primary ring-primary/30' : 'ring-(--ui-border-muted) text-toned'" @click="form.cron = p.cron">{{ t(`guestWifi.preset.${p.key}`) }}</button>
              </div>
              <UInput v-model="form.cron" class="w-full uf-mono" />
            </UFormField>
            <div class="grid grid-cols-2 gap-3">
              <UFormField :label="t('guestWifi.style')">
                <USelect v-model="form.style" :items="(['words', 'digits', 'random'] as const).map(s => ({ value: s, label: t(`guestWifi.styles.${s}`) }))" class="w-full" />
              </UFormField>
              <UFormField :label="t('guestWifi.length')"><UInputNumber v-model="form.length" :min="8" :max="63" class="w-full" /></UFormField>
            </div>
            <p class="text-[12px] text-dimmed">{{ t(`guestWifi.styleHint.${form.style}`) }}</p>
          </div>
          <div class="flex justify-end gap-2">
            <UButton color="warning" variant="soft" icon="i-lucide-refresh-cw" :loading="rotating" :disabled="!gw?.wlanId" @click="rotate">{{ t('guestWifi.rotateNow') }}</UButton>
            <UButton icon="i-lucide-save" @click="save">{{ t('common.save') }}</UButton>
          </div>
        </div>
      </UCard>

      <!-- Kiosk preview -->
      <div class="rounded-2xl overflow-hidden ring-1 ring-(--ui-border) shadow-(--uf-shadow-lg) bg-[radial-gradient(circle_at_30%_0%,#0b3a7a_0%,#131416_60%)] text-white p-6">
        <div class="flex items-center gap-2 text-[12px] text-white/60 mb-5"><UIcon name="i-lucide-tablet-smartphone" class="size-4" />{{ t('guestWifi.kioskPreview') }}</div>
        <div v-if="gw?.ssid" class="flex flex-col items-center text-center">
          <div class="p-3 bg-white rounded-2xl"><QrCode :value="wifiUri" :size="180" /></div>
          <div class="mt-5 text-[12px] uppercase tracking-[0.2em] text-white/50">Wi-Fi</div>
          <div class="text-2xl font-semibold">{{ gw.ssid }}</div>
          <button type="button" class="mt-3 flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 transition" @click="showPw = !showPw">
            <span class="uf-mono text-lg tracking-wider">{{ showPw ? gw.passphrase : '•'.repeat(Math.min(14, gw.passphrase?.length ?? 10)) }}</span>
            <UIcon :name="showPw ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="size-4 text-white/60" />
          </button>
          <div class="mt-4 text-[12px] text-white/50">{{ t('guestWifi.lastRotated') }} {{ fmt.dateTime(gw.lastRotatedAt) }}<template v-if="gw.nextRotationAt"> · {{ t('guestWifi.next') }} {{ fmt.dateTime(gw.nextRotationAt) }}</template></div>
        </div>
        <div v-else class="text-center text-white/60 py-12 text-[13px]">{{ t('guestWifi.pickFirst') }}</div>

        <div v-if="kioskHref" class="mt-6 pt-4 border-t border-white/10 space-y-2">
          <div class="text-[12px] text-white/60">{{ t('guestWifi.kioskUrl') }}</div>
          <div class="flex gap-2">
            <code class="flex-1 truncate text-[12px] bg-black/30 rounded-md px-2.5 py-1.5">{{ kioskHref }}</code>
            <UButton size="xs" color="neutral" variant="solid" :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" @click="copy(kioskHref!)" />
            <UButton size="xs" color="neutral" variant="solid" icon="i-lucide-external-link" :to="kioskHref!" target="_blank" />
          </div>
          <button type="button" class="text-[11.5px] text-white/50 hover:text-white underline-offset-2 hover:underline" @click="resetToken">{{ t('guestWifi.resetToken') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
