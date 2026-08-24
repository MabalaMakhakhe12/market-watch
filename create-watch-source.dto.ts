import { IsOptional, IsString, IsUrl, Matches, MaxLength, MinLength } from 'class-validator';
import { PAGE_TEMPLATE_RE } from '../market-watch.constants';

export class CreateWatchSourceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  /** The listing INDEX page to scan (a site can have several sources,
   *  e.g. one per brand or per new/used section). */
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  url!: string;

  /** Pagination recipe for multi-page stock lists — a URL template
   *  ("https://site/stock?page={page}") or a POST recipe
   *  ("POST https://site/getData.php page={offset:10}&…"). */
  @IsOptional()
  @Matches(PAGE_TEMPLATE_RE, {
    message:
      'pageTemplate must be a URL template or "POST <url> <body>" containing {page} or {offset:N}',
  })
  @MaxLength(700)
  pageTemplate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
