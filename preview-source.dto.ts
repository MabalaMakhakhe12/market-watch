import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Upper bound on a comparison run — each URL costs one page read. */
export const MAX_PREVIEW_URLS = 6;

/**
 * Dry-run one page, or compare several, before registering anything.
 * Send `url` for a single page or `urls` for a bake-off; at least one of
 * the two is required.
 */
export class PreviewSourceDto {
  @ValidateIf((o: PreviewSourceDto) => o.urls === undefined)
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  url?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PREVIEW_URLS)
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] }, { each: true })
  @MaxLength(500, { each: true })
  urls?: string[];
}
