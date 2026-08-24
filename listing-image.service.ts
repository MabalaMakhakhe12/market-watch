import { Injectable, Logger } from '@nestjs/common';
import { StorageService } from '../documents/storage.service';
import { PageFetcherService } from './page-fetcher.service';
import { IMAGE_EXTENSIONS, IMAGE_URL_TTL_SECONDS } from './market-watch.constants';

/**
 * Listing photos for Market Watch. Photos are DOWNLOADED into our own object
 * storage (same bucket as bike photos), never hotlinked: a hotlink breaks the
 * moment the dealer delists the bike, leaks staff traffic to the source CDN,
 * and can be blocked wholesale. The stored copy is internal, staff-dashboard
 * material only — not for public MBB pages (the photos are the dealers').
 */
@Injectable()
export class ListingImageService {
  private readonly logger = new Logger(ListingImageService.name);

  constructor(
    private readonly fetcher: PageFetcherService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Download one listing's photo and store it under a per-listing key.
   * Returns the storage key, or null on any failure — a photo is garnish,
   * never a reason to fail a scan; the caller leaves imageStorageKey null
   * and the next scan retries.
   */
  async capture(listingId: string, imageUrl: string): Promise<string | null> {
    try {
      const img = await this.fetcher.fetchImage(imageUrl);
      const ext = IMAGE_EXTENSIONS[img.contentType] ?? 'jpg';
      const key = `market-watch/${listingId}.${ext}`;
      await this.storage.putObject(key, img.data, img.contentType);
      return key;
    } catch (err) {
      this.logger.warn(
        `listing ${listingId}: photo download failed (${imageUrl}) — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Best-effort delete of a stored photo (replaced, or source removed). */
  async remove(storageKey: string): Promise<void> {
    try {
      await this.storage.deleteObject(storageKey);
    } catch (err) {
      this.logger.warn(
        `could not delete stored photo ${storageKey} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Presigned URL for the staff dashboard (marketing-grade TTL). */
  async downloadUrl(storageKey: string): Promise<string> {
    return this.storage.presignDownload(storageKey, IMAGE_URL_TTL_SECONDS);
  }
}
