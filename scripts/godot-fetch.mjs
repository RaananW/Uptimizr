#!/usr/bin/env node
/**
 * Fetch the pinned Godot 4 headless Linux editor and the Web export template(s) the
 * sample project (`examples/godot-web-export`) needs — with no npm dependencies.
 *
 *   pnpm godot:fetch
 *
 * The export-templates bundle on GitHub releases (`*_export_templates.tpz`) is a
 * 1.2 GB plain zip, but the release host honours HTTP `Range`. We read its
 * end-of-central-directory + central directory (~64 KB), locate
 * `templates/web_nothreads_release.zip` (~10 MB), range-fetch only those bytes,
 * inflate them, and install the member under the file name Godot expects:
 *
 *   ~/.local/share/godot/export_templates/<major.minor.patch.status>/web_nothreads_release.zip
 *
 * The editor zip (~78 MB) is downloaded whole and its single binary extracted to
 * `~/.local/share/godot/bin/`. Both steps are idempotent: already-present files are
 * skipped, so `actions/cache` on `~/.local/share/godot` makes CI runs free.
 *
 * Env overrides: `GODOT_DATA_DIR`, `GODOT_BIN`, `GODOT_WEB_TEMPLATES`, `GODOT_DOWNLOAD_BASE`
 * (see `godot-common.mjs`).
 */
/* global fetch */
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";

import {
  GODOT_DOWNLOAD_BASE,
  GODOT_TEMPLATE_VERSION_DIR,
  GODOT_VERSION,
  GODOT_WEB_TEMPLATES,
  godotEditorAssetName,
  godotEditorPath,
  godotTemplatesDir,
} from "./godot-common.mjs";

/** Bytes actually transferred over the network (reported at the end). */
let transferred = 0;

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Minimal zip reader over a "byte source" — a local file or an HTTP Range source.
// Enough for release assets: EOCD (+ zip64 locator), central directory, local
// headers, stored/deflated members, CRC-32 verification.
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

async function fetchWithRetry(url, init, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500) throw new Error(`HTTP ${res.status} from ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}

/** A byte source backed by HTTP Range requests (never downloads the whole asset). */
async function openHttpSource(url) {
  const head = await fetchWithRetry(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD ${url} → HTTP ${head.status}`);
  const size = Number(head.headers.get("content-length"));
  if (!Number.isFinite(size) || size <= 0) throw new Error(`no content-length for ${url}`);
  return {
    size,
    async read(start, end) {
      const res = await fetchWithRetry(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status !== 206) {
        // Never fall through to a 200: that would stream the entire 1.2 GB bundle.
        await res.body?.cancel();
        throw new Error(`Range request not honoured for ${url} (HTTP ${res.status})`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== end - start + 1) {
        throw new Error(`short range read: wanted ${end - start + 1} bytes, got ${buf.length}`);
      }
      transferred += buf.length;
      return buf;
    },
  };
}

/** A byte source backed by a local file (used for the fully-downloaded editor zip). */
function openFileSource(path) {
  const fd = openSync(path, "r");
  return {
    size: statSync(path).size,
    async read(start, end) {
      const buf = Buffer.alloc(end - start + 1);
      let done = 0;
      while (done < buf.length) {
        const n = readSync(fd, buf, done, buf.length - done, start + done);
        if (n === 0) throw new Error(`unexpected EOF reading ${path}`);
        done += n;
      }
      return buf;
    },
    close() {
      closeSync(fd);
    },
  };
}

/** Read the central directory of a zip and return `name → entry`. */
async function readCentralDirectory(source) {
  // The EOCD is ≤ 22 + 65535 (comment) bytes from the end.
  const tailLen = Math.min(source.size, 65536 + 22);
  const tailStart = source.size - tailLen;
  const tail = await source.read(tailStart, source.size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: end-of-central-directory record not found");

  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  const entries16 = tail.readUInt16LE(eocd + 10);
  if (entries16 === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // zip64: the locator sits immediately before the EOCD.
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== SIG_EOCD64_LOC) {
      throw new Error("zip64 end-of-central-directory locator missing");
    }
    const recOffset = Number(tail.readBigUInt64LE(loc + 8));
    const rec = await source.read(recOffset, recOffset + 56 - 1);
    if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new Error("bad zip64 EOCD record");
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }

  const cd =
    cdOffset >= tailStart
      ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
      : await source.read(cdOffset, cdOffset + cdSize - 1);

  const entries = new Map();
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === SIG_CENTRAL) {
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
    // zip64 extended information extra field (id 0x0001) overrides 0xffffffff fields.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
        if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    entries.set(name, { name, method, crc, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Fetch + decompress one member, verifying its CRC-32. */
async function extractEntry(source, entry) {
  const head = await source.read(entry.offset, entry.offset + 30 - 1);
  if (head.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const dataStart = entry.offset + 30 + nameLen + extraLen;
  const raw =
    entry.compressedSize === 0
      ? Buffer.alloc(0)
      : await source.read(dataStart, dataStart + entry.compressedSize - 1);
  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = inflateRawSync(raw);
  else throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  if (data.length !== entry.size) {
    throw new Error(`size mismatch for ${entry.name}: ${data.length} != ${entry.size}`);
  }
  if (crc32(data) !== entry.crc) throw new Error(`CRC mismatch for ${entry.name}`);
  return data;
}

function writeAtomic(path, data, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.part`;
  writeFileSync(tmp, data);
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function installTemplates() {
  const dir = godotTemplatesDir();
  const missing = GODOT_WEB_TEMPLATES.filter((t) => !existsSync(join(dir, t)));
  if (missing.length === 0) {
    console.log(`[godot-fetch] templates present in ${dir}: ${GODOT_WEB_TEMPLATES.join(", ")}`);
    return;
  }
  const url = `${GODOT_DOWNLOAD_BASE}/Godot_v${GODOT_VERSION}_export_templates.tpz`;
  console.log(`[godot-fetch] range-fetching ${missing.join(", ")} from ${url}`);
  const source = await openHttpSource(url);
  const entries = await readCentralDirectory(source);
  for (const template of missing) {
    const entry = entries.get(`templates/${template}`);
    if (!entry) {
      throw new Error(
        `templates/${template} not found in the export templates bundle (have: ` +
          `${[...entries.keys()].filter((k) => k.includes("web")).join(", ")})`,
      );
    }
    console.log(
      `[godot-fetch]   ${template}: ${mb(entry.compressedSize)} at offset ${entry.offset}`,
    );
    const data = await extractEntry(source, entry);
    writeAtomic(join(dir, template), data);
  }
  // The editor's template manager also writes the bundle's version marker.
  const versionEntry = entries.get("templates/version.txt");
  if (versionEntry && !existsSync(join(dir, "version.txt"))) {
    writeAtomic(join(dir, "version.txt"), await extractEntry(source, versionEntry));
  }
  console.log(`[godot-fetch] installed into ${dir}`);
}

async function installEditor() {
  const bin = godotEditorPath();
  if (existsSync(bin)) {
    console.log(`[godot-fetch] editor present: ${bin}`);
    return;
  }
  if (process.env.GODOT_BIN) {
    throw new Error(`GODOT_BIN=${process.env.GODOT_BIN} does not exist`);
  }
  const asset = godotEditorAssetName();
  const url = `${GODOT_DOWNLOAD_BASE}/${asset}.zip`;
  const zipPath = `${bin}.zip.part`;
  mkdirSync(dirname(bin), { recursive: true });
  console.log(`[godot-fetch] downloading ${url}`);
  const res = await fetchWithRetry(url);
  if (!res.ok || !res.body) throw new Error(`GET ${url} → HTTP ${res.status}`);
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(zipPath));
  transferred += bytes;

  const source = openFileSource(zipPath);
  try {
    const entries = await readCentralDirectory(source);
    // The editor zip holds a single binary named like the asset.
    const entry = entries.get(asset) ?? [...entries.values()].find((e) => !e.name.endsWith("/"));
    if (!entry) throw new Error(`no binary found inside ${url}`);
    writeAtomic(bin, await extractEntry(source, entry), 0o755);
  } finally {
    source.close();
    rmSync(zipPath, { force: true });
  }
  console.log(`[godot-fetch] installed editor: ${bin}`);
}

async function main() {
  const started = Date.now();
  console.log(`[godot-fetch] Godot ${GODOT_VERSION} (templates dir ${GODOT_TEMPLATE_VERSION_DIR})`);
  await installEditor();
  await installTemplates();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[godot-fetch] done in ${secs}s — transferred ${mb(transferred)}`);
}

main().catch((err) => {
  console.error(`[godot-fetch] ${err?.stack ?? err}`);
  process.exit(1);
});
