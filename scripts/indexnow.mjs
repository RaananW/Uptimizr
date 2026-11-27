#!/usr/bin/env node
/**
 * Tell IndexNow search engines (Bing, Yandex, Seznam, Naver and others) which
 * uptimizr.com pages changed, so they recrawl them in hours instead of weeks.
 * Bing's index also feeds ChatGPT search and Copilot answers.
 *
 * IndexNow proves ownership with a key file served at the site root:
 * `oss/apps/web/public/<key>.txt`, whose content is the key itself. The key is
 * public by design; it only lets the holder submit URLs for this host. It is
 * read from that file's name rather than repeated here, so there is one copy
 * (and no key-shaped literal for secret scanners to flag). To rotate it, rename
 * the file and change its content to match.
 *
 * Usage:
 *   node scripts/indexnow.mjs --from <sha> --to <sha>   pages changed between two commits
 *   node scripts/indexnow.mjs --all                     every URL in the live sitemaps
 *   node scripts/indexnow.mjs --urls <url>,<url>        explicit URLs
 * Add --dry-run to print the URLs without submitting them.
 *
 * Run by .github/workflows/indexnow.yml after each production deploy of the site.
 */
/* global fetch */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HOST = "www.uptimizr.com";
const PUBLIC_DIR = fileURLToPath(new URL("../oss/apps/web/public/", import.meta.url));
const KEY = readKey();
const ORIGIN = `https://${HOST}`;
const ENDPOINT = "https://api.indexnow.org/indexnow";
const SITEMAPS = [`${ORIGIN}/sitemap-index.xml`, `${ORIGIN}/docs/sitemap-index.xml`];
// The protocol accepts up to 10,000 URLs per request.
const MAX_URLS = 10_000;

const DOCS_CONTENT = /^oss\/apps\/docs\/src\/content\/docs\/(.+)\.mdx?$/;

/** Find the one `<32 hex>.txt` key file in the site's public folder and check its content. */
function readKey() {
  const files = readdirSync(PUBLIC_DIR).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  if (files.length !== 1) {
    throw new Error(`expected one IndexNow key file in ${PUBLIC_DIR}, found ${files.length}`);
  }
  const key = files[0].slice(0, -".txt".length);
  if (readFileSync(join(PUBLIC_DIR, files[0]), "utf8").trim() !== key) {
    throw new Error(`${files[0]} must contain exactly its own name, without .txt`);
  }
  return key;
}

/**
 * Map repo paths to the public URLs whose content they change. Docs pages map
 * one to one; anything under the marketing site's `src` changes the home page.
 * Other files (config, packages, tests) don't change a crawlable page.
 */
function urlsForChangedFiles(files) {
  const urls = new Set();
  for (const file of files) {
    const docs = DOCS_CONTENT.exec(file);
    if (docs) {
      const slug = docs[1].replace(/(^|\/)index$/, "");
      urls.add(`${ORIGIN}/docs/${slug ? `${slug}/` : ""}`);
    } else if (file.startsWith("oss/apps/web/src/")) {
      urls.add(`${ORIGIN}/`);
    } else if (file === "oss/apps/web/public/llms.txt") {
      urls.add(`${ORIGIN}/llms.txt`);
    }
  }
  return [...urls].sort();
}

function changedFiles(from, to) {
  // Deleted and renamed pages are included: IndexNow also takes URLs that now 404.
  const out = execFileSync("git", ["diff", "--name-only", "--no-renames", `${from}..${to}`], {
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

async function sitemapUrls(url, seen = new Set()) {
  if (seen.has(url)) return [];
  seen.add(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetching ${url} failed: ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (!/<sitemapindex[\s>]/.test(xml)) return locs;
  const nested = await Promise.all(locs.map((loc) => sitemapUrls(loc, seen)));
  return nested.flat();
}

async function submit(urls) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: HOST,
      key: KEY,
      keyLocation: `${ORIGIN}/${KEY}.txt`,
      urlList: urls,
    }),
  });
  // 200 = accepted, 202 = accepted while the key file is still being verified.
  if (res.status !== 200 && res.status !== 202) {
    const body = await res.text();
    throw new Error(`IndexNow rejected the submission: ${res.status} ${body}`.trim());
  }
  return res.status;
}

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      to: { type: "string", default: "HEAD" },
      all: { type: "boolean", default: false },
      urls: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  let urls;
  if (values.urls) {
    urls = values.urls
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
  } else if (values.all) {
    urls = [
      ...new Set(await Promise.all(SITEMAPS.map((s) => sitemapUrls(s))).then((l) => l.flat())),
    ];
  } else if (values.from) {
    urls = urlsForChangedFiles(changedFiles(values.from, values.to));
  } else {
    throw new Error("pass --from <sha>, --all or --urls <list>");
  }

  const foreign = urls.filter((u) => new URL(u).host !== HOST);
  if (foreign.length > 0) throw new Error(`URLs must be on ${HOST}: ${foreign.join(", ")}`);
  if (urls.length === 0) {
    console.log("No crawlable pages changed; nothing to submit.");
    return;
  }
  if (urls.length > MAX_URLS) throw new Error(`${urls.length} URLs exceeds ${MAX_URLS}`);

  console.log(`${urls.length} URL(s):\n${urls.map((u) => `  ${u}`).join("\n")}`);
  if (values["dry-run"]) return;
  const status = await submit(urls);
  console.log(`Submitted to IndexNow (HTTP ${status}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
