import { useAccess } from '../../services/controller-runtime'
import { adminControllerHandler } from '../../utils/controller-api'

export default adminControllerHandler(async () => {
  const access = await useAccess()
  const statuses = access.quotaStatuses()
  return access.quotas.list().map(quota => ({ ...quota, statuses: statuses
    .filter(row => row.quota.id === quota.id)
    .map(row => ({ ...row.status, personId: row.personId })) }))
})
