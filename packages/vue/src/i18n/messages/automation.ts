import { params } from '@nanostores/i18n'

import { i18n } from '#vue/i18n/create'

export const automationMessageDefaults = {
  localServer: 'Local server',
  webmcpDescription:
    'Let browser agents use this document directly, without a local MCP server or bearer token. Local server settings do not apply here.',
  browserAccess: 'Browser agent access',
  accessOff: 'Off',
  accessInspect: 'Inspect',
  accessEdit: 'Edit',
  accessOffDescription: 'No tools are exposed to browser agents.',
  accessInspectDescription: 'Agents can inspect the document but cannot change it.',
  accessEditDescription:
    'Agents can also edit existing properties, text, and variable values. Edits are undoable; creating or deleting content, scripts, and file access are excluded.',
  webmcpUnsupported:
    'This browser does not expose WebMCP. Use a supported Chrome version and enable WebMCP testing, then relaunch the browser.',
  webmcpSetup: 'WebMCP setup guide',
  noMatchingTools: 'No tools match your search.',
  connections: 'MCP connections',
  connectionsDescription: 'Connect AI agents to trusted remote tools and services.',
  addConnection: 'Add connection',
  addServerConnection: 'Add MCP connection',
  editConnection: 'Edit MCP connection',
  connectionEditorDescription:
    'Configure an HTTP or stdio MCP server with optional headers and environment variables.',
  connectionName: 'Connection name',
  connectionNameHint: 'Use a unique name of up to 80 characters.',
  connectionNameInvalid: 'Use a name of up to 80 characters, without slashes.',
  duplicateConnectionName: 'Choose a unique connection name.',
  serverURLHint:
    'Use HTTPS. HTTP is allowed only for localhost or a loopback address. Do not include credentials in the URL.',
  serverURL: 'MCP server URL',
  enableConnection: 'Enable for AI agents',
  transportHttp: 'HTTP',
  transportStdio: 'stdio',
  headersTitle: 'HTTP headers',
  addHeader: 'Add header',
  headerKeyPlaceholder: 'Header name',
  headerValuePlaceholder: 'Header value',
  headersEmpty: 'No headers.',
  savedHeadersHint:
    'Saved header values are never shown. Save with the rows left blank to keep them; entering any new row replaces all saved headers.',
  commandLabel: 'Command',
  commandHint: 'Run a local program. Only use commands from sources you trust.',
  commandInvalid: 'Enter a command without shell metacharacters (; & | ` $ < > ( ) { } \\).',
  argsLabel: 'Arguments',
  argsHint: 'Space-separated arguments, up to 64 in total.',
  argsInvalid: 'Too many arguments or invalid spacing.',
  envTitle: 'Environment variables',
  addEnv: 'Add variable',
  envKeyPlaceholder: 'Variable name',
  envValuePlaceholder: 'Variable value',
  envEmpty: 'No environment variables.',
  savedEnvHint:
    'Saved variable values are never shown. Save with the rows left blank to keep them; entering any new row replaces all saved variables.',
  stdioLocalProcessHint: 'This connection starts a local subprocess when used by an AI agent.',
  statusUntested: 'Not tested yet',
  statusConnected: 'Connected · {count} tools available',
  statusFailed: 'Failed to connect',
  bearerAuthentication: 'Use bearer authentication',
  bearerToken: 'Bearer token',
  bearerTokenPlaceholder: 'Enter bearer token',
  bearerTokenRequired: 'Enter a bearer token before enabling this connection.',
  deleteConnection: 'Delete connection',
  deleteConnectionDescription: 'Delete this MCP connection and its saved credentials?',
  noConnections: 'No external MCP connections configured.',
  description: 'Monitor and restart the local MCP server used by agents and automation.',
  status: 'Status',
  port: 'Port',
  address: 'Address',
  version: 'Version',
  authentication: 'Require authentication',
  authenticationDescription:
    'Protect the localhost MCP endpoint with a bearer token. Disable only on a trusted machine. Restart the server to apply changes.',
  rootDirectory: 'MCP root directory',
  rootDirectoryDefault: 'Server default directory',
  chooseRootDirectory: 'Choose folder',
  useDefaultRoot: 'Use default',
  rootDirectoryDescription:
    'File tools are limited to this folder. Restart the MCP server to apply changes.',
  tools: 'Available tools',
  toolsEnabled: params('{enabled} of {total} enabled'),
  enableAllTools: 'Enable all',
  searchTools: 'Search MCP tools',
  readOnlyTools: 'Read-only tools',
  sideEffectTools: 'Tools with side effects',
  toolsRestartNotice:
    'Restart the MCP server, then reconnect stdio clients, to apply tool availability changes.',
  externalRestartNotice:
    'This server is managed by another process. Restart that process to apply changes.',
  restart: 'Restart MCP server',
  externallyManaged: 'Managed externally',
  starting: 'Starting…',
  statusIdle: 'Not initialized',
  statusStarting: 'Starting',
  statusRunning: 'Running',
  statusStopped: 'Stopped',
  statusError: 'Error'
} as const

export const automationMessages = i18n('automation', automationMessageDefaults)
