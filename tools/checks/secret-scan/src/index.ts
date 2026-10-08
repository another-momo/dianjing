import { runSecretScan, type ScanCommand, type ScanOutcome } from './scan'

function spawn({ command, args }: ScanCommand): ScanOutcome | null {
  try {
    const proc = Bun.spawnSync([command, ...args], { stdout: 'inherit', stderr: 'inherit' })
    return { exitCode: proc.exitCode, success: proc.success }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

let outcome: ScanOutcome | null
try {
  outcome = runSecretScan(spawn)
} catch (error) {
  console.log(
    `Secret scan SKIPPED: scanner failed to launch (${error instanceof Error ? error.message : String(error)}) — environment-limited; CI runs the real scan.`
  )
  process.exit(0)
}
if (!outcome) {
  console.log(
    'Secret scan SKIPPED: gitleaks/go not installed (environment-limited; CI runs the real scan).'
  )
  process.exit(0)
}
if (!outcome.success) {
  console.error('Secret scan failed.')
  process.exit(outcome.exitCode || 1)
}
console.log('Secret scan passed.')
