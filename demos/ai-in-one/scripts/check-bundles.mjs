import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const release = join(dirname(dirname(fileURLToPath(import.meta.url))), 'release')
const bundles = JSON.parse(readFileSync(join(release, 'bundles.json'), 'utf8'))
for (const bundle of bundles) {
  const root = join(release, 'demo', bundle.slug)
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  assert(html.includes("connect-src 'self'"), `${bundle.slug}: missing same-origin CSP`)
  for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert(!/^(https?:)?\/\//.test(asset), `${bundle.slug}: external HTML asset`)
    assert(existsSync(join(root, asset)), `${bundle.slug}: missing asset ${asset}`)
  }
  for (const file of bundle.files) {
    const bytes = readFileSync(join(root, file.path))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${bundle.slug}: changed packaged file ${file.path}`)
    assert(!/\.(map|pbit|pbix|ps1)$/.test(file.path), `${bundle.slug}: unintended source/deployment file`)
    if (file.path === 'THIRD-PARTY-NOTICES.txt' || file.path === 'LICENSE.txt') continue
    const text = bytes.toString('utf8')
    assert(!/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text), `${bundle.slug}: unexpected GUID in ${file.path}`)
    assert(!/github_pat_|ghp_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(text), `${bundle.slug}: credential-like content in ${file.path}`)
    assert(!/https?:\/\/(?:login\.microsoftonline|api\.powerbi|api\.fabric\.microsoft|admin\.microsoft|[^/" ]+\.sharepoint)\.com/i.test(text), `${bundle.slug}: live service URL in ${file.path}`)
    const addresses = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? []
    assert(addresses.every((a) => /^person\d+@example\.invalid$/.test(a)), `${bundle.slug}: unexpected non-fixture address in ${file.path}`)
  }
}
console.log('Both bundles have complete local assets, matching hashes and no unexpected identity, credential or live-service patterns.')
