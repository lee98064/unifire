import { eq } from 'drizzle-orm'
import { defineEventHandler, setResponseHeader } from 'h3'
import { SetupStatus } from '#shared/schemas/auth'
import { useDb } from '../../db'
import { controller } from '../../db/schema'
import { createUsersService } from '../../services/users'

export default defineEventHandler(event => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const config = useRuntimeConfig(event)
  const db = useDb()
  const needsAdmin = createUsersService(db).adminCount() === 0
  const mock = config.mockController === true || String(config.mockController) === 'true'
  const needsController = !mock && !db.select({ id: controller.id }).from(controller).where(eq(controller.id, 1)).get()
  return SetupStatus.parse({
    needsAdmin, needsController, ready: !needsAdmin && !needsController, mock, version: config.public.appVersion,
  })
})
