<script setup lang="ts">
withDefaults(defineProps<{ size?: number, wordmark?: boolean }>(), { size: 28, wordmark: false })
// Unique gradient ids per instance: a hidden (display:none) logo elsewhere must not own the <defs>.
const uid = useId()
</script>

<template>
  <div class="flex items-center gap-2.5 select-none">
    <svg :width="size" :height="size" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient :id="`${uid}-g`" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop stop-color="#4797FF" />
          <stop offset="1" stop-color="#0047A3" />
        </linearGradient>
        <linearGradient :id="`${uid}-s`" x1="16" y1="6" x2="16" y2="26" gradientUnits="userSpaceOnUse">
          <stop stop-color="#FFFFFF" />
          <stop offset="1" stop-color="#D6E7FF" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" :fill="`url(#${uid}-g)`" />
      <!-- U-shaped route with a flame tip: "UniFi + fire" -->
      <path d="M10 9v7.5a6 6 0 0 0 12 0V12" :stroke="`url(#${uid}-s)`" stroke-width="2.6" stroke-linecap="round" />
      <path d="M22 5.5c1.9 1.6 2.9 3.2 2.9 4.8a2.9 2.9 0 0 1-5.8 0c0-1 .4-1.8 1.1-2.6.2 1 .8 1.5 1.4 1.5-.1-1.2.1-2.4.4-3.7Z" fill="#FFB547" />
      <circle cx="10" cy="9" r="2.1" fill="#fff" />
    </svg>
    <span v-if="wordmark" class="text-[15px] font-semibold tracking-tight text-highlighted">Unifire</span>
  </div>
</template>
