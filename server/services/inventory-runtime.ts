import { useDb } from '../db'
import { useAccess, useController, useRouting } from './controller-runtime'
import { createInventory } from './inventory'

export async function useInventory() {
  const service = await useController()
  await service.ready()
  return createInventory(useDb(), service, await useRouting(), await useAccess())
}
