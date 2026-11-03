import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
  env: { ...process.env, DEMO_PACKAGED: '1' }, stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
