import { get } from '../_utils/ajax'
import { basename } from './utils'

export function getLists (instanceName, accessToken) {
  let url = `${basename(instanceName)}/api/v1/lists`
  return get(url, {
    'Authorization': `Bearer ${accessToken}`
  })
}