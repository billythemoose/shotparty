/**
 * @fileoverview Renders a self-contained gallery page from a list of stored uploads. Pure (no AWS
 * calls): the CLI (scripts/gallery.ts) lists S3 and presigns the URLs, this turns them into HTML.
 */

/** How the gallery shows a file. */
export type MediaKind = 'image' | 'heic' | 'raw' | 'video' | 'other';

/** One accepted upload with its presigned links. */
export interface GalleryItem {
  key: string; // accepted/<event>/<guest>/<uuid>.<ext>
  guest: string;
  size: number;
  uploadedAt: Date;
  viewUrl: string;
  downloadUrl: string;
}

/** What the page header says. */
export interface GalleryMeta {
  eventId: string;
  stage: string;
  generatedAt: Date;
  linksExpireAt: Date;
}

const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const HEIC = new Set(['heic', 'heif']);
const RAW = new Set(['dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2']);
const VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', '3gp']);

/** Returns a key's lowercase extension, or ''. */
function extensionOf(key: string): string {
  return key.split('.').pop()?.toLowerCase() ?? '';
}

/** Returns how to show a file, from its extension. */
export function kindOf(key: string): MediaKind {
  const ext = extensionOf(key);
  if (IMAGE.has(ext)) return 'image';
  if (HEIC.has(ext)) return 'heic'; // only Safari can display HEIC; others get a placeholder
  if (RAW.has(ext)) return 'raw'; // no browser renders RAW
  if (VIDEO.has(ext)) return 'video';
  return 'other';
}

/** accepted/<event>/<guest>/<file> -> <guest> ("" if the key has no guest folder). */
export function guestOf(key: string): string {
  const parts = key.split('/');
  return parts.length >= 4 ? (parts[2] ?? '') : '';
}

/** A readable, sortable name for downloads: <guest>_<yyyy-mm-dd_hh-mm-ss>_<id8>.<ext> */
export function downloadName(item: Pick<GalleryItem, 'key' | 'guest' | 'uploadedAt'>): string {
  const stamp = item.uploadedAt.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  const id = (item.key.split('/').pop() ?? '').split('.')[0]?.slice(0, 8) ?? 'file';
  return `${item.guest || 'guest'}_${stamp}_${id}.${extensionOf(item.key)}`;
}

/** Escapes text for HTML content and attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Formats a size as KB, MB or GB. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Groups uploads by guest, oldest first within a guest, busiest guests first. */
export function groupByGuest(items: GalleryItem[]): Array<[string, GalleryItem[]]> {
  const groups = new Map<string, GalleryItem[]>();
  for (const item of items) {
    const list = groups.get(item.guest) ?? [];
    list.push(item);
    groups.set(item.guest, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime());
  }
  // Most photos first, then alphabetical; "anonymous" last.
  return [...groups.entries()].sort(
    ([a, x], [b, y]) =>
      Number(a === 'anonymous') - Number(b === 'anonymous') ||
      y.length - x.length ||
      a.localeCompare(b),
  );
}

function card(item: GalleryItem, timeFormat: (d: Date) => string): string {
  const view = escapeHtml(item.viewUrl);
  const download = escapeHtml(item.downloadUrl);
  const kind = kindOf(item.key);
  let media: string;
  if (kind === 'image') {
    media = `<button class="thumb" data-full="${view}" aria-label="View full size"><img src="${view}" loading="lazy" alt=""></button>`;
  } else if (kind === 'heic') {
    media = `<button class="thumb" data-full="${view}" aria-label="View full size"><img src="${view}" loading="lazy" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'placeholder',textContent:'HEIC photo: preview in Safari, or download'}))"></button>`;
  } else if (kind === 'raw') {
    media = `<span class="placeholder">${escapeHtml(extensionOf(item.key).toUpperCase())} RAW photo: download to view</span>`;
  } else if (kind === 'video') {
    media = `<video src="${view}" controls preload="metadata" playsinline></video>`;
  } else {
    media = `<span class="placeholder">${escapeHtml(extensionOf(item.key).toUpperCase() || 'file')}</span>`;
  }
  return `<figure class="card">${media}<figcaption><span>${escapeHtml(timeFormat(item.uploadedAt))} · ${formatBytes(item.size)}</span><a href="${download}">Download</a></figcaption></figure>`;
}

/** Returns the self-contained gallery page. */
export function renderGallery(
  items: GalleryItem[],
  meta: GalleryMeta,
  timeFormat: (d: Date) => string = (d) =>
    d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
): string {
  const groups = groupByGuest(items);
  const total = items.reduce((s, i) => s + i.size, 0);
  const title = `${meta.eventId} (${meta.stage})`;
  const sections = groups
    .map(
      ([guest, list]) =>
        `<section><h2>${escapeHtml(guest || 'unknown')} <small>${list.length} file${list.length === 1 ? '' : 's'}</small></h2><div class="grid">${list.map((i) => card(i, timeFormat)).join('')}</div></section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Gallery: ${escapeHtml(title)}</title>
<style>
:root { --bg:#fbf8f3; --surface:#fff; --fg:#2a2622; --muted:#7a7166; --line:#e7e0d6; --accent:#8a6a4f; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg:#1b1a18; --surface:#25231f; --fg:#f1ece4; --muted:#a69d90; --line:#3a362f; --accent:#c9a582; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
header, main { max-width: 72rem; margin: 0 auto; padding: 1.25rem 1rem; }
h1 { margin: 0; font: 500 1.8rem Georgia, serif; }
.muted, small, figcaption span { color: var(--muted); }
h2 { font-size: 1.1rem; margin: 1.75rem 0 0.75rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr)); gap: 0.75rem; }
.card { margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.thumb { display: block; width: 100%; padding: 0; border: 0; background: none; cursor: zoom-in; }
.card img, .card video, .placeholder { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; background: var(--line); }
.placeholder { display: grid; place-items: center; padding: 0.5rem; text-align: center; font-size: 0.8rem; color: var(--muted); }
figcaption { display: flex; justify-content: space-between; gap: 0.5rem; padding: 0.4rem 0.6rem; font-size: 0.8rem; }
a { color: var(--accent); }
dialog { max-width: 96vw; max-height: 96vh; padding: 0; border: 0; background: transparent; }
dialog::backdrop { background: rgb(0 0 0 / 0.85); }
dialog img { display: block; max-width: 96vw; max-height: 92vh; object-fit: contain; }
</style>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<p class="muted">${items.length} file${items.length === 1 ? '' : 's'} · ${formatBytes(total)} · ${groups.length} guest folder${groups.length === 1 ? '' : 's'}<br>
Generated ${escapeHtml(meta.generatedAt.toISOString())}. Links expire ${escapeHtml(meta.linksExpireAt.toISOString())} (or when your AWS login session ends); re-run <code>npm run gallery</code> for fresh ones.</p>
</header>
<main>
${sections || '<p class="muted">No accepted uploads yet.</p>'}
</main>
<dialog id="viewer"><img alt=""></dialog>
<script>
const viewer = document.getElementById('viewer');
document.addEventListener('click', (e) => {
  const thumb = e.target.closest('.thumb');
  if (thumb) { viewer.querySelector('img').src = thumb.dataset.full; viewer.showModal(); }
  else if (e.target.closest('dialog')) viewer.close();
});
</script>
</body>
</html>
`;
}
