/**
 * Market Watch — the deterministic core, tested without network or DB:
 * page-text cleaning, link harvesting, extraction parsing/validation, model
 * matching, the implied-dealer-cost inversion, and the diff engine's two
 * riskiest rules (baseline silence; removal only after consecutive misses).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PageFetcherService } from './page-fetcher.service';
import { ListingExtractorService } from './listing-extractor.service';
import { ListingImageService } from './listing-image.service';
import { MarketWatchService } from './market-watch.service';
import { REMOVED_AFTER_MISSES } from './market-watch.constants';
import { COMMISSION_RATE } from '../calculator/buyback-engine';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../common/services/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { ConfigService } from '@nestjs/config';

const CONFIG = {
  get: (key: string) =>
    ((
      {
        adminEmail: 'admin@test.local',
        'marketWatch.adminWhatsapp': '',
        'marketWatch.autoApply': true,
        'marketWatch.maxAutoPriceDeltaPct': 20,
        'anthropic.apiKey': 'test-key',
        'anthropic.model': 'claude-haiku-4-5',
        'marketWatch.maxListingsPerSource': 150,
      }
    ) as Record<string, unknown>)[key],
} as unknown as ConfigService;

function fetcher(): PageFetcherService {
  return new PageFetcherService();
}

/** Photo pipeline stub: records calls; each capture "succeeds" with the next
 *  scripted key (the last one repeats), or fails (null) when none are given. */
function imagesStub(opts?: { keys?: string[] }) {
  const captured: { listingId: string; imageUrl: string }[] = [];
  const removed: string[] = [];
  return {
    captured,
    removed,
    capture: async (listingId: string, imageUrl: string) => {
      captured.push({ listingId, imageUrl });
      const k = opts?.keys;
      if (!k || k.length === 0) return null;
      return k.length > 1 ? k.shift()! : k[0];
    },
    remove: async (storageKey: string) => {
      removed.push(storageKey);
    },
    downloadUrl: async (storageKey: string) => `https://signed.example/${storageKey}`,
  } as unknown as ListingImageService & {
    captured: { listingId: string; imageUrl: string }[];
    removed: string[];
  };
}

describe('page fetcher — HTML to text', () => {
  it('drops script/style, keeps block structure, decodes entities', () => {
    const html = `<html><head><style>.x{color:red}</style><script>var a=1;</script></head>
      <body><h1>Yamaha T&eacute;n&eacute;r&eacute; 700</h1>
      <div>R 189&nbsp;999</div><li>2021 &amp; 44&#8201;000 km</li></body></html>`;
    const text = fetcher().toText(html);
    assert.ok(!text.includes('color:red'), 'style content must not leak into the text');
    assert.ok(!text.includes('var a=1'), 'script content must not leak into the text');
    assert.ok(text.includes('Ténéré 700'));
    assert.ok(text.includes('R 189 999'));
    // h1, div and li are separate blocks — the price stays on its own line.
    assert.ok(text.split('\n').length >= 3);
  });

  it('harvests same-host links as absolute URLs and ignores the rest', () => {
    const html = `<a href="/bikes/tenere-700-2021">2021 Ténéré 700</a>
      <a href="https://other-site.example/x">elsewhere</a>
      <a href="mailto:x@y.z">mail</a>
      <a href="#top">top</a>
      <a href="/bikes/tenere-700-2021">duplicate</a>`;
    const links = fetcher().extractLinks(html, 'https://dealer.example/stock');
    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'https://dealer.example/bikes/tenere-700-2021');
    assert.equal(links[0].text, '2021 Ténéré 700');
  });

  it('harvests images with alt + wrapping anchor, prefers lazy-load src, allows CDN hosts', () => {
    const html = `
      <a href="/bikes/tenere-700-2021">
        <img src="/placeholder.gif" data-src="https://cdn.example/photos/123.jpg" alt="2021 Yamaha T&eacute;n&eacute;r&eacute; 700">
      </a>
      <img src="/banner.png" alt="Sale banner">
      <img src="data:image/gif;base64,AAAA" alt="inline junk">
      <img src="https://cdn.example/photos/123.jpg" alt="duplicate">`;
    const images = fetcher().extractImages(html, 'https://dealer.example/stock');
    assert.equal(images.length, 2, 'data: URIs and duplicates are dropped');
    assert.equal(images[0].url, 'https://cdn.example/photos/123.jpg', 'data-src beats the placeholder src');
    assert.equal(images[0].alt, '2021 Yamaha Ténéré 700');
    assert.equal(
      images[0].forLink,
      'https://dealer.example/bikes/tenere-700-2021',
      'the wrapping anchor ties the photo to its listing',
    );
    assert.equal(images[1].url, 'https://dealer.example/banner.png');
    assert.equal(images[1].forLink, null);
  });
});

describe('extraction parsing', () => {
  const svc = new ListingExtractorService(CONFIG);
  const parse = (raw: string) =>
    (svc as unknown as { parse: (raw: string) => unknown[] }).parse(raw);

  it('parses valid listings, converts rand to cents, maps enums', () => {
    const rows = parse(
      JSON.stringify({
        listings: [
          {
            key: '/bikes/tenere-700-2021',
            title: '2021 Yamaha Ténéré 700',
            url: 'https://dealer.example/bikes/tenere-700-2021',
            make: 'Yamaha',
            model: 'Ténéré 700',
            year: 2021,
            price_zar: 172950,
            odo_km: 44000,
            condition: 'USED',
            availability: 'IN_STOCK',
            image_url: 'https://cdn.example/photos/123.jpg',
          },
        ],
      }),
    ) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].priceCents, 17_295_000);
    assert.equal(rows[0].condition, 'USED');
    assert.equal(rows[0].availability, 'IN_STOCK');
    assert.equal(rows[0].imageUrl, 'https://cdn.example/photos/123.jpg');
  });

  it('nulls a non-URL image_url instead of trusting it', () => {
    const rows = parse(
      JSON.stringify({
        listings: [{ key: 'a', title: 'Bike A', image_url: 'photos/123.jpg' }],
      }),
    ) as Record<string, unknown>[];
    assert.equal(rows[0].imageUrl, null, 'a relative or invented path is noise, not data');
  });

  it('survives fenced output, drops keyless/duplicate rows, nulls bad values', () => {
    const rows = parse(
      '```json\n' +
        JSON.stringify({
          listings: [
            { key: 'a', title: 'Bike A', year: 1890, price_zar: -5, availability: 'nonsense' },
            { key: 'a', title: 'duplicate of A' },
            { title: 'no key at all' },
          ],
        }) +
        '\n```',
    ) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].year, null, 'a 19th-century year is noise, not data');
    assert.equal(rows[0].priceCents, null, 'a negative price is noise, not data');
    assert.equal(rows[0].availability, 'UNKNOWN');
  });

  it('rejects non-JSON output loudly', () => {
    assert.throws(() => parse('Sorry, I could not find any listings.'));
  });
});

function marketWatch(prisma: unknown, images?: ListingImageService): MarketWatchService {
  return new MarketWatchService(
    prisma as PrismaService,
    { record: async () => undefined } as unknown as AuditService,
    { enqueue: async () => undefined } as unknown as NotificationsService,
    fetcher(),
    new ListingExtractorService(CONFIG),
    images ?? imagesStub(),
    CONFIG,
  );
}

describe('preview (dry run)', () => {
  it('reports an unreadable page as a structured failure, never a thrown error', async () => {
    const svc = marketWatch({});
    // Stand in a fetcher that fails the way a blocked or dead site does.
    (svc as unknown as { fetcher: unknown }).fetcher = {
      fetchPage: async () => {
        throw new Error('HTTP 403 Forbidden');
      },
    };
    const out = await svc.preview('https://example.com/stock');
    assert.equal(out.ok, false);
    assert.equal(out.error, 'HTTP 403 Forbidden');
    assert.equal(out.url, 'https://example.com/stock');
  });

  it('says so plainly when the page is readable but no API key is configured', async () => {
    const noKeyConfig = {
      get: (key: string) => (key === 'anthropic.apiKey' ? '' : (CONFIG.get as (k: string) => unknown)(key)),
    } as unknown as ConfigService;
    const svc = new MarketWatchService(
      {} as PrismaService,
      { record: async () => undefined } as unknown as AuditService,
      { enqueue: async () => undefined } as unknown as NotificationsService,
      fetcher(),
      new ListingExtractorService(noKeyConfig),
      imagesStub(),
      noKeyConfig,
    );
    (svc as unknown as { fetcher: unknown }).fetcher = {
      fetchPage: async () => ({ text: 'a page of bikes', links: [], htmlChars: 5000 }),
    };
    const out = await svc.preview('https://example.com/stock');
    assert.equal(out.ok, false);
    assert.match(String(out.error), /ANTHROPIC_API_KEY/);
    assert.equal(out.pageTextChars, 'a page of bikes'.length, 'the fetch result is still reported');
  });

  it('ranks candidate pages and recommends the most catalogue-ready one', async () => {
    const svc = marketWatch({});
    const pages: Record<string, Partial<Awaited<ReturnType<MarketWatchService['preview']>>>> = {
      'https://a.example/landing': { ok: true, listingsFound: 0, withPrice: 0, catalogueReady: 0, pageTextChars: 4000, htmlChars: 40_000 },
      'https://b.example/stock': { ok: true, listingsFound: 20, withPrice: 20, matchingCatalogueModel: 4, catalogueReady: 2, pageTextChars: 30_000, htmlChars: 200_000 },
      'https://c.example/finder': { ok: true, listingsFound: 30, withPrice: 30, matchingCatalogueModel: 9, catalogueReady: 7, pageTextChars: 40_000, htmlChars: 260_000 },
      'https://d.example/dead': { ok: false, error: 'HTTP 500' },
    };
    (svc as unknown as { preview: unknown }).preview = async (url: string) => ({ url, ...pages[url] });

    const out = await svc.previewMany(Object.keys(pages));
    assert.equal(out.compared, 4);
    // c wins on catalogue-ready listings even though b also reads cleanly.
    assert.equal(out.recommended, 'https://c.example/finder');
    assert.equal(out.results[0].url, 'https://c.example/finder');
    assert.equal(out.results[out.results.length - 1].url, 'https://d.example/dead', 'a page that errored ranks last');
    assert.match(out.results[out.results.length - 1].note, /Could not read this page/);
  });

  it('says none are usable rather than recommending a page with no listings', async () => {
    const svc = marketWatch({});
    (svc as unknown as { preview: unknown }).preview = async (url: string) => ({
      ok: true,
      url,
      listingsFound: 0,
      withPrice: 0,
      catalogueReady: 0,
      pageTextChars: 200,
      htmlChars: 90_000, // lots of markup, no text => JavaScript-rendered
    });
    const out = await svc.previewMany(['https://a.example/x', 'https://b.example/y']);
    assert.equal(out.recommended, null);
    assert.match(out.verdict, /None of these pages/);
    assert.match(out.results[0].note, /JavaScript-rendered/);
  });
});

describe('catalogue model matching', () => {
  const svc = marketWatch({});
  const match = (
    models: { id: string; make: string; model: string }[],
    make: string | null,
    model: string | null,
  ) =>
    (
      svc as unknown as {
        matchModel: (m: unknown, a: string | null, b: string | null) => string | null;
      }
    ).matchModel(models, make, model);

  const MODELS = [
    { id: 't7', make: 'Yamaha', model: 'Ténéré 700' },
    { id: 't7wr', make: 'Yamaha', model: 'Ténéré 700 World Raid' },
    { id: 'gs', make: 'BMW', model: 'R 1250 GS' },
  ];

  it('prefers the exact model over a contains-match', () => {
    assert.equal(match(MODELS, 'Yamaha', 'Tenere 700'), 't7');
  });

  it('takes the LONGEST partial so a variant maps to its own row', () => {
    assert.equal(match(MODELS, 'Yamaha', 'Ténéré 700 World Raid Special'), 't7wr');
  });

  it('never crosses makes and never matches on nothing', () => {
    assert.equal(match(MODELS, 'Honda', 'Ténéré 700'), null);
    assert.equal(match(MODELS, null, 'Ténéré 700'), null);
    assert.equal(match(MODELS, 'Yamaha', null), null);
  });
});

describe('implied dealer cost', () => {
  it('inverts the commission so our derived retail equals the observed price', () => {
    const svc = marketWatch({});
    const implied = (
      svc as unknown as { impliedDealerCostCents: (c: number) => number }
    ).impliedDealerCostCents(24_995_000);
    // dealerCost × (1 + commission) must land back on the advertised price
    // to within rounding — that is the whole point of the inversion.
    assert.ok(Math.abs(implied * (1 + COMMISSION_RATE) - 24_995_000) < 100);
  });
});

// ── The diff engine's two riskiest rules ──

interface StoredListing {
  id: string;
  sourceId: string;
  externalKey: string;
  title: string;
  url: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  priceCents: number | null;
  odoKm: number | null;
  condition: null;
  availability: string;
  bikeModelId: string | null;
  linkedUsedExampleId: string | null;
  missedScans: number;
  isActive: boolean;
  pageNo?: number | null;
  imageUrl?: string | null;
  imageStorageKey?: string | null;
}

/** Minimal in-memory Prisma covering exactly what diffSource touches when
 *  listings map to no catalogue model (the NONE apply path). */
function inMemoryPrisma(listings: StoredListing[]) {
  let seq = 0;
  const changes: { type: string; listingId: string }[] = [];
  return {
    changes,
    listings,
    bikeModel: { findMany: async () => [] },
    watchedListing: {
      findMany: async () => listings.map((l) => ({ ...l })),
      create: async ({ data }: { data: Partial<StoredListing> }) => {
        const row = {
          missedScans: 0,
          isActive: true,
          linkedUsedExampleId: null,
          ...data,
          id: `L${++seq}`,
        } as StoredListing;
        listings.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<StoredListing> }) => {
        const row = listings.find((l) => l.id === where.id);
        if (!row) throw new Error(`no listing ${where.id}`);
        Object.assign(row, data);
        return { ...row };
      },
    },
    listingChange: {
      create: async ({ data }: { data: { type: string; listingId: string } }) => {
        changes.push({ type: data.type, listingId: data.listingId });
        return { ...data, id: `C${changes.length}` };
      },
    },
  };
}

const SOURCE = (baselineDone: boolean) => ({
  id: 'S1',
  name: 'Test Dealer',
  url: 'https://dealer.example/stock',
  baselineDone,
  lastScanListings: null,
});

const EXTRACTED = (key: string) => ({
  externalKey: key,
  title: `Bike ${key}`,
  url: null,
  make: null,
  model: null,
  year: null,
  priceCents: 10_000_00,
  odoKm: null,
  condition: null,
  availability: 'UNKNOWN' as const,
  imageUrl: null,
});

function diff(svc: MarketWatchService, source: unknown, extracted: unknown[]): Promise<{
  baseline: boolean;
  added: number;
  removed: number;
}> {
  return (
    svc as unknown as {
      diffSource: (s: unknown, e: unknown[], m: unknown[], c: string[]) => Promise<{
        baseline: boolean;
        added: number;
        removed: number;
      }>;
    }
  ).diffSource(source, extracted, [], []);
}

describe('diff engine', () => {
  it('the first scan is a silent baseline — recorded, never reported', async () => {
    const prisma = inMemoryPrisma([]);
    const summary = await diff(marketWatch(prisma), SOURCE(false), [
      EXTRACTED('/a'),
      EXTRACTED('/b'),
    ]);
    assert.equal(summary.baseline, true);
    assert.equal(summary.added, 0, 'baseline listings are not "added" news');
    assert.equal(prisma.changes.length, 0, 'baseline must create no change events');
    assert.equal(prisma.listings.length, 2, 'but the snapshot itself is captured');
  });

  it('after the baseline, a new listing IS news', async () => {
    const prisma = inMemoryPrisma([]);
    const svc = marketWatch(prisma);
    await diff(svc, SOURCE(false), [EXTRACTED('/a')]);
    const summary = await diff(svc, SOURCE(true), [EXTRACTED('/a'), EXTRACTED('/new')]);
    assert.equal(summary.added, 1);
    assert.deepEqual(prisma.changes.map((c) => c.type), ['ADDED']);
  });

  it(`a listing is only declared gone after ${REMOVED_AFTER_MISSES} consecutive misses`, async () => {
    const prisma = inMemoryPrisma([]);
    const svc = marketWatch(prisma);
    await diff(svc, SOURCE(false), [EXTRACTED('/a'), EXTRACTED('/b')]);

    // First miss: tolerated (transient extraction hiccups must not fire "sold").
    let summary = await diff(svc, SOURCE(true), [EXTRACTED('/a')]);
    assert.equal(summary.removed, 0);
    assert.equal(prisma.changes.length, 0);
    const b = prisma.listings.find((l) => l.externalKey === '/b')!;
    assert.equal(b.missedScans, 1);
    assert.equal(b.isActive, true);

    // Second consecutive miss: now it is genuinely gone.
    summary = await diff(svc, SOURCE(true), [EXTRACTED('/a')]);
    assert.equal(summary.removed, 1);
    assert.deepEqual(prisma.changes.map((c) => c.type), ['REMOVED']);
    assert.equal(b.isActive, false);

    // And a gone listing does not get re-reported on the next scan.
    summary = await diff(svc, SOURCE(true), [EXTRACTED('/a')]);
    assert.equal(summary.removed, 0);
    assert.equal(prisma.changes.length, 1);
  });

  it('a reappearing listing is reported as re-listed and reactivated', async () => {
    const prisma = inMemoryPrisma([]);
    const svc = marketWatch(prisma);
    await diff(svc, SOURCE(false), [EXTRACTED('/a'), EXTRACTED('/b')]);
    await diff(svc, SOURCE(true), [EXTRACTED('/a')]);
    await diff(svc, SOURCE(true), [EXTRACTED('/a')]); // /b now REMOVED

    const summary = await diff(svc, SOURCE(true), [EXTRACTED('/a'), EXTRACTED('/b')]);
    assert.equal(summary.added, 1, 're-listing counts as an addition');
    const b = prisma.listings.find((l) => l.externalKey === '/b')!;
    assert.equal(b.isActive, true);
    assert.equal(b.missedScans, 0);
  });

  it('a re-baseline silently absorbs pre-existing rows — price moves and disappearances are not news', async () => {
    const prisma = inMemoryPrisma([]);
    const svc = marketWatch(prisma);
    // Normal life: a baseline with two listings.
    await diff(svc, SOURCE(false), [EXTRACTED('/a'), EXTRACTED('/b')]);
    // Staff change the source URL → baselineDone resets. The new page happens
    // to share key /a (at a different price) and does not carry /b at all.
    const moved = { ...EXTRACTED('/a'), priceCents: 20_000_00 };
    const summary = await diff(svc, SOURCE(false), [moved]);
    assert.equal(summary.baseline, true);
    assert.equal(prisma.changes.length, 0, 're-baseline must create no change events');
    const a = prisma.listings.find((l) => l.externalKey === '/a')!;
    assert.equal(a.priceCents, 20_000_00, 'the snapshot absorbs the new price silently');
    const b = prisma.listings.find((l) => l.externalKey === '/b')!;
    assert.equal(b.isActive, false, 'rows missing from the new truth are silently deactivated');

    // The next real scan diffs against the new truth — nothing to report.
    const after = await diff(svc, SOURCE(true), [moved]);
    assert.equal(after.removed, 0);
    assert.equal(prisma.changes.length, 0);
  });
});

// ── Listing photos: download-and-store, never hotlink ──

describe('listing photos', () => {
  const WITH_PHOTO = (key: string, imageUrl: string) => ({ ...EXTRACTED(key), imageUrl });

  it('a new listing with a photo gets it downloaded and the storage key persisted', async () => {
    const prisma = inMemoryPrisma([]);
    const images = imagesStub({ keys: ['market-watch/L1.jpg'] });
    await diff(marketWatch(prisma, images), SOURCE(false), [
      WITH_PHOTO('/a', 'https://cdn.example/a.jpg'),
    ]);
    assert.deepEqual(images.captured, [{ listingId: 'L1', imageUrl: 'https://cdn.example/a.jpg' }]);
    const row = prisma.listings[0];
    assert.equal(row.imageUrl, 'https://cdn.example/a.jpg');
    assert.equal(row.imageStorageKey, 'market-watch/L1.jpg');
    assert.equal(prisma.changes.length, 0, 'a photo is snapshot data, never a change event');
  });

  it('an unchanged photo is never re-downloaded; a failed one is retried next scan', async () => {
    const prisma = inMemoryPrisma([]);
    const failing = imagesStub(); // no keys scripted -> every download fails
    const svc = marketWatch(prisma, failing);
    await diff(svc, SOURCE(false), [WITH_PHOTO('/a', 'https://cdn.example/a.jpg')]);
    assert.equal(prisma.listings[0].imageStorageKey, undefined, 'failure leaves no key');

    // Next scan, same URL: still no stored copy -> retried. Once stored,
    // later scans with the same URL cost nothing.
    const working = imagesStub({ keys: ['market-watch/L1.jpg'] });
    (svc as unknown as { images: unknown }).images = working;
    await diff(svc, SOURCE(true), [WITH_PHOTO('/a', 'https://cdn.example/a.jpg')]);
    assert.equal(working.captured.length, 1, 'the failed download is retried');
    await diff(svc, SOURCE(true), [WITH_PHOTO('/a', 'https://cdn.example/a.jpg')]);
    assert.equal(working.captured.length, 1, 'a current stored copy is not re-downloaded');
  });

  it('a moved photo URL is re-downloaded and a superseded key is deleted', async () => {
    const prisma = inMemoryPrisma([]);
    const images = imagesStub({ keys: ['market-watch/L1.jpg', 'market-watch/L1.webp'] });
    const svc = marketWatch(prisma, images);
    await diff(svc, SOURCE(false), [WITH_PHOTO('/a', 'https://cdn.example/a.jpg')]);
    await diff(svc, SOURCE(true), [WITH_PHOTO('/a', 'https://cdn.example/a-new.webp')]);
    assert.equal(images.captured.length, 2);
    assert.equal(prisma.listings[0].imageStorageKey, 'market-watch/L1.webp');
    assert.deepEqual(images.removed, ['market-watch/L1.jpg'], 'the orphaned old object is dropped');
  });
});

// ── Pagination: templates, the crawl, and hash-skips ──

describe('pagination crawl', () => {
  type PageReq = { url: string; opts?: { method?: string; body?: string } } | null;
  const build = (source: { url: string; pageTemplate: string | null }, pageNo: number): PageReq =>
    (
      marketWatch(inMemoryPrisma([])) as unknown as {
        buildPageRequest: (s: unknown, n: number) => PageReq;
      }
    ).buildPageRequest(source, pageNo);

  it('no template: page 1 is the url, page 2 does not exist', () => {
    assert.deepEqual(build({ url: 'https://d.example/stock', pageTemplate: null }, 1), {
      url: 'https://d.example/stock',
    });
    assert.equal(build({ url: 'https://d.example/stock', pageTemplate: null }, 2), null);
  });

  it('a URL template counts {page} from 1', () => {
    assert.deepEqual(
      build(
        { url: 'https://d.example/stock', pageTemplate: 'https://d.example/stock?page={page}' },
        3,
      ),
      { url: 'https://d.example/stock?page=3' },
    );
  });

  it('a POST template fills {offset:N} as (page-1)·N into the form body', () => {
    const r = build(
      {
        url: 'https://d.example/stock',
        pageTemplate: 'POST https://d.example/getData.php page={offset:10}&orderby=',
      },
      3,
    )!;
    assert.equal(r.url, 'https://d.example/getData.php');
    assert.equal(r.opts?.method, 'POST');
    assert.equal(r.opts?.body, 'page=20&orderby=');
  });

  /** Service wired to canned pages: fetcher resolves by POST body (or URL),
   *  extractor returns each page's scripted listings and counts its calls —
   *  the thing under test is WHICH pages cost an AI read. */
  function crawler(pages: Record<string, { text: string; listings: string[] }>) {
    const extracted: string[] = [];
    const fetcherStub = {
      fetchPage: async (url: string, opts?: { body?: string }) => {
        const key = opts?.body ?? url;
        const p = pages[key];
        if (!p) throw new Error(`no canned page for ${key}`);
        return { text: p.text, links: [], htmlChars: p.text.length + 30_000 };
      },
    };
    const extractorStub = {
      live: true,
      extract: async (_n: string, _u: string, page: { text: string }) => {
        extracted.push(page.text);
        const p = Object.values(pages).find((x) => x.text === page.text)!;
        return p.listings.map((key) => ({ ...EXTRACTED(key) }));
      },
    };
    const svc = new MarketWatchService(
      inMemoryPrisma([]) as unknown as PrismaService,
      { record: async () => undefined } as unknown as AuditService,
      { enqueue: async () => undefined } as unknown as NotificationsService,
      fetcherStub as unknown as PageFetcherService,
      extractorStub as unknown as ListingExtractorService,
      imagesStub(),
      CONFIG,
    );
    const crawl = (source: unknown) =>
      (
        svc as unknown as {
          crawlSource: (s: unknown) => Promise<{
            listings: { externalKey: string; pageNo: number }[];
            readPages: number[];
            skippedPages: number[];
            pageHashes: Record<string, string>;
          }>;
        }
      ).crawlSource(source);
    return { crawl, extracted };
  }

  it('crawls template pages, stops on repeats, and hash-skips unchanged pages next scan', async () => {
    const pages: Record<string, { text: string; listings: string[] }> = {
      'page=0&x=': { text: 'PAGE-A v1', listings: ['/a1', '/a2'] },
      'page=10&x=': { text: 'PAGE-B v1', listings: ['/b1'] },
      // The site clamps out-of-range offsets to the last page's bikes.
      'page=20&x=': { text: 'PAGE-B clamped', listings: ['/b1'] },
    };
    const { crawl, extracted } = crawler(pages);
    const source = {
      id: 'S1',
      url: 'https://d.example/stock',
      pageTemplate: 'POST https://d.example/getData.php page={offset:10}&x=',
      baselineDone: false,
      pageHashes: null,
    };

    const first = await crawl(source);
    assert.deepEqual(first.readPages, [1, 2]);
    assert.deepEqual(
      first.listings.map((l) => [l.externalKey, l.pageNo]),
      [
        ['/a1', 1],
        ['/a2', 1],
        ['/b1', 2],
      ],
    );
    assert.equal(extracted.length, 3, 'pages 1, 2 and the clamp probe were read');

    // Second scan: page 1 changed, page 2 identical → page 2 must not cost
    // an AI read, and the remembered boundary hash means the clamp probe
    // costs nothing either.
    pages['page=0&x='] = { text: 'PAGE-A v2', listings: ['/a1', '/a3'] };
    const before = extracted.length;
    const second = await crawl({ ...source, baselineDone: true, pageHashes: first.pageHashes });
    assert.deepEqual(second.readPages, [1]);
    assert.deepEqual(second.skippedPages, [2]);
    assert.equal(extracted.length - before, 1, 'only the changed page cost an AI read');
    assert.deepEqual(
      second.listings.map((l) => l.externalKey),
      ['/a1', '/a3'],
    );
  });

  it('listings on hash-skipped pages are never counted missing', async () => {
    const prisma = inMemoryPrisma([]);
    const svc = marketWatch(prisma);
    const diffPaged = (
      source: unknown,
      extracted: unknown[],
      skippedPages: number[],
    ): Promise<{ removed: number }> =>
      (
        svc as unknown as {
          diffSource: (
            s: unknown,
            e: unknown[],
            m: unknown[],
            c: string[],
            crawl?: { skippedPages: number[] },
          ) => Promise<{ removed: number }>;
        }
      ).diffSource(source, extracted, [], [], { skippedPages });

    await diffPaged(
      SOURCE(false),
      [
        { ...EXTRACTED('/a'), pageNo: 1 },
        { ...EXTRACTED('/b'), pageNo: 2 },
      ],
      [],
    );

    // Page 2 hash-skipped on three consecutive scans: /b is absent from the
    // extraction but its page was never read — no misses may accrue.
    for (let i = 0; i < 3; i++) {
      const summary = await diffPaged(SOURCE(true), [{ ...EXTRACTED('/a'), pageNo: 1 }], [2]);
      assert.equal(summary.removed, 0);
    }
    const b = prisma.listings.find((l) => l.externalKey === '/b')!;
    assert.equal(b.missedScans, 0);
    assert.equal(b.isActive, true);
    assert.equal(prisma.changes.length, 0);

    // Once page 2 IS read without /b, the normal two-miss rule applies.
    await diffPaged(SOURCE(true), [{ ...EXTRACTED('/a'), pageNo: 1 }], []);
    await diffPaged(SOURCE(true), [{ ...EXTRACTED('/a'), pageNo: 1 }], []);
    assert.equal(prisma.listings.find((l) => l.externalKey === '/b')!.isActive, false);
    assert.deepEqual(
      prisma.changes.map((c) => c.type),
      ['REMOVED'],
    );
  });

  it('a bike that drops off a page is still removed once that page settles and is skipped', async () => {
    const prisma = inMemoryPrisma([]);
    const svc = marketWatch(prisma);
    const diffPaged = (
      source: unknown,
      extracted: unknown[],
      skippedPages: number[],
    ): Promise<{ removed: number }> =>
      (
        svc as unknown as {
          diffSource: (
            s: unknown,
            e: unknown[],
            m: unknown[],
            c: string[],
            crawl?: { skippedPages: number[] },
          ) => Promise<{ removed: number }>;
        }
      ).diffSource(source, extracted, [], [], { skippedPages });

    await diffPaged(
      SOURCE(false),
      [
        { ...EXTRACTED('/a'), pageNo: 1 },
        { ...EXTRACTED('/b'), pageNo: 2 },
      ],
      [],
    );

    // The dealer pulls /b. Page 2 is read (its content changed) and /b is
    // absent: one miss, not yet news.
    await diffPaged(SOURCE(true), [{ ...EXTRACTED('/a'), pageNo: 1 }], []);
    assert.equal(prisma.listings.find((l) => l.externalKey === '/b')!.missedScans, 1);
    assert.equal(prisma.changes.length, 0);

    // Page 2 now sits at that new hash, so every later scan skips it. The
    // skip re-confirms /b is not there — it must not strand at one miss.
    const summary = await diffPaged(SOURCE(true), [{ ...EXTRACTED('/a'), pageNo: 1 }], [2]);
    assert.equal(summary.removed, 1);
    assert.equal(prisma.listings.find((l) => l.externalKey === '/b')!.isActive, false);
    assert.deepEqual(
      prisma.changes.map((c) => c.type),
      ['REMOVED'],
    );
  });
});

// ── Approval: the claim and the calendar ──

/** Minimal prisma for approveChange: one pending change, a claim whose
 *  outcome is scripted, and the catalogue rows the freshness check reads. */
function approvalPrisma(opts: {
  change: Record<string, unknown>;
  claimCount?: number;
  example?: Record<string, unknown> | null;
  listing?: Record<string, unknown> | null;
}) {
  const calls: string[] = [];
  const prisma = {
    calls,
    listingChange: {
      findUnique: async () => ({ ...opts.change }),
      updateMany: async () => {
        calls.push('claim');
        return { count: opts.claimCount ?? 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push(`detail:${String(data.appliedDetail ?? '')}`);
        return {};
      },
    },
    watchedListing: {
      findUnique: async () => (opts.listing === undefined ? null : opts.listing),
      update: async () => ({}),
    },
    bikeModelUsedExample: {
      findUnique: async () => (opts.example === undefined ? null : opts.example),
      update: async () => {
        calls.push('catalogueWrite');
        return {};
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };
  return prisma;
}

const PENDING_PRICE_CHANGE = {
  id: 'C1',
  applyStatus: 'PENDING_REVIEW',
  summary: 'price move',
  proposal: { op: 'updateUsedExample', usedExampleId: 'E1', dealerCostCents: 9_000_00 },
  oldValue: { priceCents: 10_000_00 },
};

describe('approval claim and staleness', () => {
  it('refuses a price update whose catalogue example moved since it was proposed', async () => {
    // Staff (or a newer approved change) took the example to R12 000 — the
    // queued change was diffed against R10 000 and must not regress it.
    const prisma = approvalPrisma({
      change: PENDING_PRICE_CHANGE,
      example: { id: 'E1', dealerCostCents: 12_000_00, odoKm: 30_000 },
    });
    const svc = marketWatch(prisma);
    await assert.rejects(svc.approveChange('staff1', 'C1'), /Stale change/);
    assert.ok(!prisma.calls.includes('claim'), 'freshness must be checked before the claim');
    assert.ok(!prisma.calls.includes('catalogueWrite'), 'nothing may be written');
  });

  it('refuses to re-add a bike that has since been marked sold', async () => {
    const prisma = approvalPrisma({
      change: {
        id: 'C2',
        applyStatus: 'PENDING_REVIEW',
        summary: 'added',
        proposal: {
          op: 'createUsedExample',
          bikeModelId: 'M1',
          year: 2021,
          dealerCostCents: 10_000_00,
          odoKm: 20_000,
          listingId: 'L1',
        },
      },
      listing: {
        id: 'L1',
        isActive: true,
        availability: 'SOLD',
        linkedUsedExampleId: null,
        priceCents: 10_000_00,
      },
    });
    await assert.rejects(marketWatch(prisma).approveChange('staff1', 'C2'), /sold/);
    assert.ok(!prisma.calls.includes('claim'));
  });

  it('the loser of a concurrent double-approve gets a 409 and executes nothing', async () => {
    const prisma = approvalPrisma({
      change: PENDING_PRICE_CHANGE,
      claimCount: 0, // someone else flipped it first
      example: { id: 'E1', dealerCostCents: 10_000_00, odoKm: 30_000 },
    });
    await assert.rejects(
      marketWatch(prisma).approveChange('staff1', 'C1'),
      /reviewed by someone else/,
    );
    assert.ok(prisma.calls.includes('claim'));
    assert.ok(!prisma.calls.includes('catalogueWrite'), 'a lost claim must never execute');
  });

  it('a fresh approval claims first, then writes, then records the detail', async () => {
    const prisma = approvalPrisma({
      change: PENDING_PRICE_CHANGE,
      example: { id: 'E1', dealerCostCents: 10_000_00, odoKm: 30_000 },
    });
    const result = await marketWatch(prisma).approveChange('staff1', 'C1');
    assert.equal(result.applyStatus, 'APPROVED');
    assert.match(result.appliedDetail, /catalogue used example updated/);
    assert.deepEqual(
      prisma.calls.filter((c) => c === 'claim' || c === 'catalogueWrite'),
      ['claim', 'catalogueWrite'],
      'the claim must precede the catalogue write',
    );
  });
});
