import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { WatchSourceStatus } from '@prisma/client';
import { PAGE_TEMPLATE_RE } from '../market-watch.constants';

export class UpdateWatchSourceDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  /** Changing the URL re-baselines the source (it is a different page). */
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  url?: string;

  /** Changing the template forces a full re-read (page hashes reset).
   *  An empty string clears it back to single-page. */
  @IsOptional()
  @ValidateIf((o: UpdateWatchSourceDto) => o.pageTemplate !== '')
  @Matches(PAGE_TEMPLATE_RE, {
    message:
      'pageTemplate must be a URL template or "POST <url> <body>" containing {page} or {offset:N}',
  })
  @MaxLength(700)
  pageTemplate?: string;

  /** PAUSED keeps the snapshot but skips the source on scheduled scans. */
  @IsOptional()
  @IsEnum(WatchSourceStatus)
  status?: WatchSourceStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
