import { getAuth } from '../../utils/auth'
import { toWebRequest } from 'better-auth/node'

export default defineEventHandler(async (event) => {
  const auth = getAuth()
  const webRequest = toWebRequest(event.node.req)
  return auth.handler(webRequest)
})
