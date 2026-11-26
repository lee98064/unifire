import { defineEventHandler, setResponseHeader } from 'h3'
import { SetupStatus } from '#shared/schemas/auth'
import { useDb } from '../../db'
import { savedController } from '../../services/controller'
import { createUsersService } from '../../services/users'

export default defineEventHandler(event => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const config = useRuntimeConfig(event)
  const db = useDb()
  const needsAdmin = createUsersService(db).adminCount() === 0
  const mock = config.mockController === true || String(config.mockController) === 'true'
  const needsController = !mock && !savedController(db)
  return SetupStatus.parse({
    needsAdmin, needsController, ready: !needsAdmin && !needsController, mock, version: config.public.appVersion,
  })
})
