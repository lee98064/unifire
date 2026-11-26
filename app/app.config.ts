export default defineAppConfig({
  ui: {
    colors: {
      primary: 'unifi',
      secondary: 'ufpurple',
      info: 'unifi',
      success: 'ufgreen',
      warning: 'ufamber',
      error: 'ufred',
      neutral: 'ufgray',
      vpn: 'ufpurple',
    },
    button: {
      slots: { base: 'font-medium transition-colors duration-150' },
      defaultVariants: { size: 'md' },
      // UniFi uses white labels on solid buttons in both themes.
      compoundVariants: (['primary', 'secondary', 'success', 'error', 'warning', 'info', 'vpn'] as const).map(color => ({ color, variant: 'solid' as const, class: 'text-white' })),
    },
    card: {
      slots: {
        root: 'rounded-[10px] bg-(--uf-surface) ring-1 ring-(--ui-border-muted) shadow-(--uf-shadow)',
        header: 'px-4 py-3 sm:px-5',
        body: 'p-4 sm:p-5',
        footer: 'px-4 py-3 sm:px-5',
      },
    },
    badge: {
      slots: { base: 'font-medium' },
      compoundVariants: (['primary', 'secondary', 'success', 'error', 'warning', 'info', 'vpn'] as const).map(color => ({ color, variant: 'solid' as const, class: 'text-white' })),
    },
    table: {
      slots: {
        th: 'text-[11px] font-semibold uppercase tracking-wide text-dimmed py-2.5',
        td: 'py-2.5 text-sm',
        tr: 'transition-colors',
      },
    },
    tooltip: {
      slots: { content: 'text-xs' },
    },
    modal: {
      slots: { content: 'bg-(--uf-surface) ring-(--ui-border-muted)' },
    },
    slideover: {
      slots: { content: 'bg-(--uf-surface) ring-(--ui-border-muted)' },
    },
  },
})
