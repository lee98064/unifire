import type { FetchError } from 'ofetch'
import type { ApiErrorT } from '#shared/schemas/common'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Extract a readable message + code from an API error. */
export function apiErrorInfo(err: unknown): { message: string, code?: string, status?: number } {
  const e = err as FetchError<Partial<ApiErrorT> & { data?: { code?: string } }>
  const data = e?.data
  return {
    message: data?.message || e?.statusMessage || e?.message || 'Unknown error',
    code: data?.code || data?.data?.code,
    status: e?.statusCode ?? e?.status,
  }
}

/**
 * Thin typed wrapper around $fetch for mutations.
 * Shows an error toast automatically (unless `silent`), returns the parsed body.
 */
export function useApi() {
  const toast = useToast()
  const { t, te } = useI18n()

  async function call<T>(method: Method, url: string, body?: unknown, opts: { silent?: boolean, success?: string } = {}): Promise<T> {
    try {
      const res = await $fetch<T>(url, { method, body: body as Record<string, unknown> | undefined })
      if (opts.success) toast.add({ title: opts.success, color: 'success', icon: 'i-lucide-check-circle-2' })
      return res
    }
    catch (err) {
      const info = apiErrorInfo(err)
      if (info.status === 401 && import.meta.client) {
        await navigateTo('/login')
      }
      if (!opts.silent) {
        const codeKey = info.code ? `errors.${info.code}` : ''
        toast.add({
          title: codeKey && te(codeKey) ? t(codeKey) : t('errors.generic'),
          description: info.message,
          color: 'error',
          icon: 'i-lucide-circle-alert',
        })
      }
      throw err
    }
  }

  return {
    get: <T>(url: string, opts?: { silent?: boolean }) => call<T>('GET', url, undefined, opts),
    post: <T>(url: string, body?: unknown, opts?: { silent?: boolean, success?: string }) => call<T>('POST', url, body, opts),
    put: <T>(url: string, body?: unknown, opts?: { silent?: boolean, success?: string }) => call<T>('PUT', url, body, opts),
    patch: <T>(url: string, body?: unknown, opts?: { silent?: boolean, success?: string }) => call<T>('PATCH', url, body, opts),
    del: <T>(url: string, body?: unknown, opts?: { silent?: boolean, success?: string }) => call<T>('DELETE', url, body, opts),
  }
}
