import { z } from 'zod'
import { Id } from '#shared/schemas/common'
import { SnapshotResource } from '#shared/schemas/insight'
import { useSnapshots } from '../../../../../services/controller-runtime'
import { readApiParams } from '../../../../../utils/api-error'
import { adminControllerHandler } from '../../../../../utils/controller-api'

export default adminControllerHandler(async event => {
  const { id, resource, itemId } = await readApiParams(event, z.object({ id: Id, resource: SnapshotResource, itemId: Id }))
  return (await useSnapshots()).item(id, resource, itemId)
})
