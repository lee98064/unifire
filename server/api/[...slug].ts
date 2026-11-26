import { createError, defineEventHandler } from 'h3'

/** Unknown /api/* paths must return JSON 404 instead of falling through to the SPA renderer. */
export default defineEventHandler(() => {
  throw createError({ statusCode: 404, message: 'errors.notFound', data: { code: 'NOT_FOUND' } })
})
