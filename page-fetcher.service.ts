import { Injectable, Logger } from '@nestjs/common';
import {
  FETCH_TIMEOUT_MS,
  IMAGE_CONTENT_TYPE_RE,
  IMAGE_FETCH_TIMEOUT_MS,
  IMAGE_MAX_BYTES,
  MAX_HTML_CHARS,
  MAX_IMAGES,
  MAX_LINKS,
  MAX_TEXT_CHARS,
  USER_AGENT,
} from './market-watch.constants';

export interface PageImage {
  url: string;
  /** The img's alt text — usually the bike's title on dealer sites. */
  alt: string;
  /** Absolute href of the anchor wrapping the img (a listing card's photo
   *  links to its own detail page) — the strongest photo→listing signal. */
  forLink: string | null;
}

export interface FetchedPage {
  /** Cleaned, whitespace-collapsed page text (capped at MAX_TEXT_CHARS). */
  text: string;
  /** Same-host links with their anchor text — the extractor derives stable
   *  listing keys and detail URLs from these. */
  links: { url: string; text: string }[];
  /** Images on the page (any host — photos live on CDNs), each tied to its
   *  wrapping anchor where one exists, so the extractor can attach the right
   *  photo to the right listing. */
  images: PageImage[];
  /** Raw HTML length before cleaning — used by the JS-shell heuristic. */
  htmlChars: number;
}

export interface FetchedImage {
  data: Buffer;
  contentType: string;
}

/** AJAX-paginated stock lists (e.g. a getData.php the site's own pager
 *  POSTs to) need a form body — everything else stays a plain GET. */
export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: string;
}

/**
 * Polite page retrieval for Market Watch. Plain fetch, honest User-Agent,
 * robots.txt respected. No headless browser: server-rendered pages (most
 * dealer sites) work as-is; a JavaScript-only page yields almost no text,
 * which the scanner detects and reports as a per-source failure instead of
 * silently seeing an empty site.
 */
@Injectable()
export class PageFetcherService {
  private readonly logger = new Logger(PageFetcherService.name);

  // robots.txt disallow-prefixes per origin, cached for an hour.
  private robotsCache = new Map<string, { at: number; disallow: string[] }>();
  private static ROBOTS_TTL_MS = 3_600_000;

  private async fetchWithTimeout(
    url: string,
    timeoutMs: number,
    opts?: FetchOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        method: opts?.method ?? 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-ZA,en',
          ...(opts?.body !== undefined
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        ...(opts?.body !== undefined ? { body: opts.body } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Minimal robots.txt reader: the `User-agent: *` group's Disallow rules.
   *  Fails OPEN on network problems (absence of robots.txt allows crawling),
   *  but a parseable Disallow that covers our path is respected. */
  private async robotsDisallows(origin: string): Promise<string[]> {
    const cached = this.robotsCache.get(origin);
    if (cached && Date.now() - cached.at < PageFetcherService.ROBOTS_TTL_MS) {
      return cached.disallow;
    }
    let disallow: string[] = [];
    try {
      const res = await this.fetchWithTimeout(`${origin}/robots.txt`, 10_000);
      if (res.ok) {
        const body = (await res.text()).slice(0, 100_000);
        let inStarGroup = false;
        for (const raw of body.split(/\r?\n/)) {
          const line = raw.replace(/#.*$/, '').trim();
          if (!line) continue;
          const [k, ...rest] = line.split(':');
          const key = k?.trim().toLowerCase();
          const value = rest.join(':').trim();
          if (key === 'user-agent') {
            inStarGroup = value === '*';
          } else if (inStarGroup && key === 'disallow' && value) {
            disallow.push(value);
          }
        }
      }
    } catch {
      disallow = []; // unreachable robots.txt -> crawl allowed
    }
    this.robotsCache.set(origin, { at: Date.now(), disallow });
    return disallow;
  }

  async assertAllowedByRobots(url: string): Promise<void> {
    const u = new URL(url);
    const disallow = await this.robotsDisallows(u.origin);
    const path = u.pathname + u.search;
    const hit = disallow.find((prefix) => path.startsWith(prefix));
    if (hit) {
      throw new Error(`robots.txt disallows this path (rule: "Disallow: ${hit}")`);
    }
  }

  async fetchPage(url: string, opts?: FetchOptions): Promise<FetchedPage> {
    await this.assertAllowedByRobots(url);
    const res = await this.fetchWithTimeout(url, FETCH_TIMEOUT_MS, opts);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !/html|xml|text/i.test(contentType)) {
      throw new Error(`not an HTML page (content-type: ${contentType})`);
    }
    const html = (await res.text()).slice(0, MAX_HTML_CHARS);
    return {
      text: this.toText(html),
      links: this.extractLinks(html, url),
      images: this.extractImages(html, url),
      htmlChars: html.length,
    };
  }

  /**
   * Download one listing photo. Same politeness as pages (honest UA,
   * robots.txt respected — absent robots on a CDN fails open), plus the
   * checks a photo needs: an image/* content type and a hard size cap,
   * enforced again after the body arrives because Content-Length can lie.
   */
  async fetchImage(url: string): Promise<FetchedImage> {
    await this.assertAllowedByRobots(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!IMAGE_CONTENT_TYPE_RE.test(contentType)) {
        throw new Error(`not an image (content-type: ${contentType || 'missing'})`);
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > IMAGE_MAX_BYTES) {
        throw new Error(`image too large (${declared} bytes)`);
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.byteLength > IMAGE_MAX_BYTES) {
        throw new Error(`image too large (${data.byteLength} bytes)`);
      }
      if (data.byteLength === 0) {
        throw new Error('empty image body');
      }
      return { data, contentType: contentType.toLowerCase() };
    } finally {
      clearTimeout(timer);
    }
  }

  /** HTML -> readable text, dependency-free. Exact layout is irrelevant —
   *  the AI extractor reads semantically — but block boundaries must
   *  survive so "R 189 999" stays attached to the right bike. */
  toText(html: string): string {
    let s = html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
    // Block-level closers/openers become newlines, then all tags go.
    s = s
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|ul|ol|table|header|footer)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    s = this.decodeEntities(s);
    return s
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .join('\n')
      .slice(0, MAX_TEXT_CHARS);
  }

  private decodeEntities(s: string): string {
    const named: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
      ndash: '–',
      mdash: '—',
      rsquo: '’',
      lsquo: '‘',
      rdquo: '”',
      ldquo: '“',
      eacute: 'é',
    };
    return s
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ' ';
      })
      .replace(/&#(\d+);/g, (_, dec: string) => {
        const code = parseInt(dec, 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ' ';
      })
      .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
  }

  /** Same-host links with anchor text, absolute, deduped, capped. */
  extractLinks(html: string, baseUrl: string): { url: string; text: string }[] {
    const base = new URL(baseUrl);
    const out: { url: string; text: string }[] = [];
    const seen = new Set<string>();
    const re = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < MAX_LINKS) {
      const href = (m[2] ?? m[3] ?? '').trim();
      if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) continue;
      let abs: URL;
      try {
        abs = new URL(href, base);
      } catch {
        continue;
      }
      if (abs.host !== base.host || !/^https?:$/.test(abs.protocol)) continue;
      abs.hash = '';
      const url = abs.toString();
      if (seen.has(url)) continue;
      seen.add(url);
      const text = this.toText(m[4] ?? '')
        .replace(/\n/g, ' ')
        .slice(0, 120);
      out.push({ url, text });
    }
    return out;
  }

  /**
   * Images with their alt text and, when the img sits inside an anchor, that
   * anchor's absolute href. Dealer listing cards wrap the photo in a link to
   * the bike's own detail page, so `forLink` lets the extractor pair photo
   * and listing deterministically; alt text is the fallback signal. Any host
   * is allowed — photos almost always live on a CDN, not the page's domain.
   */
  extractImages(html: string, baseUrl: string): PageImage[] {
    const base = new URL(baseUrl);

    // Anchor spans first, so each img can be located inside (or outside) one.
    const anchors: { start: number; end: number; href: string | null }[] = [];
    const aRe = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>[\s\S]*?<\/a>/gi;
    let am: RegExpExecArray | null;
    while ((am = aRe.exec(html)) !== null) {
      const href = (am[2] ?? am[3] ?? '').trim();
      let abs: string | null = null;
      if (href && !href.startsWith('#') && !/^(javascript|mailto|tel):/i.test(href)) {
        try {
          const u = new URL(href, base);
          if (/^https?:$/.test(u.protocol)) {
            u.hash = '';
            abs = u.toString();
          }
        } catch {
          /* unparseable href — anchor still delimits the img */
        }
      }
      anchors.push({ start: am.index, end: am.index + am[0].length, href: abs });
    }

    const out: PageImage[] = [];
    const seen = new Set<string>();
    const imgRe = /<img\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(html)) !== null && out.length < MAX_IMAGES) {
      const tag = m[0];
      const attr = (name: string): string => {
        const a = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
        return (a?.[2] ?? a?.[3] ?? '').trim();
      };
      // Lazy-loaded cards keep the real photo in data-src/data-lazy-src (or
      // srcset) while src holds a placeholder — prefer the real one.
      const raw =
        attr('data-src') ||
        attr('data-lazy-src') ||
        attr('data-original') ||
        attr('srcset').split(/\s+/)[0] ||
        attr('src');
      if (!raw || raw.startsWith('data:')) continue;
      let abs: URL;
      try {
        abs = new URL(raw, base);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(abs.protocol)) continue;
      abs.hash = '';
      const url = abs.toString();
      if (url.length > 500 || seen.has(url)) continue;
      seen.add(url);

      const wrapping = anchors.find((a) => m!.index > a.start && m!.index < a.end);
      out.push({
        url,
        alt: this.decodeEntities(attr('alt')).replace(/\s+/g, ' ').trim().slice(0, 120),
        forLink: wrapping?.href ?? null,
      });
    }
    return out;
  }
}
