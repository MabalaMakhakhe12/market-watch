import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BikeCondition, ListingAvailability } from '@prisma/client';
import { FetchedPage } from './page-fetcher.service';

/** One listing as extracted from a page — the scanner's input unit. */
export interface ExtractedListing {
  externalKey: string;
  title: string;
  url: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  priceCents: number | null;
  odoKm: number | null;
  condition: BikeCondition | null;
  availability: ListingAvailability;
  /** The listing's photo URL, chosen from the page's harvested image list —
   *  downloaded into our own storage by the scanner, never hotlinked. */
  imageUrl: string | null;
}

/**
 * The "AI" in Market Watch, and the reason ANY site staff paste in works
 * without a hand-written parser: a small Claude model reads the page text
 * and returns the listings as structured JSON. A site redesign changes the
 * markup, not the meaning, so extraction survives where CSS selectors break.
 *
 * No API key -> `live` is false and the scan reports extraction as disabled
 * instead of failing. Costs stay low by sending cleaned TEXT, not raw HTML,
 * and by using the small model tier (MARKET_WATCH_MODEL).
 */
@Injectable()
export class ListingExtractorService {
  private readonly logger = new Logger(ListingExtractorService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxListings: number;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('anthropic.apiKey') ?? '';
    this.model = config.get<string>('anthropic.model') ?? 'claude-haiku-4-5';
    this.maxListings = config.get<number>('marketWatch.maxListingsPerSource') ?? 150;
  }

  get live(): boolean {
    return this.apiKey !== '';
  }

  private systemPrompt(): string {
    return [
      'You extract motorcycle SALE LISTINGS from the text of a dealer or classifieds web page.',
      'Return ONLY a JSON object, no prose, no code fences, exactly this shape:',
      '{"listings":[{"key":string,"title":string,"url":string|null,"make":string|null,"model":string|null,"year":number|null,"price_zar":number|null,"odo_km":number|null,"condition":"NEW"|"USED"|null,"availability":"IN_STOCK"|"OUT_OF_STOCK"|"SOLD"|"UNKNOWN","image_url":string|null}]}',
      '',
      'Rules:',
      '- Include only actual motorcycles offered for sale on this page. Ignore parts, gear, accessories, rentals, finance banners, navigation, and "similar bikes" widgets.',
      "- key: a STABLE identifier for the listing, derived from the listing's own detail-page URL path or the dealer's stock/reference code. The same physical listing must yield the same key on every visit. Never invent sequential numbers.",
      '- url: the absolute detail-page URL when it appears in the provided link list, else null.',
      '- price_zar: the advertised price in South African Rand as an integer (e.g. "R 189 999" -> 189999). null if no price is shown.',
      '- odo_km: odometer in kilometres as an integer. null if not shown.',
      '- year: the model year as a 4-digit integer, null if not shown.',
      '- make and model separately (e.g. make "Yamaha", model "Ténéré 700"). null when genuinely unclear.',
      '- condition: "NEW" for brand-new/0 km stock, "USED" for second-hand, null if unclear.',
      '- availability: "SOLD" or "OUT_OF_STOCK" when the listing is badged sold/out of stock/reserved; "IN_STOCK" when clearly available; otherwise "UNKNOWN".',
      "- image_url: this listing's photo, copied VERBATIM from the provided IMAGES list — match on the image's \"for link\" (same detail page as the listing) first, then on its alt text. null when no image clearly belongs to this listing. Never invent or modify an image URL, and never reuse one image for several listings unless the page truly shares it.",
      `- At most ${this.maxListings} listings. If the page shows more, keep the first ${this.maxListings} in page order.`,
    ].join('\n');
  }

  async extract(sourceName: string, sourceUrl: string, page: FetchedPage): Promise<ExtractedListing[]> {
    if (!this.live) {
      throw new Error('ANTHROPIC_API_KEY is not set — extraction disabled');
    }
    const linkList = page.links.map((l) => `${l.url}${l.text ? ` — ${l.text}` : ''}`).join('\n');
    const imageList = (page.images ?? [])
      .map(
        (i) =>
          `${i.url}${i.alt ? ` — alt: ${i.alt}` : ''}${i.forLink ? ` — for link: ${i.forLink}` : ''}`,
      )
      .join('\n');
    const userContent =
      `SOURCE: ${sourceName}\nINDEX PAGE: ${sourceUrl}\n\n` +
      `PAGE TEXT:\n${page.text}\n\n` +
      `LINKS ON PAGE (for detail URLs and stable keys):\n${linkList}` +
      (imageList ? `\n\nIMAGES ON PAGE (for image_url):\n${imageList}` : '');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        temperature: 0,
        system: this.systemPrompt(),
        messages: [{ role: 'user', content: userContent }],
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`extraction API error HTTP ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      stop_reason?: string;
    };
    const textBlock = data.content?.find((c) => c.type === 'text')?.text ?? '';
    const listings = this.parse(textBlock);
    if (data.stop_reason === 'max_tokens') {
      this.logger.warn(
        `${sourceName}: extraction hit the output cap — page may list more bikes than were returned`,
      );
    }
    return listings;
  }

  /** Parse + validate the model's JSON. Invalid rows are dropped, never fatal. */
  private parse(raw: string): ExtractedListing[] {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new Error('extraction returned no JSON object');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      throw new Error('extraction returned invalid JSON');
    }
    const rows = (parsed as { listings?: unknown }).listings;
    if (!Array.isArray(rows)) {
      throw new Error('extraction JSON has no "listings" array');
    }

    const out: ExtractedListing[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const key = typeof r.key === 'string' ? r.key.trim().slice(0, 300) : '';
      const title = typeof r.title === 'string' ? r.title.trim().slice(0, 200) : '';
      if (!key || !title || seen.has(key)) continue;
      seen.add(key);

      const num = (v: unknown): number | null => {
        const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
      };
      const year = num(r.year);
      const priceZar = num(r.price_zar);
      const odoKm = num(r.odo_km);
      const condition =
        r.condition === 'NEW'
          ? BikeCondition.NEW
          : r.condition === 'USED'
            ? BikeCondition.USED
            : null;
      const availability =
        r.availability === 'IN_STOCK'
          ? ListingAvailability.IN_STOCK
          : r.availability === 'OUT_OF_STOCK'
            ? ListingAvailability.OUT_OF_STOCK
            : r.availability === 'SOLD'
              ? ListingAvailability.SOLD
              : ListingAvailability.UNKNOWN;

      out.push({
        externalKey: key,
        title,
        url: typeof r.url === 'string' && /^https?:\/\//.test(r.url) ? r.url.slice(0, 500) : null,
        make: typeof r.make === 'string' && r.make.trim() ? r.make.trim().slice(0, 60) : null,
        model: typeof r.model === 'string' && r.model.trim() ? r.model.trim().slice(0, 80) : null,
        year: year && year >= 1950 && year <= 2100 ? year : null,
        priceCents: priceZar !== null && priceZar > 0 ? priceZar * 100 : null,
        odoKm,
        condition,
        availability,
        imageUrl:
          typeof r.image_url === 'string' && /^https?:\/\//.test(r.image_url)
            ? r.image_url.slice(0, 500)
            : null,
      });
      if (out.length >= this.maxListings) break;
    }
    return out;
  }
}
