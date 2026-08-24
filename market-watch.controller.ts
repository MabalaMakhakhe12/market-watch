import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ChangeApplyStatus, StaffRole } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Throttle } from '@nestjs/throttler';
import { MarketWatchService } from './market-watch.service';
import { CreateWatchSourceDto } from './dto/create-watch-source.dto';
import { UpdateWatchSourceDto } from './dto/update-watch-source.dto';
import { PreviewSourceDto } from './dto/preview-source.dto';

/**
 * Staff management of Market Watch: the watched sites, the change feed, and
 * the approval queue for guarded catalogue updates. The manual scan trigger
 * lives with the other jobs: POST /admin/jobs/market-watch/run (OWNER).
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.OWNER, StaffRole.SECRETARY)
@Controller('admin/market-watch')
export class MarketWatchController {
  constructor(private readonly marketWatch: MarketWatchService) {}

  /**
   * Dry-run candidate pages: fetch, read, report what was found, store
   * NOTHING. Send `url` for one page (full listing dump) or `urls` for a
   * bake-off between candidates (ranked, with a recommendation). Use it
   * before registering a site and to diagnose one that stops reporting.
   * Throttled — each URL costs one page read.
   */
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @HttpCode(200)
  @Post('preview')
  async preview(@Body() dto: PreviewSourceDto) {
    if (dto.urls?.length) {
      return this.marketWatch.previewMany(dto.urls);
    }
    return this.marketWatch.preview(dto.url as string);
  }

  // Mode + queue depth for the dashboard header (auto-apply on/off, key
  // present, sources active, changes awaiting review).
  @Get('status')
  async status() {
    return this.marketWatch.status();
  }

  // ── Sources ──────────────────────────────────────────────────
  @Get('sources')
  async listSources() {
    return this.marketWatch.listSources();
  }

  @Post('sources')
  async createSource(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateWatchSourceDto,
    @Req() req: Request,
  ) {
    return this.marketWatch.createSource(user.userId, dto, req.ip);
  }

  @Patch('sources/:id')
  async updateSource(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateWatchSourceDto,
    @Req() req: Request,
  ) {
    return this.marketWatch.updateSource(user.userId, id, dto, req.ip);
  }

  // Owner-only: deleting a source discards its whole snapshot and history.
  // Pausing (PATCH status: PAUSED) is the everyday action.
  @Roles(StaffRole.OWNER)
  @HttpCode(200)
  @Delete('sources/:id')
  async removeSource(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    return this.marketWatch.removeSource(user.userId, id, req.ip);
  }

  // ── Tracked stock ────────────────────────────────────────────
  /** Every bike currently live on the watched sites — the full crawled
   *  snapshot, catalogue-matched or not (the sourcing view). Bikes the
   *  dealer has delisted, or that the site marks sold / out of stock, are
   *  not stock and do not appear here. */
  @Get('listings')
  async listListings(
    @Query('source') source?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.marketWatch.listListings({ sourceId: source, limit });
  }

  // ── Change feed / approval queue ─────────────────────────────
  @Get('changes')
  async listChanges(
    @Query('status') status?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    if (status && !Object.values(ChangeApplyStatus).includes(status as ChangeApplyStatus)) {
      throw new BadRequestException(
        `status must be one of: ${Object.keys(ChangeApplyStatus).join(', ')}`,
      );
    }
    return this.marketWatch.listChanges({
      status: status as ChangeApplyStatus | undefined,
      limit,
    });
  }

  @HttpCode(200)
  @Post('changes/:id/approve')
  async approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    return this.marketWatch.approveChange(user.userId, id, req.ip);
  }

  @HttpCode(200)
  @Post('changes/:id/reject')
  async reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    return this.marketWatch.rejectChange(user.userId, id, req.ip);
  }
}
