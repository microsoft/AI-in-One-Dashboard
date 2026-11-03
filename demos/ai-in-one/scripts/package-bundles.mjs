import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const repo = dirname(dirname(source))
const release = join(source, 'release')
const digest = (data) => createHash('sha256').update(data).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const skip = new Set(['node_modules', 'dist', 'release', 'test-results', 'playwright-report', '.impeccable'])
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((f) => {
    if (skip.has(f.name) || f.name.endsWith('.tsbuildinfo')) return []
    const path = join(directory, f.name)
    return f.isDirectory() ? files(path) : [path]
  })
}
const manifest = files(source).map((path) => ({
  path: relative(source, path).split(sep).join('/'), sha256: digest(readFileSync(path)),
}))
const layout = JSON.parse(readFileSync(join(source, 'src', 'report', 'layout.json'), 'utf8'))
const dirty = Boolean(git('status', '--porcelain', '--', 'demos/ai-in-one'))
const dependencies = ['react', 'react-dom', 'scheduler', 'papaparse', 'vite']
const notices = dependencies.map((name) => {
  const directory = join(source, 'node_modules', name)
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const licence = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((f) => join(directory, f)).find(existsSync)
  if (!licence) throw new Error(`Missing distribution licence for ${name}`)
  return `${name} ${pkg.version} (${pkg.license})\n${readFileSync(licence, 'utf8')}`
}).join('\n\n----------------------------------------\n\n')
const summary = []
for (const [slug, entry] of [['ai-in-one', 'index.html'], ['ai-in-one-report', 'report.html']]) {
  const destination = join(release, 'demo', slug)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(join(source, 'dist', entry), join(destination, 'index.html'))
  for (const asset of ['assets', 'sample', 'favicon.svg']) cpSync(join(source, 'dist', asset), join(destination, asset), { recursive: true })
  cpSync(join(repo, 'LICENSE.md'), join(destination, 'LICENSE.txt'))
  writeFileSync(join(destination, 'THIRD-PARTY-NOTICES.txt'), notices)
  const provenance = {
    repository: 'https://github.com/microsoft/AI-in-One-Dashboard',
    baseRevision: 'e0a77c2c4cb1f3723c656acfe825fa640c7d31ab',
    baseAppDirectory: 'Archive/app',
    reportTemplate: `templates/${layout.source}`,
    reportTemplateSha256: layout.sha256,
    sourceDirectory: 'demos/ai-in-one',
    buildHead: git('rev-parse', 'HEAD'),
    demoSourceCommit: dirty ? null : git('rev-parse', 'HEAD'),
    sourceStatus: dirty ? 'Uncommitted demo additions and adaptations; the base revision does not contain these demo changes.' : 'Committed source; see demoSourceCommit.',
    sourceTreeSha256: digest(JSON.stringify(manifest)),
    sourceManifest: manifest,
    buildCommand: 'npm ci && npm run package',
    buildWorkingDirectory: 'demos/ai-in-one',
    runtime: { node: process.version, npm: execFileSync(process.execPath, [process.env.npm_execpath, '--version'], { encoding: 'utf8' }).trim(), python: execFileSync('python', ['--version'], { encoding: 'utf8' }).trim() },
    path: `/demo/${slug}/`,
    license: 'MIT; Microsoft Corporation. Runtime dependency notices are included.',
    safety: 'Rule-generated invented data only. Local static assets only. No authentication, upload, backend or administrator operation.',
    limitations: slug.endsWith('-report') ? 'Static browser port, not Power BI: no RLS/disclosure enforcement, licence-history transitions, hierarchical drilldown, admin actions, exports, custom visual runtime or bookmark engine. Original presentation metadata with local calculations; not full DAX parity.' : 'Existing app UI in sample-only mode. Tenant connectors, data upload and deployment are unavailable.',
  }
  writeFileSync(join(destination, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n')
  const artifactFiles = files(destination).map((path) => ({ path: relative(destination, path).split(sep).join('/'), sha256: digest(readFileSync(path)) }))
  summary.push({ slug, files: artifactFiles, sha256: digest(JSON.stringify(artifactFiles)) })
}
writeFileSync(join(release, 'bundles.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(`Packaged ${summary.map((s) => `/demo/${s.slug}/`).join(' and ')} in release/demo/`)
