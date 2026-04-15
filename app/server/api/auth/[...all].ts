import { auth } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const webRequest = toWebRequest(event)
  return auth.handler(webRequest)
})
