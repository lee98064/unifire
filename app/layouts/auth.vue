<template>
  <div class="relative min-h-dvh flex flex-col items-center justify-center px-4 py-10 overflow-hidden">
    <!-- Ambient backdrop: soft grid + UniFi blue glow -->
    <div class="absolute inset-0 uf-grid-bg opacity-60 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
    <div class="absolute -top-40 left-1/2 -translate-x-1/2 w-[720px] h-[420px] rounded-full bg-primary/20 blur-[120px]" />
    <div class="absolute -bottom-48 right-[-120px] w-[480px] h-[360px] rounded-full bg-vpn/15 blur-[120px]" />
    <div class="relative w-full flex flex-col items-center">
      <slot />
    </div>
  </div>
</template>
