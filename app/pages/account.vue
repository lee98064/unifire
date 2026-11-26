<script setup lang="ts">
const { user } = useUserSession()
setPageLayout(user.value?.role === 'member' ? 'member' : 'default')
const { t } = useI18n()
</script>

<template>
  <div>
    <PageHeader :title="t('topbar.account')" icon="i-lucide-user-round-cog" />
    <AccountSettings />
  </div>
</template>
