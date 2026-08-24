import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { DocumentsModule } from '../documents/documents.module';
import { MarketWatchService } from './market-watch.service';
import { PageFetcherService } from './page-fetcher.service';
import { ListingExtractorService } from './listing-extractor.service';
import { ListingImageService } from './listing-image.service';
import { MarketWatchController } from './market-watch.controller';

/**
 * Market Watch — scheduled monitoring of external motorcycle sites with
 * guardrailed catalogue updates. The scan itself is triggered by the
 * scheduler (JobsModule) or manually via /admin/jobs/market-watch/run;
 * this module owns the pipeline and the staff endpoints.
 */
@Module({
  imports: [NotificationsModule, DocumentsModule], // DocumentsModule: StorageService for downloaded listing photos
  controllers: [MarketWatchController],
  providers: [MarketWatchService, PageFetcherService, ListingExtractorService, ListingImageService],
  exports: [MarketWatchService],
})
export class MarketWatchModule {}
