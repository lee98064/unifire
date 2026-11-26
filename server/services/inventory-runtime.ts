import { useDb } from '../db'
import { useController } from './controller-runtime'
import { createInventory } from './inventory'

export async function useInventory() {
  const service = await useController()
  await service.ready()
  return createInventory(useDb(), service)
}
