<script setup lang="ts">
const { t, locale, locales, setLocale } = useI18n()
const api = useApi()
const toast = useToast()
const colorMode = useColorMode()
const { register } = useWebAuthn({ registerEndpoint: '/api/auth/webauthn/register' })
const { user } = useUserSession()
const pw = reactive({ currentPassword: '', newPassword: '', confirm: '' })
async function changePw() {
  await api.post('/api/auth/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword }, { success: t('settings.account.pwChanged') })
  Object.assign(pw, { currentPassword: '', newPassword: '', confirm: '' })
}
const registering = ref(false)
async function addPasskey() {
  registering.value = true
  try {
    await register({ userName: user.value?.username ?? '', displayName: user.value?.displayName })
    toast.add({ title: t('settings.account.passkeyAdded'), color: 'success', icon: 'i-lucide-fingerprint' })
  }
  catch { toast.add({ title: t('settings.account.passkeyFailed'), color: 'error' }) }
  finally { registering.value = false }
}
</script>

<template>
  <div class="space-y-5">
    <div class="uf-card p-5 grid sm:grid-cols-2 gap-5">
      <div>
        <h3 class="text-[14px] font-semibold text-highlighted mb-3">{{ t('topbar.theme') }}</h3>
        <div class="grid grid-cols-3 gap-2">
          <button v-for="m in (['light', 'dark', 'system'] as const)" :key="m" type="button" class="p-3 rounded-lg ring-1 flex flex-col items-center gap-1.5 text-[12.5px] transition" :class="colorMode.preference === m ? 'ring-2 ring-primary text-primary' : 'ring-(--ui-border-muted) text-toned hover:ring-(--ui-border-accented)'" @click="colorMode.preference = m">
            <UIcon :name="m === 'light' ? 'i-lucide-sun' : m === 'dark' ? 'i-lucide-moon' : 'i-lucide-monitor'" class="size-5" />{{ t(`topbar.theme${m[0]!.toUpperCase()}${m.slice(1)}`) }}
          </button>
        </div>
      </div>
      <div>
        <h3 class="text-[14px] font-semibold text-highlighted mb-3">{{ t('topbar.language') }}</h3>
        <div class="grid grid-cols-2 gap-2">
          <button v-for="l in locales" :key="l.code" type="button" class="p-3 rounded-lg ring-1 text-[13px] font-medium transition" :class="locale === l.code ? 'ring-2 ring-primary text-primary' : 'ring-(--ui-border-muted) text-toned hover:ring-(--ui-border-accented)'" @click="setLocale(l.code)">{{ l.name }}</button>
        </div>
      </div>
    </div>

    <div class="uf-card p-5">
      <h3 class="text-[14px] font-semibold text-highlighted mb-1">{{ t('settings.account.passkeys') }}</h3>
      <p class="text-[12.5px] text-muted mb-4">{{ t('settings.account.passkeysDesc') }}</p>
      <UButton icon="i-lucide-fingerprint" color="neutral" variant="outline" :loading="registering" @click="addPasskey">{{ t('settings.account.addPasskey') }}</UButton>
    </div>

    <div class="uf-card p-5">
      <h3 class="text-[14px] font-semibold text-highlighted mb-4">{{ t('settings.account.changePw') }}</h3>
      <form class="grid sm:grid-cols-3 gap-3 items-end" @submit.prevent="changePw">
        <UFormField :label="t('settings.account.currentPw')"><UInput v-model="pw.currentPassword" type="password" class="w-full" autocomplete="current-password" /></UFormField>
        <UFormField :label="t('settings.account.newPw')"><UInput v-model="pw.newPassword" type="password" class="w-full" autocomplete="new-password" /></UFormField>
        <UFormField :label="t('setup.admin.confirm')" :error="pw.confirm && pw.confirm !== pw.newPassword ? t('setup.admin.mismatch') : undefined"><UInput v-model="pw.confirm" type="password" class="w-full" autocomplete="new-password" /></UFormField>
        <div class="sm:col-span-3 flex justify-end"><UButton type="submit" icon="i-lucide-key-round" :disabled="!pw.currentPassword || pw.newPassword.length < 8 || pw.newPassword !== pw.confirm">{{ t('settings.account.changePw') }}</UButton></div>
      </form>
    </div>
  </div>
</template>
