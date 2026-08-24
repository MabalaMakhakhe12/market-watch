import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActorType,
  BikeCondition,
  ChangeApplyStatus,
  ListingAvailability,
  ListingChange,
  ListingChangeType,
  Prisma,
  WatchSource,
  WatchSourceStatus,
  WatchedListing,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/services/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { COMMISSION_RATE } from '../calculator/buyback-engine';
import { FetchedPage, FetchOptions, PageFetcherService } from './page-fetcher.service';
import { ExtractedListing, ListingExtractorService } from './listing-extractor.service';
import { ListingImageService } from './listing-image.service';
import {
  INTER_IMAGE_DELAY_MS,
  INTER_PAGE_DELAY_MS,
  INTER_SOURCE_DELAY_MS,
  MAX_IMAGE_DOWNLOADS_PER_SCAN,
  MAX_USED_EXAMPLES_PER_MODEL,
  REMOVED_AFTER_MISSES,
  SUSPICIOUS_ZERO_THRESHOLD,
} from './market-watch.constants';
import { CreateWatchSourceDto } from './dto/create-watch-source.dto';
import { UpdateWatchSourceDto } from './dto/update-watch-source.dto';

/** What counts as tracked stock: still live on the site (a delisted row is
 *  deactivated by the disappearance pass) and not flagged sold / out of
 *  stock by the site itself. Sold rows stay in the table so a re-listing is
 *  still detected as one — they just leave the sourcing view. The change
 *  feed keeps the history either way. */
const IN_STOCK: Prisma.WatchedListingWhereInput = {
  isActive: true,
  availability: {
    notIn: [ListingAvailability.SOLD, ListingAvailability.OUT_OF_STOCK],
  },
};

export interface MarketWatchScanResult {
  extractionLive: boolean;
  sources: number;
  ok: number;
  failed: number;
  listingsSeen: number;
  baselines: number;
  added: number;
  removed: number;
  priceChanged: number;
  availabilityChanged: number;
  detailsChanged: number;
  autoApplied: number;
  pendingReview: number;
  notified: boolean;
}

/** Deferred catalogue write, stored on a PENDING_REVIEW change and executed
 *  verbatim when staff approve it. */
type Proposal =
  | {
      op: 'createUsedExample';
      bikeModelId: string;
      year: number;
      dealerCostCents: number;
      odoKm: number;
      listingId: string;
    }
  | { op: 'updateUsedExample'; usedExampleId: string; dealerCostCents?: number; odoKm?: number }
  | { op: 'updateNewPrice'; bikeModelId: string; year: number; dealerCostCents: number }
  | { op: 'createNewPrice'; bikeModelId: string; year: number; dealerCostCents: number };

/** What the auto-apply engine decided for one change. */
interface ApplyOutcome {
  status: ChangeApplyStatus;
  proposal?: Proposal;
  appliedDetail?: string;
}

interface CatalogModelRef {
  id: string;
  make: string;
  model: string;
}

/** Result of a dry run against one candidate page. Every field beyond
 *  `ok`/`url` is optional because how far the run got depends on where it
 *  failed — fetch, missing API key, or extraction. */
export interface PreviewResult {
  ok: boolean;
  url: string;
  tookMs?: number;
  error?: string;
  pageTextChars?: number;
  htmlChars?: number;
  sameHostLinks?: number;
  listingsFound?: number;
  withPrice?: number;
  matchingCatalogueModel?: number;
  catalogueReady?: number;
  listings?: {
    key: string;
    title: string;
    url: string | null;
    make: string | null;
    model: string | null;
    year: number | null;
    priceRand: number | null;
    odoKm: number | null;
    condition: BikeCondition | null;
    availability: ListingAvailability;
    matchesCatalogueModel: boolean;
    /** The photo the extractor paired with this listing (source-site URL —
     *  shown as a "photo found" hint only; scans download their own copy). */
    imageUrl: string | null;
  }[];
  /** Plain-language read on the result — what it means and what to do. */
  note?: string;
}

type ChangeWithContext = ListingChange & {
  listing: WatchedListing & { source: WatchSource };
};

function fmtR(cents: number): string {
  const rand = Math.round(cents / 100).toString();
  return `R${rand.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
}

function pctDelta(oldCents: number, newCents: number): number {
  return ((newCents - oldCents) / oldCents) * 100;
}

function normalize(s: string): string {
  // Fold diacritics first ("Ténéré" -> "tenere"), so an accent-free external
  // listing still matches the catalogue's accented spelling — then compare
  // on bare alphanumerics.
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Market Watch — watches the motorcycle sites staff registered, diffs each
 * scan against the stored snapshot, reports every change (email digest +
 * WhatsApp summary), and keeps the BikeModel reference catalogue in step.
 *
 * The write policy ("anything database-related, within reason"):
 *
 *  - USED listings mirror straight into BikeModelUsedExample — that table's
 *    documented purpose IS "a real second-hand listing" (year·price·odo).
 *    New listing -> example added; price/odo move -> example updated; listing
 *    sold/gone -> example removed. All linked, all audit-logged.
 *  - NEW-bike prices update BikeModelNewPrice via the implied dealer cost
 *    (advertised price ÷ (1 + COMMISSION_RATE)), keeping the derived
 *    client-facing price aligned with the observed market price.
 *  - Guardrails: price moves above MARKET_WATCH_MAX_AUTO_DELTA_PCT, brand-new
 *    model years, and additions beyond the per-model example cap queue as
 *    PENDING_REVIEW for one-click staff approval instead of auto-applying.
 *  - Never touched automatically: Bike rows (physical stock), BikeModel
 *    identity/creation, photos, quotes, contracts. A new bike needs a human.
 *  - A model whose example set staff replaced by hand stops auto-updating
 *    (the DB nulls our link) — staff ownership wins over automation.
 */
@Injectable()
export class MarketWatchService {
  private readonly logger = new Logger(MarketWatchService.name);
  private readonly adminEmail: string;
  private readonly adminWhatsapp: string;
  private readonly autoApply: boolean;
  private readonly maxDeltaPct: number;
  private readonly model: string;
  private readonly cron: string;
  private readonly maxPages: number;
  private scanning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly fetcher: PageFetcherService,
    private readonly extractor: ListingExtractorService,
    private readonly images: ListingImageService,
    config: ConfigService,
  ) {
    this.adminEmail = config.get<string>('adminEmail') ?? 'admin@motobuyback.local';
    this.adminWhatsapp = config.get<string>('marketWatch.adminWhatsapp') ?? '';
    this.autoApply = config.get<boolean>('marketWatch.autoApply') ?? false;
    this.maxDeltaPct = config.get<number>('marketWatch.maxAutoPriceDeltaPct') ?? 20;
    this.model = config.get<string>('anthropic.model') ?? 'claude-haiku-4-5';
    this.cron = config.get<string>('marketWatch.cron') ?? '45 6 * * 1,4';
    this.maxPages = config.get<number>('marketWatch.maxPages') ?? 30;
  }

  // ─────────────────────────── SCAN ───────────────────────────

  async scan(opts?: { sourceId?: string }): Promise<MarketWatchScanResult> {
    if (this.scanning) {
      throw new ConflictException('A Market Watch scan is already running');
    }
    this.scanning = true;
    try {
      return await this.runScan(opts);
    } finally {
      this.scanning = false;
    }
  }

  private async runScan(opts?: { sourceId?: string }): Promise<MarketWatchScanResult> {
    const sources = await this.prisma.watchSource.findMany({
      where: opts?.sourceId ? { id: opts.sourceId } : { status: WatchSourceStatus.ACTIVE },
      orderBy: { name: 'asc' },
    });

    const result: MarketWatchScanResult = {
      extractionLive: this.extractor.live,
      sources: sources.length,
      ok: 0,
      failed: 0,
      listingsSeen: 0,
      baselines: 0,
      added: 0,
      removed: 0,
      priceChanged: 0,
      availabilityChanged: 0,
      detailsChanged: 0,
      autoApplied: 0,
      pendingReview: 0,
      notified: false,
    };
    if (sources.length === 0) {
      this.logger.log('market watch: no sources registered — nothing to scan');
      return result;
    }

    // Catalogue refs are loaded once per scan for make+model matching.
    const models = await this.prisma.bikeModel.findMany({
      select: { id: true, make: true, model: true },
    });

    const changeIds: string[] = [];
    const failures: { name: string; error: string }[] = [];
    const baselineNotes: string[] = [];
    // Photo-download allowance for the whole scan: a huge baseline catches up
    // over the following scans instead of hammering the source CDN in one go.
    const imageBudget = { remaining: MAX_IMAGE_DOWNLOADS_PER_SCAN };

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (i > 0) await sleep(INTER_SOURCE_DELAY_MS);

      if (!this.extractor.live) {
        const error = 'ANTHROPIC_API_KEY not set — extraction disabled';
        await this.markSourceScan(source.id, false, error, null);
        failures.push({ name: source.name, error });
        result.failed++;
        continue;
      }

      try {
        const crawl = await this.crawlSource(source);

        // JS-shell heuristic: lots of HTML, almost no text, nothing found —
        // judged on the first page actually read.
        if (
          crawl.listings.length === 0 &&
          crawl.firstPage &&
          crawl.firstPage.text.length < 800 &&
          crawl.firstPage.htmlChars > 20_000
        ) {
          throw new Error(
            'page appears to be JavaScript-rendered (no readable text) — listings cannot be read from the HTML',
          );
        }
        // Listings on hash-skipped pages are still tracked stock — count
        // them, so a mostly-unchanged crawl never looks like a sold-out
        // dealer.
        const carried = crawl.skippedPages.length
          ? await this.prisma.watchedListing.count({
              where: {
                sourceId: source.id,
                isActive: true,
                pageNo: { in: crawl.skippedPages },
              },
            })
          : 0;
        const total = crawl.listings.length + carried;
        // A source that had real stock suddenly reading empty is far more
        // likely a redesign/bot-block than a sold-out dealer. Fail the scan
        // instead of mass-removing the snapshot.
        if (total === 0 && (source.lastScanListings ?? 0) > SUSPICIOUS_ZERO_THRESHOLD) {
          throw new Error(
            `0 listings extracted (previously ${source.lastScanListings}) — treated as a failed scan, no removals applied`,
          );
        }

        const summary = await this.diffSource(source, crawl.listings, models, changeIds, {
          skippedPages: crawl.skippedPages,
          imageBudget,
        });
        result.listingsSeen += total;
        result.added += summary.added;
        result.removed += summary.removed;
        result.priceChanged += summary.priceChanged;
        result.availabilityChanged += summary.availabilityChanged;
        result.detailsChanged += summary.detailsChanged;
        result.autoApplied += summary.autoApplied;
        result.pendingReview += summary.pendingReview;
        if (summary.baseline) {
          result.baselines++;
          baselineNotes.push(
            `${source.name}: baseline captured (${total} listings` +
              (crawl.readPages.length > 1 ? ` across ${crawl.readPages.length} pages)` : ')'),
          );
        }
        await this.markSourceScan(source.id, true, null, total, crawl.pageHashes);
        result.ok++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.logger.warn(`market watch: ${source.name} failed — ${error}`);
        await this.markSourceScan(source.id, false, error.slice(0, 500), null);
        failures.push({ name: source.name, error });
        result.failed++;
      }
    }

    // Report: only when there is something to say.
    if (changeIds.length > 0 || failures.length > 0 || baselineNotes.length > 0) {
      await this.report(changeIds, failures, baselineNotes, result);
      result.notified = true;
    }

    await this.audit.record({
      actorType: ActorType.SYSTEM,
      action: 'market_watch.scan',
      metadata: { ...result } as unknown as Prisma.InputJsonValue,
    });
    this.logger.log(`market watch scan: ${JSON.stringify(result)}`);
    return result;
  }

  // ─────────────────────── PAGINATION CRAWL ───────────────────────

  /** Resolve the fetch recipe for one crawl page. No template → the source
   *  is single-page (page 1 = its URL). */
  private buildPageRequest(
    source: Pick<WatchSource, 'url' | 'pageTemplate'>,
    pageNo: number,
  ): { url: string; opts?: FetchOptions } | null {
    const tpl = source.pageTemplate;
    if (!tpl) return pageNo === 1 ? { url: source.url } : null;
    const fill = (s: string) =>
      s
        .replace(/\{page\}/g, String(pageNo))
        .replace(/\{offset:(\d+)\}/g, (_, n: string) => String((pageNo - 1) * parseInt(n, 10)));
    const post = tpl.match(/^POST\s+(\S+)\s+(\S+)$/i);
    if (post) return { url: post[1], opts: { method: 'POST', body: fill(post[2]) } };
    return { url: fill(tpl) };
  }

  /**
   * Fetch a source's page(s). Cost discipline: each page's cleaned text is
   * hashed, and a page whose hash matches the last scan is NOT sent to the
   * AI — its listings are carried as seen via their stored pageNo, so a
   * quiet site costs fetches, not extractions. The crawl stops at the first
   * page that adds nothing new (sites clamp out-of-range pages to the last
   * one or serve repeats), at an empty page, or at the maxPages ceiling.
   */
  private async crawlSource(source: WatchSource): Promise<{
    listings: (ExtractedListing & { pageNo: number })[];
    firstPage: FetchedPage | null;
    readPages: number[];
    skippedPages: number[];
    pageHashes: Record<string, string>;
  }> {
    // Hashes only mean "unchanged since last scan" once a baseline exists —
    // a re-baseline (URL/template change) must read everything again.
    const prevHashes =
      source.baselineDone && source.pageHashes
        ? (source.pageHashes as Record<string, string>)
        : {};
    const listings: (ExtractedListing & { pageNo: number })[] = [];
    const seenKeys = new Set<string>();
    const scanHashes = new Set<string>();
    const readPages: number[] = [];
    const skippedPages: number[] = [];
    const pageHashes: Record<string, string> = {};
    let firstPage: FetchedPage | null = null;

    for (let pageNo = 1; pageNo <= this.maxPages; pageNo++) {
      const req = this.buildPageRequest(source, pageNo);
      if (!req) break;
      if (pageNo > 1) await sleep(INTER_PAGE_DELAY_MS);
      const page = await this.fetcher.fetchPage(req.url, req.opts);
      const hash = createHash('sha256').update(page.text).digest('hex');

      // The boundary page (clamped repeat) from last scan, unchanged: the
      // crawl is over without spending an AI read on the probe.
      if (pageNo > 1 && prevHashes['_end'] === hash) {
        pageHashes['_end'] = hash;
        break;
      }
      // Identical content to a page already seen this scan = past the end.
      if (pageNo > 1 && scanHashes.has(hash)) {
        pageHashes['_end'] = hash;
        break;
      }

      if (prevHashes[String(pageNo)] === hash) {
        skippedPages.push(pageNo);
        pageHashes[String(pageNo)] = hash;
        scanHashes.add(hash);
        // The skipped page's keys still guard the stop rule below: without
        // them, a clamped repeat page further on would look "fresh" and the
        // crawl would run on, mis-attributing its listings.
        const rows = await this.prisma.watchedListing.findMany({
          where: { sourceId: source.id, pageNo, isActive: true },
          select: { externalKey: true },
        });
        for (const r of rows) seenKeys.add(r.externalKey);
        continue;
      }

      const pageListings = await this.extractor.extract(source.name, req.url, page);
      if (pageNo === 1) firstPage = page;
      const fresh = pageListings.filter((l) => !seenKeys.has(l.externalKey));
      // Repeats-only or empty beyond page 1: the site ran out of stock pages.
      if (pageNo > 1 && fresh.length === 0) {
        pageHashes['_end'] = hash;
        break;
      }
      for (const l of fresh) {
        seenKeys.add(l.externalKey);
        listings.push({ ...l, pageNo });
      }
      readPages.push(pageNo);
      pageHashes[String(pageNo)] = hash;
      scanHashes.add(hash);
    }

    return { listings, firstPage, readPages, skippedPages, pageHashes };
  }

  private async markSourceScan(
    id: string,
    ok: boolean,
    error: string | null,
    listings: number | null,
    pageHashes?: Record<string, string>,
  ): Promise<void> {
    await this.prisma.watchSource.update({
      where: { id },
      data: {
        lastScanAt: new Date(),
        lastScanOk: ok,
        lastScanError: error,
        ...(listings !== null ? { lastScanListings: listings, baselineDone: true } : {}),
        ...(pageHashes !== undefined
          ? { pageHashes: pageHashes as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  // ─────────────────────────── DIFF ───────────────────────────

  private async diffSource(
    source: WatchSource,
    extracted: (ExtractedListing & { pageNo?: number })[],
    models: CatalogModelRef[],
    changeIds: string[],
    crawl?: { skippedPages: number[]; imageBudget?: { remaining: number } },
  ): Promise<{
    baseline: boolean;
    added: number;
    removed: number;
    priceChanged: number;
    availabilityChanged: number;
    detailsChanged: number;
    autoApplied: number;
    pendingReview: number;
  }> {
    const summary = {
      baseline: !source.baselineDone,
      added: 0,
      removed: 0,
      priceChanged: 0,
      availabilityChanged: 0,
      detailsChanged: 0,
      autoApplied: 0,
      pendingReview: 0,
    };
    const now = new Date();
    const imageBudget = crawl?.imageBudget ?? { remaining: MAX_IMAGE_DOWNLOADS_PER_SCAN };
    const existing = await this.prisma.watchedListing.findMany({
      where: { sourceId: source.id },
    });
    const byKey = new Map(existing.map((l) => [l.externalKey, l]));
    const seen = new Set<string>();

    const count = (outcome: ApplyOutcome): void => {
      if (outcome.status === ChangeApplyStatus.APPLIED) summary.autoApplied++;
      if (outcome.status === ChangeApplyStatus.PENDING_REVIEW) summary.pendingReview++;
    };

    for (const ext of extracted) {
      seen.add(ext.externalKey);
      const prev = byKey.get(ext.externalKey);

      if (!prev) {
        const created = await this.prisma.watchedListing.create({
          data: {
            sourceId: source.id,
            externalKey: ext.externalKey,
            title: ext.title,
            url: ext.url,
            make: ext.make,
            model: ext.model,
            year: ext.year,
            priceCents: ext.priceCents,
            odoKm: ext.odoKm,
            condition: ext.condition,
            availability: ext.availability,
            bikeModelId: this.matchModel(models, ext.make, ext.model),
            lastSeenAt: now,
            pageNo: ext.pageNo ?? null,
            imageUrl: ext.imageUrl ?? null,
          },
        });
        await this.syncListingImage(created, null, null, imageBudget);
        // The very first scan of a source is the baseline: record everything,
        // report nothing, write nothing to the catalogue.
        if (source.baselineDone) {
          const outcome = await this.applyAdded(created);
          const change = await this.recordChange(created, ListingChangeType.ADDED, {
            summary: `${this.describe(created)} appeared on ${source.name}`,
            newValue: this.snapshot(created),
            outcome,
          });
          changeIds.push(change.id);
          summary.added++;
          count(outcome);
        }
        continue;
      }

      // ── Existing listing: field-by-field comparison ──
      const updates: Prisma.WatchedListingUncheckedUpdateInput = {
        lastSeenAt: now,
        missedScans: 0,
        ...(ext.pageNo !== undefined ? { pageNo: ext.pageNo } : {}),
        title: ext.title,
        url: ext.url ?? prev.url,
        make: ext.make ?? prev.make,
        model: ext.model ?? prev.model,
        condition: ext.condition ?? prev.condition,
        ...(ext.imageUrl ? { imageUrl: ext.imageUrl } : {}),
      };
      if (!prev.bikeModelId) {
        updates.bikeModelId = this.matchModel(models, ext.make ?? prev.make, ext.model ?? prev.model);
      }
      const reactivated = !prev.isActive;
      if (reactivated) updates.isActive = true;

      const priceChanged =
        ext.priceCents !== null && prev.priceCents !== null && ext.priceCents !== prev.priceCents;
      const priceAppeared = ext.priceCents !== null && prev.priceCents === null;
      if (ext.priceCents !== null) updates.priceCents = ext.priceCents;

      const availabilityChanged =
        ext.availability !== ListingAvailability.UNKNOWN &&
        ext.availability !== prev.availability;
      if (ext.availability !== ListingAvailability.UNKNOWN) {
        updates.availability = ext.availability;
      }

      const odoChanged = ext.odoKm !== null && prev.odoKm !== null && ext.odoKm !== prev.odoKm;
      const yearChanged = ext.year !== null && prev.year !== null && ext.year !== prev.year;
      if (ext.odoKm !== null) updates.odoKm = ext.odoKm;
      if (ext.year !== null) updates.year = ext.year;

      const updated = await this.prisma.watchedListing.update({
        where: { id: prev.id },
        data: updates,
      });
      // Photos refresh silently on every path (baseline included): a photo is
      // snapshot data, not news — no ListingChange is ever raised for one.
      await this.syncListingImage(updated, prev.imageUrl, prev.imageStorageKey, imageBudget);

      // Re-baseline (URL change / retried first scan): pre-existing rows are
      // silently refreshed — the page's current contents ARE the new truth,
      // so nothing here is news and nothing may touch the catalogue.
      if (!source.baselineDone) continue;

      if (reactivated) {
        const outcome = await this.applyAdded(updated);
        const change = await this.recordChange(updated, ListingChangeType.ADDED, {
          summary: `${this.describe(updated)} re-listed on ${source.name}`,
          newValue: this.snapshot(updated),
          outcome,
        });
        changeIds.push(change.id);
        summary.added++;
        count(outcome);
        continue; // re-listing supersedes finer-grained diffs this scan
      }

      if (priceChanged) {
        const outcome = await this.applyPriceChange(updated, prev.priceCents!, ext.priceCents!);
        const delta = pctDelta(prev.priceCents!, ext.priceCents!);
        const change = await this.recordChange(updated, ListingChangeType.PRICE_CHANGED, {
          summary: `${this.describe(updated)}: ${fmtR(prev.priceCents!)} → ${fmtR(ext.priceCents!)} (${delta > 0 ? '+' : ''}${delta.toFixed(1)}%)`,
          oldValue: { priceCents: prev.priceCents },
          newValue: { priceCents: ext.priceCents },
          outcome,
        });
        changeIds.push(change.id);
        summary.priceChanged++;
        count(outcome);
      }

      if (availabilityChanged) {
        const gone =
          ext.availability === ListingAvailability.OUT_OF_STOCK ||
          ext.availability === ListingAvailability.SOLD;
        const back =
          ext.availability === ListingAvailability.IN_STOCK &&
          (prev.availability === ListingAvailability.OUT_OF_STOCK ||
            prev.availability === ListingAvailability.SOLD);
        const outcome = gone
          ? await this.applyGone(updated, 'sold / out of stock')
          : back
            ? await this.applyAdded(updated)
            : ({ status: ChangeApplyStatus.NONE } as ApplyOutcome);
        const change = await this.recordChange(updated, ListingChangeType.AVAILABILITY_CHANGED, {
          summary: `${this.describe(updated)}: ${prev.availability} → ${ext.availability}`,
          oldValue: { availability: prev.availability },
          newValue: { availability: ext.availability },
          outcome,
        });
        changeIds.push(change.id);
        summary.availabilityChanged++;
        count(outcome);
      }

      if ((odoChanged || yearChanged || priceAppeared) && !priceChanged && !availabilityChanged) {
        const outcome = await this.applyDetailsChange(updated);
        const bits: string[] = [];
        if (yearChanged) bits.push(`year ${prev.year} → ${ext.year}`);
        if (odoChanged) bits.push(`odometer ${prev.odoKm} → ${ext.odoKm} km`);
        if (priceAppeared) bits.push(`price now shown: ${fmtR(ext.priceCents!)}`);
        const change = await this.recordChange(updated, ListingChangeType.DETAILS_CHANGED, {
          summary: `${this.describe(updated)}: ${bits.join(', ')}`,
          oldValue: { year: prev.year, odoKm: prev.odoKm, priceCents: prev.priceCents },
          newValue: { year: updated.year, odoKm: updated.odoKm, priceCents: updated.priceCents },
          outcome,
        });
        changeIds.push(change.id);
        summary.detailsChanged++;
        count(outcome);
      }
    }

    // ── Disappearances ──
    for (const prev of existing) {
      if (seen.has(prev.externalKey) || !prev.isActive) continue;
      if (!source.baselineDone) {
        // Same re-baseline rule: a row absent from the new truth is absorbed
        // silently (deactivated), never reported as REMOVED or auto-applied.
        await this.prisma.watchedListing.update({
          where: { id: prev.id },
          data: { isActive: false, missedScans: 0 },
        });
        continue;
      }
      // A hash-skipped page was not read this scan, so it cannot testify
      // that its listings are gone — only pages actually read count misses.
      // That exemption holds only while the listing has a clean record. Once
      // it HAS been missed from a page that was read, pageNo is a record of
      // where it used to be, and an unchanged hash on that page is proof the
      // page still does not contain it: the skip re-confirms the absence
      // rather than excusing it. Without this, a bike that drops off a page
      // strands at one miss forever — the page settles to a new stable hash,
      // is skipped on every later scan, and the second miss never arrives.
      const skipped = crawl?.skippedPages ?? [];
      const onSkippedPage =
        prev.pageNo !== null ? skipped.includes(prev.pageNo) : skipped.length > 0;
      if (onSkippedPage && prev.missedScans === 0) continue;
      const missed = prev.missedScans + 1;
      if (missed < REMOVED_AFTER_MISSES) {
        await this.prisma.watchedListing.update({
          where: { id: prev.id },
          data: { missedScans: missed },
        });
        continue;
      }
      const updated = await this.prisma.watchedListing.update({
        where: { id: prev.id },
        data: { missedScans: missed, isActive: false },
      });
      const outcome = await this.applyGone(updated, 'no longer listed');
      const change = await this.recordChange(updated, ListingChangeType.REMOVED, {
        summary: `${this.describe(updated)} is gone from ${source.name} (sold or delisted)`,
        oldValue: this.snapshot(updated),
        outcome,
      });
      changeIds.push(change.id);
      summary.removed++;
      count(outcome);
    }

    return summary;
  }

  /**
   * Keep a listing's stored photo in step with the photo the site shows.
   * Downloads when there is no stored copy yet, or the advertised photo URL
   * moved. Bounded by the per-scan budget (missed rows retry next scan —
   * imageUrl set with no storage key IS the retry marker), throttled between
   * downloads, and never fatal: a failed photo never fails a scan.
   */
  private async syncListingImage(
    listing: WatchedListing,
    prevImageUrl: string | null,
    prevStorageKey: string | null,
    budget: { remaining: number },
  ): Promise<void> {
    if (!listing.imageUrl) return;
    const urlChanged = listing.imageUrl !== prevImageUrl;
    if (prevStorageKey && !urlChanged) return; // stored copy is current
    if (budget.remaining <= 0) return;
    budget.remaining--;
    await sleep(INTER_IMAGE_DELAY_MS);
    const key = await this.images.capture(listing.id, listing.imageUrl);
    if (!key) return;
    await this.prisma.watchedListing.update({
      where: { id: listing.id },
      data: { imageStorageKey: key },
    });
    // A jpg replaced by a webp lands on a different key — drop the orphan.
    if (prevStorageKey && prevStorageKey !== key) {
      await this.images.remove(prevStorageKey);
    }
  }

  // ─────────────────────── AUTO-APPLY ENGINE ───────────────────────

  private impliedDealerCostCents(advertisedCents: number): number {
    // The catalogue stores DEALER COST; the client-facing price is derived
    // as dealerCost × (1 + COMMISSION_RATE) and never stored. An external
    // advertised price is a market retail figure, so dividing the commission
    // back out keeps OUR derived retail aligned with the observed market.
    return Math.round(advertisedCents / (1 + COMMISSION_RATE));
  }

  /** Wraps a would-be automatic write: applies it when auto-apply is on,
   *  queues it for review when off. */
  private async applyOrQueue(
    proposal: Proposal,
    execute: () => Promise<string>,
  ): Promise<ApplyOutcome> {
    if (!this.autoApply) {
      return { status: ChangeApplyStatus.PENDING_REVIEW, proposal };
    }
    const appliedDetail = await execute();
    return { status: ChangeApplyStatus.APPLIED, appliedDetail };
  }

  /** New / re-listed / back-in-stock listing → feed the catalogue. */
  private async applyAdded(listing: WatchedListing): Promise<ApplyOutcome> {
    if (!listing.bikeModelId) {
      return { status: ChangeApplyStatus.NONE, appliedDetail: 'no matching catalogue model' };
    }

    if (
      listing.condition === BikeCondition.USED &&
      listing.year !== null &&
      listing.priceCents !== null &&
      listing.odoKm !== null
    ) {
      if (listing.linkedUsedExampleId) {
        return { status: ChangeApplyStatus.NONE, appliedDetail: 'already linked to a catalogue example' };
      }
      const proposal: Proposal = {
        op: 'createUsedExample',
        bikeModelId: listing.bikeModelId,
        year: listing.year,
        dealerCostCents: listing.priceCents,
        odoKm: listing.odoKm,
        listingId: listing.id,
      };
      const existing = await this.prisma.bikeModelUsedExample.count({
        where: { bikeModelId: listing.bikeModelId },
      });
      if (existing >= MAX_USED_EXAMPLES_PER_MODEL) {
        return { status: ChangeApplyStatus.PENDING_REVIEW, proposal };
      }
      return this.applyOrQueue(proposal, () => this.execCreateUsedExample(proposal, this.prisma));
    }

    if (
      listing.condition === BikeCondition.NEW &&
      listing.year !== null &&
      listing.priceCents !== null
    ) {
      return this.applyNewPrice(listing.bikeModelId, listing.year, listing.priceCents);
    }

    return {
      status: ChangeApplyStatus.NONE,
      appliedDetail: 'insufficient detail for the catalogue (needs year, price and odometer)',
    };
  }

  /** Price move on a known listing. */
  private async applyPriceChange(
    listing: WatchedListing,
    oldCents: number,
    newCents: number,
  ): Promise<ApplyOutcome> {
    if (!listing.bikeModelId) {
      return { status: ChangeApplyStatus.NONE, appliedDetail: 'no matching catalogue model' };
    }

    if (listing.condition === BikeCondition.USED) {
      if (!listing.linkedUsedExampleId) {
        // Staff replaced this model's example set by hand (link nulled) or the
        // listing was never mirrored — staff ownership wins, report only.
        return {
          status: ChangeApplyStatus.NONE,
          appliedDetail: 'not linked to a catalogue example (managed manually)',
        };
      }
      const proposal: Proposal = {
        op: 'updateUsedExample',
        usedExampleId: listing.linkedUsedExampleId,
        dealerCostCents: newCents,
        ...(listing.odoKm !== null ? { odoKm: listing.odoKm } : {}),
      };
      const delta = Math.abs(pctDelta(oldCents, newCents));
      if (delta > this.maxDeltaPct) {
        return { status: ChangeApplyStatus.PENDING_REVIEW, proposal };
      }
      return this.applyOrQueue(proposal, () => this.execUpdateUsedExample(proposal, this.prisma));
    }

    if (listing.condition === BikeCondition.NEW && listing.year !== null) {
      return this.applyNewPrice(listing.bikeModelId, listing.year, newCents);
    }

    return { status: ChangeApplyStatus.NONE };
  }

  /** Observed NEW-bike price → BikeModelNewPrice for that model year. */
  private async applyNewPrice(
    bikeModelId: string,
    year: number,
    advertisedCents: number,
  ): Promise<ApplyOutcome> {
    const implied = this.impliedDealerCostCents(advertisedCents);
    const row = await this.prisma.bikeModelNewPrice.findUnique({
      where: { bikeModelId_year: { bikeModelId, year } },
    });
    if (!row) {
      // A model year we don't sell yet is a structural addition — staff call.
      return {
        status: ChangeApplyStatus.PENDING_REVIEW,
        proposal: { op: 'createNewPrice', bikeModelId, year, dealerCostCents: implied },
      };
    }
    const proposal: Proposal = {
      op: 'updateNewPrice',
      bikeModelId,
      year,
      dealerCostCents: implied,
    };
    if (row.dealerCostCents === implied) {
      return { status: ChangeApplyStatus.NONE, appliedDetail: 'catalogue already matches' };
    }
    const delta = Math.abs(pctDelta(row.dealerCostCents, implied));
    if (delta > this.maxDeltaPct) {
      return { status: ChangeApplyStatus.PENDING_REVIEW, proposal };
    }
    return this.applyOrQueue(proposal, () => this.execUpdateNewPrice(proposal, this.prisma));
  }

  /** Listing sold / out of stock / delisted → retire its mirrored example. */
  private async applyGone(listing: WatchedListing, why: string): Promise<ApplyOutcome> {
    if (!listing.linkedUsedExampleId) {
      return { status: ChangeApplyStatus.NONE };
    }
    const exampleId = listing.linkedUsedExampleId;
    const example = await this.prisma.bikeModelUsedExample.findUnique({
      where: { id: exampleId },
    });
    if (!example) {
      return { status: ChangeApplyStatus.NONE };
    }
    if (!this.autoApply) {
      // No "deleteUsedExample" proposal op: a removal that needs approval is
      // rare enough that reporting it is the review. Staff can delete the row
      // in the Bike Manager.
      return {
        status: ChangeApplyStatus.NONE,
        appliedDetail: `auto-apply off — remove the ${example.year} example manually if desired`,
      };
    }
    await this.prisma.bikeModelUsedExample.delete({ where: { id: exampleId } });
    return {
      status: ChangeApplyStatus.APPLIED,
      appliedDetail: `catalogue used example removed (${example.year} · ${fmtR(example.dealerCostCents)} · ${example.odoKm.toLocaleString('en-ZA')} km) — ${why}`,
    };
  }

  /** Odometer/year corrections on a mirrored listing. */
  private async applyDetailsChange(listing: WatchedListing): Promise<ApplyOutcome> {
    if (
      listing.condition !== BikeCondition.USED ||
      !listing.linkedUsedExampleId ||
      listing.odoKm === null
    ) {
      return { status: ChangeApplyStatus.NONE };
    }
    const proposal: Proposal = {
      op: 'updateUsedExample',
      usedExampleId: listing.linkedUsedExampleId,
      odoKm: listing.odoKm,
    };
    return this.applyOrQueue(proposal, () => this.execUpdateUsedExample(proposal, this.prisma));
  }

  // ── Proposal executors (shared by auto-apply and staff approval) ──
  // Each takes the Prisma client to write through: the live client on the
  // auto-apply path, the transaction client from approveChange — so an
  // approval's claim and its catalogue write commit or roll back together.

  private async execCreateUsedExample(
    p: Extract<Proposal, { op: 'createUsedExample' }>,
    db: Prisma.TransactionClient,
  ): Promise<string> {
    const model = await db.bikeModel.findUnique({ where: { id: p.bikeModelId } });
    if (!model) throw new BadRequestException('The catalogue model no longer exists');
    const example = await db.bikeModelUsedExample.create({
      data: {
        bikeModelId: p.bikeModelId,
        year: p.year,
        dealerCostCents: p.dealerCostCents,
        odoKm: p.odoKm,
      },
    });
    await db.watchedListing
      .update({ where: { id: p.listingId }, data: { linkedUsedExampleId: example.id } })
      .catch(() => undefined); // listing may have been pruned — link is best-effort
    return `catalogue used example added to ${model.make} ${model.model}: ${p.year} · ${fmtR(p.dealerCostCents)} · ${p.odoKm.toLocaleString('en-ZA')} km`;
  }

  private async execUpdateUsedExample(
    p: Extract<Proposal, { op: 'updateUsedExample' }>,
    db: Prisma.TransactionClient,
  ): Promise<string> {
    const row = await db.bikeModelUsedExample.findUnique({
      where: { id: p.usedExampleId },
    });
    if (!row) {
      throw new BadRequestException(
        'The catalogue example no longer exists (replaced in the Bike Manager) — reject this change',
      );
    }
    await db.bikeModelUsedExample.update({
      where: { id: p.usedExampleId },
      data: {
        ...(p.dealerCostCents !== undefined ? { dealerCostCents: p.dealerCostCents } : {}),
        ...(p.odoKm !== undefined ? { odoKm: p.odoKm } : {}),
      },
    });
    const bits: string[] = [];
    if (p.dealerCostCents !== undefined) {
      bits.push(`price ${fmtR(row.dealerCostCents)} → ${fmtR(p.dealerCostCents)}`);
    }
    if (p.odoKm !== undefined && p.odoKm !== row.odoKm) {
      bits.push(`odometer ${row.odoKm.toLocaleString('en-ZA')} → ${p.odoKm.toLocaleString('en-ZA')} km`);
    }
    return `catalogue used example updated (${bits.join(', ') || 'no-op'})`;
  }

  private async execUpdateNewPrice(
    p: Extract<Proposal, { op: 'updateNewPrice' | 'createNewPrice' }>,
    db: Prisma.TransactionClient,
  ): Promise<string> {
    const model = await db.bikeModel.findUnique({ where: { id: p.bikeModelId } });
    if (!model) throw new BadRequestException('The catalogue model no longer exists');
    const before = await db.bikeModelNewPrice.findUnique({
      where: { bikeModelId_year: { bikeModelId: p.bikeModelId, year: p.year } },
    });
    await db.bikeModelNewPrice.upsert({
      where: { bikeModelId_year: { bikeModelId: p.bikeModelId, year: p.year } },
      create: { bikeModelId: p.bikeModelId, year: p.year, dealerCostCents: p.dealerCostCents },
      update: { dealerCostCents: p.dealerCostCents },
    });
    return before
      ? `catalogue new price ${model.make} ${model.model} ${p.year}: dealer cost ${fmtR(before.dealerCostCents)} → ${fmtR(p.dealerCostCents)} (implied from advertised price)`
      : `catalogue new price added for ${model.make} ${model.model} ${p.year}: dealer cost ${fmtR(p.dealerCostCents)} (implied from advertised price)`;
  }

  private async executeProposal(proposal: Proposal, db: Prisma.TransactionClient): Promise<string> {
    switch (proposal.op) {
      case 'createUsedExample':
        return this.execCreateUsedExample(proposal, db);
      case 'updateUsedExample':
        return this.execUpdateUsedExample(proposal, db);
      case 'updateNewPrice':
      case 'createNewPrice':
        return this.execUpdateNewPrice(proposal, db);
    }
  }

  /**
   * A queued proposal executes VERBATIM, so refuse it once the world has
   * moved on: an approval must never regress a price staff corrected by
   * hand, re-add a bike that has since sold, or apply an older queued move
   * over a newer one. The atomic claim in approveChange guards the race;
   * this guards the calendar. Refusals are 409s with a "reject it" hint —
   * if the difference is still real, the next scan proposes it afresh.
   */
  private async assertProposalFresh(change: ListingChange, proposal: Proposal): Promise<void> {
    const old = (change.oldValue ?? {}) as { priceCents?: unknown; odoKm?: unknown };
    const stale = (why: string): never => {
      throw new ConflictException(
        `Stale change — ${why}. Reject it; if the difference is still real, the next scan will propose it afresh.`,
      );
    };

    switch (proposal.op) {
      case 'createUsedExample': {
        const listing = await this.prisma.watchedListing.findUnique({
          where: { id: proposal.listingId },
        });
        if (!listing) return stale('the listing it came from no longer exists');
        if (!listing.isActive) return stale('the listing has since left the site');
        if (
          listing.availability === ListingAvailability.SOLD ||
          listing.availability === ListingAvailability.OUT_OF_STOCK
        ) {
          return stale('the bike has since been marked sold / out of stock');
        }
        if (listing.linkedUsedExampleId) {
          return stale('the listing is already mirrored to a catalogue example');
        }
        if (listing.priceCents !== null && listing.priceCents !== proposal.dealerCostCents) {
          return stale(`the listing price has since moved to ${fmtR(listing.priceCents)}`);
        }
        return;
      }
      case 'updateUsedExample': {
        const row = await this.prisma.bikeModelUsedExample.findUnique({
          where: { id: proposal.usedExampleId },
        });
        if (!row) return; // the executor raises the precise 400 for this
        if (
          proposal.dealerCostCents !== undefined &&
          typeof old.priceCents === 'number' &&
          row.dealerCostCents !== old.priceCents
        ) {
          return stale(
            `the catalogue example is now ${fmtR(row.dealerCostCents)}, not the ${fmtR(old.priceCents)} this change was diffed against`,
          );
        }
        if (
          proposal.dealerCostCents === undefined &&
          proposal.odoKm !== undefined &&
          typeof old.odoKm === 'number' &&
          row.odoKm !== old.odoKm
        ) {
          return stale('the catalogue example’s odometer has changed since');
        }
        return;
      }
      case 'createNewPrice': {
        const row = await this.prisma.bikeModelNewPrice.findUnique({
          where: { bikeModelId_year: { bikeModelId: proposal.bikeModelId, year: proposal.year } },
        });
        if (row) return stale('that model year has since been priced in the catalogue');
        return;
      }
      case 'updateNewPrice': {
        const row = await this.prisma.bikeModelNewPrice.findUnique({
          where: { bikeModelId_year: { bikeModelId: proposal.bikeModelId, year: proposal.year } },
        });
        if (!row) return stale('that model-year price no longer exists in the catalogue');
        if (
          typeof old.priceCents === 'number' &&
          row.dealerCostCents !== this.impliedDealerCostCents(old.priceCents)
        ) {
          return stale(
            `the catalogue dealer cost is now ${fmtR(row.dealerCostCents)} — it has moved since this change was proposed`,
          );
        }
        return;
      }
    }
  }

  // ─────────────────────── CHANGE RECORDING ───────────────────────

  private describe(l: WatchedListing): string {
    const parts = [l.year, l.make, l.model].filter(Boolean).join(' ');
    return parts || l.title;
  }

  private snapshot(l: WatchedListing): Prisma.InputJsonValue {
    return {
      title: l.title,
      url: l.url,
      make: l.make,
      model: l.model,
      year: l.year,
      priceCents: l.priceCents,
      odoKm: l.odoKm,
      condition: l.condition,
      availability: l.availability,
    };
  }

  private async recordChange(
    listing: WatchedListing,
    type: ListingChangeType,
    args: {
      summary: string;
      oldValue?: Prisma.InputJsonValue;
      newValue?: Prisma.InputJsonValue;
      outcome: ApplyOutcome;
    },
  ): Promise<ListingChange> {
    const change = await this.prisma.listingChange.create({
      data: {
        listingId: listing.id,
        type,
        summary: args.summary,
        oldValue: args.oldValue,
        newValue: args.newValue,
        applyStatus: args.outcome.status,
        proposal: args.outcome.proposal as unknown as Prisma.InputJsonValue | undefined,
        appliedDetail: args.outcome.appliedDetail,
      },
    });
    if (args.outcome.status === ChangeApplyStatus.APPLIED) {
      await this.audit.record({
        actorType: ActorType.SYSTEM,
        action: 'market_watch.auto_applied',
        entityType: 'ListingChange',
        entityId: change.id,
        metadata: { summary: args.summary, detail: args.outcome.appliedDetail ?? null },
      });
    }
    return change;
  }

  // ─────────────────────────── REPORTING ───────────────────────────

  private async report(
    changeIds: string[],
    failures: { name: string; error: string }[],
    baselineNotes: string[],
    result: MarketWatchScanResult,
  ): Promise<void> {
    const changes = (await this.prisma.listingChange.findMany({
      where: { id: { in: changeIds } },
      include: { listing: { include: { source: true } } },
      orderBy: { createdAt: 'asc' },
    })) as ChangeWithContext[];

    const body = this.buildDigest(changes, failures, baselineNotes, result);
    await this.notifications.enqueue({
      kind: 'email',
      to: this.adminEmail,
      template: 'market-watch-digest',
      data: {},
      body,
    });
    if (this.adminWhatsapp) {
      await this.notifications.enqueue({
        kind: 'whatsapp',
        to: this.adminWhatsapp,
        message: this.buildWhatsappSummary(result, failures.length),
      });
    }
    if (changeIds.length > 0) {
      await this.prisma.listingChange.updateMany({
        where: { id: { in: changeIds } },
        data: { reportedAt: new Date() },
      });
    }
  }

  private buildDigest(
    changes: ChangeWithContext[],
    failures: { name: string; error: string }[],
    baselineNotes: string[],
    result: MarketWatchScanResult,
  ): string {
    const lines: string[] = [];
    const label: Record<ListingChangeType, string> = {
      ADDED: '+ ADDED ',
      REMOVED: '- GONE  ',
      PRICE_CHANGED: '~ PRICE ',
      AVAILABILITY_CHANGED: '~ STOCK ',
      DETAILS_CHANGED: '~ DETAIL',
    };

    lines.push(
      `Scanned ${result.sources} site(s): ${result.added} added, ${result.removed} gone, ` +
        `${result.priceChanged} price move(s), ${result.availabilityChanged} stock change(s). ` +
        `${result.autoApplied} applied to the catalogue automatically, ${result.pendingReview} awaiting your approval.`,
    );

    const bySource = new Map<string, ChangeWithContext[]>();
    for (const c of changes) {
      const key = c.listing.source.name;
      bySource.set(key, [...(bySource.get(key) ?? []), c]);
    }
    for (const [sourceName, group] of bySource) {
      lines.push('');
      lines.push(`■ ${sourceName}`);
      for (const c of group) {
        const note =
          c.applyStatus === ChangeApplyStatus.APPLIED
            ? (c.appliedDetail ?? 'applied to catalogue')
            : c.applyStatus === ChangeApplyStatus.PENDING_REVIEW
              ? 'NEEDS REVIEW'
              : (c.appliedDetail ?? '');
        lines.push(`  ${label[c.type]} ${c.summary}${note ? ` — ${note}` : ''}`);
      }
    }

    const pending = changes.filter((c) => c.applyStatus === ChangeApplyStatus.PENDING_REVIEW);
    if (pending.length > 0) {
      lines.push('');
      lines.push(`NEEDS YOUR REVIEW (${pending.length}) — approve or reject in the back office:`);
      for (const c of pending) {
        lines.push(`  • [${c.id}] ${c.summary}`);
      }
      lines.push('  Review them in the back office: Staff dashboard → Market watch.');
    }

    if (failures.length > 0) {
      lines.push('');
      lines.push('SCAN ISSUES:');
      for (const f of failures) {
        lines.push(`  ✕ ${f.name} — ${f.error}`);
      }
    }

    if (baselineNotes.length > 0) {
      lines.push('');
      for (const note of baselineNotes) lines.push(`New source: ${note}.`);
      lines.push('Changes on these sites will be reported from the next scan.');
    }

    return lines.join('\n');
  }

  private buildWhatsappSummary(result: MarketWatchScanResult, failedSources: number): string {
    const bits: string[] = [];
    if (result.added) bits.push(`${result.added} added`);
    if (result.removed) bits.push(`${result.removed} gone`);
    if (result.priceChanged) bits.push(`${result.priceChanged} price move(s)`);
    if (result.availabilityChanged) bits.push(`${result.availabilityChanged} stock change(s)`);
    if (bits.length === 0) bits.push('no listing changes');
    const review = result.pendingReview ? `; ${result.pendingReview} need(s) your approval` : '';
    const failed = failedSources ? `; ${failedSources} site(s) failed to scan` : '';
    return `MBB Market Watch: ${bits.join(', ')}${review}${failed}. Details emailed.`;
  }

  // ─────────────────────── ADMIN OPERATIONS ───────────────────────

  /**
   * Dry run: fetch a page, read it, and return what was found — WITHOUT
   * storing a listing, raising a change, or touching the catalogue.
   *
   * This is how you check a candidate page before registering it (and how
   * you diagnose one that has gone quiet): it answers "can the scanner
   * actually read this page, and does it see bikes or navigation clutter?"
   * It also reports which listings would map onto catalogue models, since a
   * page full of bikes MBB has no model row for is reported but never
   * auto-applied.
   */
  /**
   * Read several candidate pages and rank them, so "which of these should we
   * watch?" is one call instead of a guess. Pages are read sequentially with
   * the same politeness delay a scan uses.
   *
   * Ranking is by catalogue-ready listings first (the fully automatable
   * case), then priced listings, then any listings at all — which is the
   * order in which a source is actually useful to the calculator.
   */
  async previewMany(urls: string[]) {
    const results: PreviewResult[] = [];
    for (let i = 0; i < urls.length; i++) {
      if (i > 0) await sleep(INTER_SOURCE_DELAY_MS);
      results.push(await this.preview(urls[i]));
    }

    const score = (r: PreviewResult) =>
      r.ok
        ? (r.catalogueReady ?? 0) * 1_000_000 + (r.withPrice ?? 0) * 1_000 + (r.listingsFound ?? 0)
        : -1;
    const ranked = [...results].sort((a, b) => score(b) - score(a));
    const winner = ranked[0];
    const usable = winner && score(winner) > 0 ? winner : undefined;

    return {
      compared: urls.length,
      recommended: usable?.url ?? null,
      verdict: usable
        ? `${usable.url} reads best: ${usable.listingsFound} listing(s), ${usable.withPrice} with a price, ${usable.catalogueReady} ready to feed the catalogue.`
        : 'None of these pages returned a usable listing. Check the per-page notes below — a page with little text is JavaScript-rendered or is a form; a page that errored could not be fetched at all.',
      results: ranked.map((r) => ({
        ...r,
        // Keep the comparison readable: the full listing dump stays on the
        // single-URL preview, which is where you go to eyeball a winner.
        listings: undefined,
        sampleListings: r.ok ? (r.listings ?? []).slice(0, 3) : undefined,
        note: this.previewNote(r),
      })),
    };
  }

  /** Plain-language read on a preview result — what it means and what to do. */
  private previewNote(r: PreviewResult): string {
    if (!r.ok) return `Could not read this page: ${r.error ?? 'unknown error'}`;
    if ((r.listingsFound ?? 0) === 0) {
      if ((r.pageTextChars ?? 0) < 800 && (r.htmlChars ?? 0) > 20_000) {
        return 'No listings: the page is JavaScript-rendered, so a plain fetch sees no text. Not usable as-is.';
      }
      return 'No listings found, but the page has readable text — likely a landing page, a search form needing query parameters, or a category index. Try the URL of an actual results page.';
    }
    if ((r.matchingCatalogueModel ?? 0) === 0) {
      return `${r.listingsFound} listing(s) read fine, but none match a model in your Bike Manager, so they would be reported and never auto-applied. Useful for market awareness; add the models to benefit the calculator.`;
    }
    return `Good source: ${r.listingsFound} listing(s), ${r.matchingCatalogueModel} matching your catalogue.`;
  }

  /** Every preview path returns with its plain-language `note` attached, so
   *  the dashboard shows the interpretation, not just the numbers. */
  private withNote(r: PreviewResult): PreviewResult {
    return { ...r, note: this.previewNote(r) };
  }

  async preview(url: string): Promise<PreviewResult> {
    const started = Date.now();
    try {
      const page = await this.fetcher.fetchPage(url);
      if (!this.extractor.live) {
        return this.withNote({
          ok: false,
          url,
          error: 'ANTHROPIC_API_KEY is not set — the page was fetched but cannot be read',
          pageTextChars: page.text.length,
          htmlChars: page.htmlChars,
          sameHostLinks: page.links.length,
        });
      }
      const listings = await this.extractor.extract('preview', url, page);
      const models = await this.prisma.bikeModel.findMany({
        select: { id: true, make: true, model: true },
      });
      const matched = listings.filter(
        (l) => this.matchModel(models, l.make, l.model) !== null,
      ).length;
      const priced = listings.filter((l) => l.priceCents !== null).length;
      // A catalogue-ready used listing is the fully automatable case:
      // year + price + odometer + a matching model.
      const catalogueReady = listings.filter(
        (l) =>
          l.condition === BikeCondition.USED &&
          l.year !== null &&
          l.priceCents !== null &&
          l.odoKm !== null &&
          this.matchModel(models, l.make, l.model) !== null,
      ).length;

      const result = this.withNote({
        ok: true,
        url,
        tookMs: Date.now() - started,
        pageTextChars: page.text.length,
        htmlChars: page.htmlChars,
        sameHostLinks: page.links.length,
        listingsFound: listings.length,
        withPrice: priced,
        matchingCatalogueModel: matched,
        catalogueReady,
        // The full set, so a staff member can eyeball whether the reading is
        // sane before this page starts feeding the calculator.
        listings: listings.map((l) => ({
          key: l.externalKey,
          title: l.title,
          url: l.url,
          make: l.make,
          model: l.model,
          year: l.year,
          priceRand: l.priceCents !== null ? l.priceCents / 100 : null,
          odoKm: l.odoKm,
          condition: l.condition,
          availability: l.availability,
          matchesCatalogueModel: this.matchModel(models, l.make, l.model) !== null,
          imageUrl: l.imageUrl,
        })),
      });
      // A page belonging to a registered paginated source: say so, or the
      // single-page count reads like the whole site.
      const registered = await this.prisma.watchSource.findUnique({ where: { url } });
      if (registered?.pageTemplate) {
        result.note =
          `${result.note ?? ''} This is ONE page of a paginated source — scans crawl all its pages` +
          (registered.lastScanListings
            ? ` (last scan: ${registered.lastScanListings} listings across the full site).`
            : '.');
      }
      return result;
    } catch (err) {
      return this.withNote({
        ok: false,
        url,
        tookMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** One call behind the staff dashboard's header strip: what mode the
   *  monitor is in and how much is waiting on a human. */
  async status() {
    const [activeSources, pendingReview] = await Promise.all([
      this.prisma.watchSource.count({ where: { status: WatchSourceStatus.ACTIVE } }),
      this.prisma.listingChange.count({
        where: { applyStatus: ChangeApplyStatus.PENDING_REVIEW },
      }),
    ]);
    return {
      extractionLive: this.extractor.live,
      autoApply: this.autoApply,
      maxAutoDeltaPct: this.maxDeltaPct,
      model: this.model,
      cron: this.cron,
      activeSources,
      pendingReview,
    };
  }

  /**
   * The full tracked snapshot: every bike currently live on the watched
   * sites, catalogue-matched or not. Unmatched bikes are the point as much
   * as matched ones — they are the sourcing view ("bikes we could add").
   */
  async listListings(opts: { sourceId?: string; limit?: number }) {
    const take = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
    const rows = await this.prisma.watchedListing.findMany({
      where: { ...IN_STOCK, ...(opts.sourceId ? { sourceId: opts.sourceId } : {}) },
      orderBy: [{ sourceId: 'asc' }, { pageNo: 'asc' }, { title: 'asc' }],
      take,
      include: { source: { select: { name: true } } },
    });
    return Promise.all(
      rows.map(async (l) => ({
        id: l.id,
        source: l.source.name,
        title: l.title,
        url: l.url,
        make: l.make,
        model: l.model,
        year: l.year,
        priceCents: l.priceCents,
        odoKm: l.odoKm,
        condition: l.condition,
        availability: l.availability,
        pageNo: l.pageNo,
        inCatalogue: l.bikeModelId !== null,
        firstSeenAt: l.firstSeenAt,
        lastSeenAt: l.lastSeenAt,
        // Only our stored copy is ever served (presigned, local crypto) —
        // never the source site's URL, so the dashboard hotlinks nothing.
        imageUrl: l.imageStorageKey ? await this.images.downloadUrl(l.imageStorageKey) : null,
      })),
    );
  }

  async listSources() {
    const sources = await this.prisma.watchSource.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { listings: { where: IN_STOCK } } } },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      status: s.status,
      notes: s.notes,
      pageTemplate: s.pageTemplate,
      activeListings: s._count.listings,
      lastScanAt: s.lastScanAt,
      lastScanOk: s.lastScanOk,
      lastScanError: s.lastScanError,
      lastScanListings: s.lastScanListings,
      baselineDone: s.baselineDone,
      createdAt: s.createdAt,
    }));
  }

  async createSource(staffId: string, dto: CreateWatchSourceDto, ip?: string) {
    const source = await this.prisma.watchSource
      .create({
        data: {
          name: dto.name,
          url: dto.url,
          notes: dto.notes,
          pageTemplate: dto.pageTemplate ?? null,
        },
      })
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException('That page is already registered as a watch source');
        }
        throw err;
      });
    await this.audit.record({
      actorType: ActorType.STAFF,
      actorId: staffId,
      action: 'market_watch.source_added',
      entityType: 'WatchSource',
      entityId: source.id,
      metadata: { name: source.name, url: source.url },
      ipAddress: ip,
    });
    return source;
  }

  async updateSource(staffId: string, id: string, dto: UpdateWatchSourceDto, ip?: string) {
    const existing = await this.prisma.watchSource.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Watch source not found');
    const source = await this.prisma.watchSource
      .update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          // A changed URL is a different page: re-baseline so the diff engine
          // doesn't read the new page as everything-added/everything-removed.
          ...(dto.url !== undefined && dto.url !== existing.url
            ? {
                url: dto.url,
                baselineDone: false,
                lastScanListings: null,
                pageHashes: Prisma.DbNull,
              }
            : {}),
          // A changed pagination recipe changes what "the whole source" means
          // (e.g. 1 page → 23 pages): re-baseline silently and re-read all.
          ...(dto.pageTemplate !== undefined &&
          (dto.pageTemplate || null) !== existing.pageTemplate
            ? {
                pageTemplate: dto.pageTemplate || null,
                baselineDone: false,
                lastScanListings: null,
                pageHashes: Prisma.DbNull,
              }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
      })
      .catch((err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException('Another watch source already covers that page');
        }
        throw err;
      });
    // A changed URL orphans the old page's snapshot rows: deactivate them so
    // the re-baseline can't diff the new page against the old one (colliding
    // keys would read as changes, and the leftovers would march to REMOVED).
    if (dto.url !== undefined && dto.url !== existing.url) {
      await this.prisma.watchedListing.updateMany({
        where: { sourceId: id, isActive: true },
        data: { isActive: false, missedScans: 0 },
      });
    }
    await this.audit.record({
      actorType: ActorType.STAFF,
      actorId: staffId,
      action: 'market_watch.source_updated',
      entityType: 'WatchSource',
      entityId: id,
      metadata: { changed: Object.keys(dto) },
      ipAddress: ip,
    });
    return source;
  }

  async removeSource(staffId: string, id: string, ip?: string) {
    const source = await this.prisma.watchSource.findUnique({ where: { id } });
    if (!source) throw new NotFoundException('Watch source not found');
    // Stored photo keys are collected BEFORE the cascade wipes the rows;
    // objects are deleted after the DB delete succeeds (best-effort — an
    // orphaned photo is storage litter, never a reason to fail the delete).
    const storedPhotos = await this.prisma.watchedListing.findMany({
      where: { sourceId: id, imageStorageKey: { not: null } },
      select: { imageStorageKey: true },
    });
    await this.prisma.watchSource.delete({ where: { id } }); // listings/changes cascade
    for (const p of storedPhotos) {
      if (p.imageStorageKey) await this.images.remove(p.imageStorageKey);
    }
    await this.audit.record({
      actorType: ActorType.STAFF,
      actorId: staffId,
      action: 'market_watch.source_removed',
      entityType: 'WatchSource',
      entityId: id,
      metadata: { name: source.name, url: source.url },
      ipAddress: ip,
    });
    return { deleted: true };
  }

  async listChanges(opts: { status?: ChangeApplyStatus; limit?: number }) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const changes = (await this.prisma.listingChange.findMany({
      where: opts.status ? { applyStatus: opts.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take,
      include: { listing: { include: { source: true } } },
    })) as ChangeWithContext[];
    return changes.map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      source: c.listing.source.name,
      listingTitle: c.listing.title,
      listingUrl: c.listing.url,
      type: c.type,
      summary: c.summary,
      oldValue: c.oldValue,
      newValue: c.newValue,
      applyStatus: c.applyStatus,
      appliedDetail: c.appliedDetail,
      proposal: c.proposal,
      reviewedAt: c.reviewedAt,
    }));
  }

  async approveChange(staffId: string, changeId: string, ip?: string) {
    const change = await this.prisma.listingChange.findUnique({ where: { id: changeId } });
    if (!change) throw new NotFoundException('Change not found');
    if (change.applyStatus !== ChangeApplyStatus.PENDING_REVIEW) {
      throw new BadRequestException(`Change is ${change.applyStatus}, not PENDING_REVIEW`);
    }
    if (!change.proposal) {
      throw new BadRequestException('Change has no stored proposal to execute');
    }
    const proposal = change.proposal as unknown as Proposal;
    await this.assertProposalFresh(change, proposal);

    // Claim, execute, and record inside one transaction: a concurrent
    // approval (double-click, two staff) finds the claim already taken and
    // gets a 409 instead of executing the proposal a second time, and an
    // execution failure rolls the claim back so the change stays reviewable.
    const appliedDetail = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.listingChange.updateMany({
        where: { id: changeId, applyStatus: ChangeApplyStatus.PENDING_REVIEW },
        data: {
          applyStatus: ChangeApplyStatus.APPROVED,
          reviewedById: staffId,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException('This change was just reviewed by someone else — refresh the queue');
      }
      const detail = await this.executeProposal(proposal, tx);
      await tx.listingChange.update({ where: { id: changeId }, data: { appliedDetail: detail } });
      return detail;
    });
    await this.audit.record({
      actorType: ActorType.STAFF,
      actorId: staffId,
      action: 'market_watch.change_approved',
      entityType: 'ListingChange',
      entityId: changeId,
      metadata: { summary: change.summary, detail: appliedDetail },
      ipAddress: ip,
    });
    return { id: changeId, applyStatus: ChangeApplyStatus.APPROVED, appliedDetail };
  }

  async rejectChange(staffId: string, changeId: string, ip?: string) {
    const change = await this.prisma.listingChange.findUnique({ where: { id: changeId } });
    if (!change) throw new NotFoundException('Change not found');
    if (change.applyStatus !== ChangeApplyStatus.PENDING_REVIEW) {
      throw new BadRequestException(`Change is ${change.applyStatus}, not PENDING_REVIEW`);
    }
    // Same claim discipline as approveChange, minus the execution step.
    const claimed = await this.prisma.listingChange.updateMany({
      where: { id: changeId, applyStatus: ChangeApplyStatus.PENDING_REVIEW },
      data: {
        applyStatus: ChangeApplyStatus.REJECTED,
        reviewedById: staffId,
        reviewedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException('This change was just reviewed by someone else — refresh the queue');
    }
    await this.audit.record({
      actorType: ActorType.STAFF,
      actorId: staffId,
      action: 'market_watch.change_rejected',
      entityType: 'ListingChange',
      entityId: changeId,
      metadata: { summary: change.summary },
      ipAddress: ip,
    });
    return { id: changeId, applyStatus: ChangeApplyStatus.REJECTED };
  }

  // ─────────────────────── MODEL MATCHING ───────────────────────

  /** Match a listing's make+model to a catalogue row. Exact (normalized)
   *  match wins; otherwise the LONGEST contains-match — so "Ténéré 700
   *  World Raid" prefers its own row over plain "Ténéré 700". */
  private matchModel(
    models: CatalogModelRef[],
    make: string | null,
    model: string | null,
  ): string | null {
    if (!make || !model) return null;
    const nMake = normalize(make);
    const nModel = normalize(model);
    if (!nMake || !nModel) return null;

    const sameMake = models.filter((m) => normalize(m.make) === nMake);
    const exact = sameMake.find((m) => normalize(m.model) === nModel);
    if (exact) return exact.id;

    const partial = sameMake
      .filter((m) => {
        const nm = normalize(m.model);
        return nm.includes(nModel) || nModel.includes(nm);
      })
      .sort((a, b) => normalize(b.model).length - normalize(a.model).length);
    return partial[0]?.id ?? null;
  }
}
