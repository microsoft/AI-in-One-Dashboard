// @ts-check
/**
 * Reads entries from a zip file, enough for a Power BI template (.pbit).
 * Handles stored and deflated entries; no ZIP64, encryption or multi-disk archives.
 */
import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * @typedef {{ name: string, method: number, compressedSize: number, size: number, offset: number }} ZipEntry
 */

/**
 * @param {Buffer} buf
 * @returns {Map<string, ZipEntry>}
 */
export function listZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  /** @type {Map<string, ZipEntry>} */
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== CENTRAL) throw new Error('The zip file\'s directory is damaged.');
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { name, method, compressedSize, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * @param {Buffer} buf
 * @param {string} name
 * @returns {Buffer}
 */
export function readZipEntry(buf, name) {
  const entry = listZip(buf).get(name);
  if (!entry) throw new Error(`The file has no ${name}.`);
  return entryData(buf, entry);
}

/**
 * Every file whose name starts with `prefix`, in the zip's order. Folder entries are left out.
 * @param {Buffer} buf
 * @param {string} prefix
 * @returns {Map<string, Buffer>}
 */
export function readZipEntries(buf, prefix) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  for (const entry of listZip(buf).values()) {
    if (entry.name.startsWith(prefix) && !entry.name.endsWith('/')) out.set(entry.name, entryData(buf, entry));
  }
  return out;
}

/**
 * @param {Buffer} buf
 * @param {ZipEntry} entry
 * @returns {Buffer}
 */
function entryData(buf, entry) {
  const { name } = entry;
  if (buf.readUInt32LE(entry.offset) !== LOCAL) throw new Error(`The zip entry ${name} is damaged.`);
  const start = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`${name} uses zip compression method ${entry.method}, which isn't supported.`);
}
