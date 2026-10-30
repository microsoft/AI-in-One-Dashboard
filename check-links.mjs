import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const SAMPLE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com']);
const CAVEATS = [
  'Downloads and overview media are checked using bounded byte samples, not full-file integrity or execution tests.',
  'YouTube public oEmbed validates video metadata only; playback, embedding, regional and account restrictions are not tested.',
  'PAX pages are checked as public HTML destinations; browser application behavior is not tested.'
];

class CheckError extends Error {
  constructor(message, status = 'fail', code = 'INVALID_DESTINATION') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireCheck(condition, message, status = 'fail', code) {
  if (!condition) throw new CheckError(message, status, code);
}

function publicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CheckError('Missing or invalid absolute HTTPS URL.');
  }
  const host = url.hostname.toLowerCase();
  requireCheck(url.protocol === 'https:' && !url.username && !url.password,
    'Only credential-free HTTPS URLs are allowed.');
  requireCheck(!isIP(host.replace(/^\[|\]$/g, '')) && host.includes('.') &&
    !/(?:^|\.)(?:localhost|local|internal|lan|test|invalid)$/.test(host),
  'Local, private-address and non-public hostnames are not allowed.');
  requireCheck(!/^(?:login\.|accounts\.google\.)/.test(host) &&
    !/(?:^|\/)(?:login|signin|sign-in|oauth\/authorize)(?:\/|$)/i.test(url.pathname),
  'Destination redirects to authentication rather than public content.');
  url.hash = '';
  return url;
}

function displayUrl(value) {
  try {
    const url = publicUrl(value);
    return url.origin + url.pathname;
  } catch (error) {
    if (error instanceof CheckError) return null;
    throw error;
  }
}

function cleanText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export async function loadCatalog() {
  let source;
  try {
    source = await readFile(new URL('./assets/catalog.js', import.meta.url), 'utf8');
  } catch (error) {
    throw new CheckError(`Cannot read assets/catalog.js (${safeCode(error.code)}).`, 'fail', 'CATALOG_READ');
  }
  const context = vm.createContext({ window: {} }, { codeGeneration: { strings: false, wasm: false } });
  try {
    vm.runInContext(source, context, { timeout: 1000, filename: 'catalog.js' });
  } catch (error) {
    throw new CheckError(`Cannot evaluate assets/catalog.js (${safeCode(error.name)}).`, 'fail', 'CATALOG_EVALUATION');
  }
  return context.window.AIO_RELEASE;
}

export function collectTargets(release) {
  requireCheck(release && Array.isArray(release.templates) && Array.isArray(release.downloads),
    'Catalog must define AIO_RELEASE.templates and AIO_RELEASE.downloads.', 'fail', 'CATALOG_SCHEMA');
  const target = (item, kind, id, label) => ({
    id, kind, label: cleanText(item?.title || label), url: item?.href, file: item?.file
  });
  return [
    ...release.templates.filter(item => item?.status === 'available').map((item, index) =>
      target(item, 'download', `template:${item.id || index}`, 'Available template')),
    ...release.downloads.map((item, index) =>
      target(item, 'download', `download:${item?.id || index}`, 'Download')),
    target(release.video, 'video', 'overview-video', 'Overview video'),
    target(release.setupVideo, 'video', 'setup-video', 'Setup video'),
    target(release.pax, 'page', 'pax', 'PAX Mini-Kitchen'),
    { id: 'pax-repository', kind: 'page', label: 'PAX repository', url: release.pax?.repository }
  ];
}

async function readPrefix(response, limit) {
  requireCheck(response.body, 'Response has no body.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let ended = false;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      const chunk = Buffer.from(value.subarray(0, limit - size));
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return { body: Buffer.concat(chunks, size), ended };
}

async function probe(value, { signal, fetchImpl }, limit = SAMPLE_BYTES, ranged = true) {
  let url = publicUrl(value);
  const seen = new Set();
  for (let redirects = 0; redirects <= 10; redirects++) {
    requireCheck(!seen.has(url.href), 'Redirect loop detected.');
    seen.add(url.href);
    const response = await fetchImpl(url.href, {
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      headers: {
        'User-Agent': 'AIO-Public-Link-Checker/1.0',
        'Accept-Encoding': 'identity',
        Accept: '*/*',
        ...(ranged ? { Range: `bytes=0-${limit - 1}` } : {})
      }
    });
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      requireCheck(location, `HTTP ${response.status} redirect has no Location header.`);
      requireCheck(redirects < 10, 'More than 10 redirects.');
      try {
        url = publicUrl(new URL(location, url).href);
      } catch (error) {
        if (error instanceof CheckError) throw error;
        throw new CheckError('Redirect has an invalid Location URL.');
      }
      continue;
    }
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel();
      throw new CheckError(`HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500 ? 'unknown' : 'fail', 'HTTP_STATUS');
    }
    const { body, ended } = await readPrefix(response, limit);
    requireCheck(body.length > 0, 'Response body is empty.');
    let total = null;
    if (response.status === 206) {
      const range = /^bytes 0-(\d+)\/(\d+|\*)$/i.exec(response.headers.get('content-range') || '');
      requireCheck(range, 'Partial response has an invalid or nonzero-start Content-Range.');
      total = range[2] === '*' ? null : Number(range[2]);
      const rangeSize = Number(range[1]) + 1;
      requireCheck(total === null || rangeSize <= total, 'Content-Range exceeds the resource size.');
      requireCheck(!ended || body.length === rangeSize, 'Partial response ended before its declared byte range.');
    } else {
      const length = response.headers.get('content-length');
      total = /^\d+$/.test(length || '') ? Number(length) : null;
      requireCheck(!ended || total === null || total === body.length,
        'Response ended before its declared Content-Length.');
    }
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return {
      body, complete: ended || (total !== null && body.length >= total),
      evidence: {
        httpStatus: response.status, contentType: type || null,
        finalUrl: displayUrl(url.href), redirects, sampledBytes: body.length, totalBytes: total
      }
    };
  }
  throw new CheckError('Redirect limit exceeded.');
}

function rejectErrorContent(body, type) {
  const text = body.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  requireCheck(type !== 'text/html' && type !== 'application/xhtml+xml' &&
    !/^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html\b|<(?:html|head|body|form|script)\b)/i.test(text),
  'Received HTML instead of downloadable content (possibly a login or error page).');
  requireCheck(!/^(?:<\?xml[^>]*>\s*)?<(?:Error|ErrorResponse)\b/.test(text) &&
    !/^(?:404[: ]|not found\b|access denied\b|forbidden\b|bad gateway\b|internal server error\b|service unavailable\b)/i.test(text) &&
    !/^\{\s*"(?:error|errors|message)"\s*:/.test(text),
  'Response contains an error payload instead of the requested content.');
  return text;
}

function checkMime(type, allowed) {
  requireCheck(type, 'Missing Content-Type; content cannot be established.', 'unknown', 'MISSING_CONTENT_TYPE');
  requireCheck(allowed.includes(type), `Unexpected Content-Type: ${cleanText(type)}.`);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new CheckError('Response is not valid JSON.');
  }
}

function validateDownload(target, sample) {
  const { body, complete, evidence } = sample;
  const type = evidence.contentType;
  const text = rejectErrorContent(body, type);
  const extension = extname(target.file || new URL(target.url).pathname).toLowerCase();
  const octet = 'application/octet-stream';
  if (['.pbit', '.pptx', '.zip'].includes(extension)) {
    checkMime(type, [octet, 'application/zip', 'application/x-zip-compressed',
      ...(extension === '.pptx' ? ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] : [])]);
    requireCheck(body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
      'Expected a ZIP-based download signature; received different content.');
  } else if (extension === '.pdf') {
    checkMime(type, ['application/pdf', octet]);
    requireCheck(body.subarray(0, 5).toString('ascii') === '%PDF-', 'Expected a PDF file signature.');
  } else if (['.csv', '.md', '.ipynb', '.json', '.py'].includes(extension)) {
    const additional = {
      '.csv': ['text/csv', 'application/csv', 'application/vnd.ms-excel'],
      '.md': ['text/markdown', 'text/x-markdown'],
      '.ipynb': ['application/json', 'application/x-ipynb+json'],
      '.json': ['application/json', 'text/json'],
      '.py': ['text/x-python', 'application/x-python', 'text/x-script.python']
    };
    checkMime(type, ['text/plain', octet, ...additional[extension]]);
    requireCheck(!text.includes('\u0000') && (text.match(/\uFFFD/g) || []).length < Math.max(2, text.length / 100),
      'Expected readable text, not binary content.');
    if (extension === '.csv') {
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      requireCheck(lines.length >= 2 && /[,;\t]/.test(lines[0]) && /[a-z]/i.test(lines[0]) &&
        !/^[{[<]/.test(text), 'Expected a CSV header and data rows.');
    } else if (extension === '.md') {
      requireCheck(/^(?:#{1,6}\s+\S|[-*]\s+\S|```)|\[[^\]]+\]\([^)]+\)/m.test(text),
        'Expected recognizable Markdown guide content.');
    } else if (extension === '.py') {
      requireCheck(/^(?:from\s+[\w.]+\s+import\b|import\s+\w|(?:async\s+)?def\s+\w|class\s+\w|#!.*python)/m.test(text),
        'Expected recognizable Python source.');
    } else if (complete) {
      const data = parseJson(text);
      requireCheck(data && typeof data === 'object' && !data.error && !data.errors,
        'Expected a non-error JSON document.');
      if (extension === '.ipynb') {
        requireCheck(Array.isArray(data.cells) && Number.isInteger(data.nbformat),
          'Expected notebook JSON with cells and nbformat.');
      }
    } else {
      requireCheck(/^[{[]/.test(text) && /"[^"]+"\s*:/.test(text), 'Expected a JSON document prefix.');
      if (extension === '.ipynb') {
        requireCheck(/"cells"\s*:\s*\[/.test(text), 'Expected notebook cells in the sampled JSON.');
      }
    }
  } else {
    throw new CheckError('Unsupported download extension; add an explicit validator before accepting it.',
      'unknown', 'UNSUPPORTED_DOWNLOAD');
  }
  return `Download exists; ${extension.slice(1).toUpperCase()} content type and byte sample are plausible.`;
}

async function checkYouTube(url, options) {
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1).split('/')[0] :
    url.searchParams.get('v') || /^\/(?:embed|shorts)\/([^/]+)/.exec(url.pathname)?.[1];
  requireCheck(/^[\w-]{11}$/.test(id || ''), 'YouTube URL has no valid video ID.');
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', `https://www.youtube.com/watch?v=${id}`);
  endpoint.searchParams.set('format', 'json');
  const sample = await probe(endpoint.href, options, SAMPLE_BYTES, false);
  checkMime(sample.evidence.contentType, ['application/json']);
  requireCheck(sample.complete, 'oEmbed metadata exceeds the bounded response limit.', 'unknown');
  const data = parseJson(sample.body.toString('utf8'));
  requireCheck(data?.type === 'video' && data.provider_name === 'YouTube' && typeof data.title === 'string' && data.title.trim(),
    'oEmbed did not return valid YouTube video metadata.');
  const iframe = /<iframe\b[^>]*\bsrc=["']([^"']+)["']/i.exec(data.html || '');
  requireCheck(iframe, 'oEmbed metadata has no video iframe.');
  const embedded = publicUrl(iframe[1].replace(/&amp;/g, '&'));
  requireCheck(YOUTUBE_HOSTS.has(embedded.hostname) && embedded.pathname === `/embed/${id}`,
    'oEmbed metadata does not identify the requested video.');
  return {
    detail: 'Public YouTube oEmbed metadata is valid; playback and embedding are not tested.',
    evidence: { ...sample.evidence, videoId: id, title: cleanText(data.title),
      playback: 'not_tested', embedding: 'not_tested' }
  };
}

async function inspectTarget(target, options) {
  const url = publicUrl(target.url);
  if (target.kind === 'video' && YOUTUBE_HOSTS.has(url.hostname)) return checkYouTube(url, options);
  // Signed attachment URLs can authorize GET but reject HEAD; a small ranged GET checks the actual media.
  const sample = await probe(url.href, options, target.kind === 'video' ? 4096 : SAMPLE_BYTES);
  if (target.kind === 'download') {
    return { detail: validateDownload(target, sample), evidence: sample.evidence };
  }
  if (target.kind === 'video') {
    const { body, evidence } = sample;
    rejectErrorContent(body, evidence.contentType);
    checkMime(evidence.contentType, ['video/mp4', 'video/quicktime', 'video/webm', 'video/ogg']);
    const signature = evidence.contentType === 'video/webm' ? body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) :
      evidence.contentType === 'video/ogg' ? body.subarray(0, 4).toString('ascii') === 'OggS' :
        body.subarray(4, 8).toString('ascii') === 'ftyp';
    requireCheck(signature, 'Video Content-Type does not match the sampled media signature.');
    return { detail: 'Video media responds with a matching MIME type and byte signature; playback is not tested.', evidence };
  }
  requireCheck(target.kind === 'page', 'Unsupported check kind.', 'unknown');
  checkMime(sample.evidence.contentType, ['text/html', 'application/xhtml+xml']);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(sample.body.toString('utf8'))?.[1];
  requireCheck(title, 'No page title in the bounded HTML sample; destination is unverified.', 'unknown');
  requireCheck(!/(?:^|\b)(?:sign in|log in|page not found|404|access denied|rate limit|just a moment|error)(?:\b|$)/i.test(title),
    'Public destination returned a login, error or challenge page.');
  requireCheck(/\b(?:PAX|Mini[- ]Kitchen)\b/i.test(title), 'Page title does not establish a PAX destination.', 'unknown');
  return { detail: `Public PAX page responds: ${cleanText(title)}.`, evidence: sample.evidence };
}

function safeCode(value) {
  return typeof value === 'string' && /^[a-z0-9_]+$/i.test(value) ? value : 'UNSPECIFIED';
}

function errorResult(error, signal) {
  if (error instanceof CheckError) return { status: error.status, code: error.code, detail: error.message };
  if (signal?.aborted) return { status: 'unknown', code: 'TIMEOUT', detail: 'Request or response body exceeded the per-link timeout.' };
  const code = error?.cause?.code || error?.code;
  if (code || error?.name === 'TypeError') {
    return { status: 'unknown', code: 'NETWORK_ERROR', detail: `Network request failed (${safeCode(code)}).` };
  }
  return { status: 'unknown', code: 'CHECK_ERROR', detail: `Unexpected check error (${safeCode(error?.name)}); not validated.` };
}

export async function checkTarget(target, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const result = {
    id: target.id, kind: target.kind, label: target.label, url: displayUrl(target.url)
  };
  try {
    return { ...result, status: 'pass', ...await inspectTarget(target, { signal: controller.signal, fetchImpl }) };
  } catch (error) {
    return { ...result, ...errorResult(error, controller.signal) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runChecks(targets, options = {}) {
  const results = new Array(targets.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
    while (next < targets.length) {
      const index = next++;
      results[index] = await checkTarget(targets[index], options);
    }
  }));
  return results;
}

export function createReport(results, excludedTemplates = 0) {
  const summary = {
    checked: results.length,
    passed: results.filter(item => item.status === 'pass').length,
    failed: results.filter(item => item.status === 'fail').length,
    unknown: results.filter(item => item.status === 'unknown').length,
    excludedUnavailableTemplates: excludedTemplates
  };
  return { schemaVersion: 1, ok: summary.failed === 0 && summary.unknown === 0, summary, results, caveats: CAVEATS };
}

function parseArguments(args) {
  const options = { json: false, timeoutMs: DEFAULT_TIMEOUT_MS, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--timeout-ms' || arg.startsWith('--timeout-ms=')) {
      const value = arg === '--timeout-ms' ? args[++index] : arg.slice('--timeout-ms='.length);
      requireCheck(/^\d+$/.test(value || '') && Number(value) >= 1 && Number(value) <= 120_000,
        '--timeout-ms must be an integer from 1 to 120000.', 'fail', 'ARGUMENTS');
      options.timeoutMs = Number(value);
    } else throw new CheckError('Unsupported argument. Use --help for usage.', 'fail', 'ARGUMENTS');
  }
  return options;
}

async function main(args) {
  const json = args.includes('--json');
  let report;
  try {
    const options = parseArguments(args);
    if (options.help) {
      console.log('Usage: node check-links.mjs [--json] [--timeout-ms 20000]\nRead-only public checks; no credentials, fixes or report files. Exit 1 for any failed or unknown check.');
      return;
    }
    const release = await loadCatalog();
    const targets = collectTargets(release);
    report = createReport(await runChecks(targets, options),
      release.templates.filter(item => item?.status !== 'available').length);
  } catch (error) {
    report = createReport([{ id: 'checker', kind: 'configuration', label: 'Checker configuration', url: null, ...errorResult(error) }]);
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    const { checked, passed, failed, unknown, excludedUnavailableTemplates } = report.summary;
    console.log(`${checked} links: ${passed} passed, ${failed} failed, ${unknown} unknown. ${excludedUnavailableTemplates} unavailable template(s) excluded.`);
    for (const result of report.results) {
      if (result.status !== 'pass') {
        console.log(`[${result.status.toUpperCase()}] ${result.label}: ${result.detail}`);
        if (result.url) console.log(`  ${result.url}`);
      }
    }
    for (const caveat of report.caveats) console.log(`Note: ${caveat}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
