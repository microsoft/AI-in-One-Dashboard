import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'release')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain' }
createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:4317')
  let path = resolve(root, '.' + decodeURIComponent(url.pathname))
  if (!path.startsWith(root + sep)) { response.writeHead(404).end('Not found'); return }
  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html')
    const body = await readFile(path)
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch (error) {
    console.error(`Static preview failed for ${url.pathname}: ${error.message}`)
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR'
    response.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : 'Static preview failed')
  }
}).listen(4317, '127.0.0.1', () => console.log('Bundle preview on http://127.0.0.1:4317'))
