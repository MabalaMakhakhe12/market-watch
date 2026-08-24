// Market Watch tuning. Values here are engineering guardrails; the
// operator-facing knobs (cron, auto-apply, delta threshold) live in env/config.

/** A listing must be absent from this many CONSECUTIVE successful scans
 *  before it is declared REMOVED — one flaky scan never fires "sold". */
export const REMOVED_AFTER_MISSES = 2;

/** Politeness: pause between sources so scans never hammer anyone. */
export const INTER_SOURCE_DELAY_MS = 1_500;

/** Politeness: pause between a paginated source's own pages. */
export const INTER_PAGE_DELAY_MS = 1_000;

/** A source's pageTemplate must be a URL template or "POST <url> <body>"
 *  containing a page placeholder: {page} → 1,2,3… or {offset:N} → 0,N,2N…. */
export const PAGE_TEMPLATE_RE =
  /^(POST\s+https?:\/\/\S+\s+\S*(\{page\}|\{offset:\d+\})\S*|https?:\/\/\S*(\{page\}|\{offset:\d+\})\S*)$/i;

export const FETCH_TIMEOUT_MS = 30_000;

/** Pages larger than this are truncated before text extraction. */
export const MAX_HTML_CHARS = 2_000_000;

/** Page text handed to the extractor is capped at this many characters. */
export const MAX_TEXT_CHARS = 60_000;

/** Same-host links handed to the extractor (for detail URLs / stable keys). */
export const MAX_LINKS = 250;

/** Images harvested per page and handed to the extractor (any host — dealer
 *  photos usually live on a CDN). */
export const MAX_IMAGES = 200;

/** One listing photo — anything bigger is a hero banner, not a card thumb. */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

export const IMAGE_FETCH_TIMEOUT_MS = 20_000;

/** Politeness: pause between listing-photo downloads within a scan. */
export const INTER_IMAGE_DELAY_MS = 250;

/** Photo downloads per scan. A big baseline catches up over the next scans
 *  (a listing with a photo URL but no stored copy is retried) instead of
 *  hammering the CDN in one go. */
export const MAX_IMAGE_DOWNLOADS_PER_SCAN = 80;

/** Presigned URL lifetime for serving stored listing photos to the staff
 *  dashboard — marketing-grade assets, not sensitive documents. */
export const IMAGE_URL_TTL_SECONDS = 3_600;

export const IMAGE_CONTENT_TYPE_RE = /^image\/(jpe?g|png|webp|gif|avif)/i;

/** Storage-key extension per image content type. */
export const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** Identify ourselves honestly — sites can contact or block us by name. */
export const USER_AGENT =
  'MotobuybackMarketWatch/1.0 (+https://motobuyback.com; stock monitor)';

/** Auto-adding used examples stops at this many rows per model; beyond it
 *  the add queues for review so the calculator's picker stays curated. */
export const MAX_USED_EXAMPLES_PER_MODEL = 12;

/** If a source that previously had more than this many listings suddenly
 *  extracts zero, the scan is treated as failed instead of mass-removing —
 *  a redesign or bot-block must never wipe the snapshot. */
export const SUSPICIOUS_ZERO_THRESHOLD = 3;
