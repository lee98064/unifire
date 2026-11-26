import { useDb } from '../db'
import { topologyDeviceInputs } from '../engine/infra/device-views'
import { buildTopology } from '../engine/infra/topology'
import { clientIdentities } from '../services/client-identity'
import { useController } from '../services/controller-runtime'
import { useInventory } from '../services/inventory-runtime'
import { adminControllerHandler } from '../utils/controller-api'

export default adminControllerHandler(async () => {
  const inventory = await useInventory()
  const service = await useController()
  const db = useDb()
  const at = Date.now()
  const cache = service.runtime?.cache
  const snapshot = cache?.snapshot()
  const activeClients = snapshot?.activeClients ?? []
  const inputs = topologyDeviceInputs(db, service, at)
  return buildTopology({ ...inputs, at, activeClients,
    identity: clientIdentities(db, activeClients, snapshot?.knownClients ?? []),
    egresses: inventory.egresses(),
    gatewayTelemetry: cache?.gateway() ?? snapshot?.devices.find(device => device.mac === inputs.devices.find(row => row.type === 'gateway')?.mac),
  })
})
