import { describe, expect, test } from 'bun:test'

import { createAutomationEnvironment } from '@/app/bridge/vite-plugin'

describe('automation bridge Vite development server', () => {
  test('passes the dev auth token and runtime paths to the bridge child', () => {
    const env = createAutomationEnvironment({
      authToken: 'development-token',
      baseEnv: { DIANJING_MCP_AUTH_TOKEN: 'inherited-token' },
      corsOrigin: 'http://localhost:1420',
      discoveryPath: '/tmp/mcp.json',
      httpPort: 7600,
      socketPath: '/tmp/dianjing.sock'
    })

    expect(env.DIANJING_MCP_AUTH_TOKEN).toBe('development-token')
    expect(env.DIANJING_MCP_DISCOVERY_PATH).toBe('/tmp/mcp.json')
    expect(env.DIANJING_MCP_SOCKET).toBe('/tmp/dianjing.sock')
    expect(env.DIANJING_MCP_CORS_ORIGIN).toBe('http://localhost:1420')
    expect(env.PORT).toBe('7600')
  })

  test('null auth token disables bridge auth explicitly', () => {
    const env = createAutomationEnvironment({
      authToken: null,
      baseEnv: { DIANJING_MCP_AUTH_TOKEN: 'inherited-token' },
      corsOrigin: 'http://localhost:1420',
      discoveryPath: null,
      httpPort: 7600,
      socketPath: null
    })

    expect(env.DIANJING_MCP_AUTH_TOKEN).toBe('')
    expect(env.DIANJING_MCP_DISCOVERY_PATH).toBeUndefined()
    expect(env.DIANJING_MCP_SOCKET).toBeUndefined()
  })
})
