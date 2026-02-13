import app from './index.js'

const PORT = process.env.PORT || 3001

app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`)
  console.log('[Server] Available endpoints:')
  console.log('  - POST /api/generate - Generate AI image')
  console.log('  - GET /healthz - Health check')
})
