import ConfirmModal from '~/components/app/ConfirmModal.vue'

/** Promise-based confirmation dialog: `if (await confirm({ title })) …` */
export function useConfirm() {
  const overlay = useOverlay()
  return async (opts: { title: string, description?: string, confirmLabel?: string, color?: 'primary' | 'error' | 'warning', icon?: string }): Promise<boolean> => {
    const modal = overlay.create(ConfirmModal, { props: opts, destroyOnClose: true })
    const result = await modal.open()
    return result === true
  }
}
