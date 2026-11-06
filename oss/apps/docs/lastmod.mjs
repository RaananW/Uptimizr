import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

const CONTENT_DIR = fileURLToPath(new URL("./src/content/docs/", import.meta.url));
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const LAST_UPDATED = /^lastUpdated:\s*["']?(\d{4}-\d{2}-\d{2})/m;

/**
 * Map each docs page's slug to its `lastUpdated` frontmatter date, for the sitemap's `lastmod`.
 *
 * The date comes from frontmatter rather than `git log` because a shallow CI or hosting clone
 * would report the clone's boundary commit for older files, advertising freshness a page doesn't
 * have. A page with no `lastUpdated` simply gets no `lastmod`.
 */
export function readLastUpdatedBySlug(contentDir = CONTENT_DIR) {
  const dates = new Map();
  for (const entry of readdirSync(contentDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.mdx?$/.test(entry.name)) continue;

    const path = join(entry.parentPath, entry.name);
    const frontmatter = FRONTMATTER.exec(readFileSync(path, "utf8"))?.[1];
    const date = frontmatter && LAST_UPDATED.exec(frontmatter)?.[1];
    if (!date) continue;

    const slug = relative(contentDir, path)
      .replaceAll("\\", "/")
      .replace(/\.mdx?$/, "")
      .replace(/(^|\/)index$/, "");
    dates.set(slug, date);
  }
  return dates;
}
