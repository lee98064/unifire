import { useDb } from '../db'
import { useDashboard } from '../services/controller-runtime'
import { adminControllerHandler } from '../utils/controller-api'

export default adminControllerHandler(() => useDashboard(useDb()))
