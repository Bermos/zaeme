export default defineNitroPlugin(async () => {
  // Mark the server as initialized once db is available
  // The actual admin check happens per-request in middleware
})
