import { createHash } from 'node:crypto';
import type { DealDto, QuoteCreateParsed, QuoteDto } from '@swyft/contracts';
import { QuoteValidationError } from '@swyft/finance';
import {
  FINANCE_ENGINE_VERSION,
  QuoteCompositionError,
  calculateFromSignature,
  quoteRequestFromDto,
  summarizeCalculation,
  toJsonSnapshot,
} from '@swyft/quoting';
import {
  sqlState,
  type Database,
  type Principal,
  type Sql,
} from '../db/database.js';
import { conflict, notFound, validationFailed } from '../http/errors.js';
import {
  findFeeSignature,
  toFeeSignatureDomain,
} from '../lenders/lender-repository.js';
import {
  deleteOwnDeal,
  deleteOwnQuote,
  deleteQuotesOfLog,
  findDeal,
  findQuote,
  findQuoteByIdempotencyKey,
  insertDeal,
  insertQuote,
  listDeals,
  listQuotes,
  renameOwnDeal,
  touchDeal,
  updateOwnQuoteNotes,
  type DealCursor,
  type QuoteSnapshot,
} from './deal-repository.js';

const uniqueViolation = '23505';

/** Result of saving a quote: the stored quote and whether this was an idempotent replay. */
export interface SavedQuote {
  readonly quote: QuoteDto;
  /** True when an identical earlier request with the same key is being replayed. */
  readonly replayed: boolean;
}

function encodeCursor(cursor: DealCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id])).toString(
    'base64url',
  );
}

function decodeCursor(value: string): DealCursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      typeof parsed[1] === 'string' &&
      /^[0-9a-f-]{36}$/.test(parsed[1])
    )
      return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    // Fall through to a validation error.
  }
  throw validationFailed({ cursor: 'Invalid cursor.' });
}

/**
 * Deals, their quote log and quotes. Quotes are always recalculated here from the
 * user's own or a preset fee signature; the client supplies choices, never results.
 */
export class DealService {
  constructor(private readonly database: Database) {}

  async listDeals(
    principal: Principal,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: DealDto[]; nextCursor: string | null }> {
    const after =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    const page = await this.database.withUser(principal, (sql) =>
      listDeals(sql, query.limit, after),
    );
    return {
      items: page.items,
      nextCursor: page.hasMore && page.last ? encodeCursor(page.last) : null,
    };
  }

  createDeal(principal: Principal, name: string): Promise<DealDto> {
    return this.database.withUser(principal, async (sql) => {
      const id = await insertDeal(sql, principal.userId, name);
      const deal = await findDeal(sql, id);
      if (!deal) throw new Error('Created deal is not visible');
      return deal;
    });
  }

  async getDeal(principal: Principal, id: string): Promise<DealDto> {
    const deal = await this.database.withUser(principal, (sql) =>
      findDeal(sql, id),
    );
    if (!deal) throw notFound('Deal');
    return deal;
  }

  renameDeal(principal: Principal, id: string, name: string): Promise<DealDto> {
    return this.database.withUser(principal, async (sql) => {
      if (!(await renameOwnDeal(sql, principal.userId, id, name)))
        throw notFound('Deal');
      const deal = await findDeal(sql, id);
      if (!deal) throw notFound('Deal');
      return deal;
    });
  }

  async deleteDeal(principal: Principal, id: string): Promise<void> {
    const deleted = await this.database.withUser(principal, (sql) =>
      deleteOwnDeal(sql, principal.userId, id),
    );
    if (!deleted) throw notFound('Deal');
  }

  listQuotes(principal: Principal, dealId: string): Promise<QuoteDto[]> {
    return this.database.withUser(principal, async (sql) => {
      if (!(await findDeal(sql, dealId))) throw notFound('Deal');
      return listQuotes(sql, dealId);
    });
  }

  /** Clears the deal's quote log ("Clear All Quotes"). @returns the number deleted. */
  clearQuotes(principal: Principal, dealId: string): Promise<number> {
    return this.database.withUser(principal, async (sql) => {
      const deal = await findDeal(sql, dealId);
      if (!deal) throw notFound('Deal');
      const deleted = await deleteQuotesOfLog(
        sql,
        principal.userId,
        deal.quoteLogId,
      );
      await touchDeal(sql, dealId);
      return deleted;
    });
  }

  /**
   * Recalculates and stores a quote. The quote and the deal's activity timestamp commit
   * together. A repeated Idempotency-Key with the same request returns the original; with a
   * different request it is a conflict.
   */
  async createQuote(
    principal: Principal,
    dealId: string,
    idempotencyKey: string,
    dto: QuoteCreateParsed,
  ): Promise<SavedQuote> {
    const requestSha256 = createHash('sha256')
      .update(JSON.stringify(toJsonSnapshot({ dealId, request: dto })))
      .digest();
    try {
      return await this.database.withUser(principal, (sql) =>
        this.createQuoteInTransaction(
          sql,
          principal,
          dealId,
          { key: idempotencyKey, requestSha256 },
          dto,
        ),
      );
    } catch (error) {
      // A concurrent retry committed first; answer as a replay.
      if (sqlState(error) !== uniqueViolation) throw error;
      return this.database.withUser(principal, (sql) =>
        this.replay(sql, principal, idempotencyKey, requestSha256),
      );
    }
  }

  async getQuote(principal: Principal, id: string): Promise<QuoteDto> {
    const quote = await this.database.withUser(principal, (sql) =>
      findQuote(sql, id),
    );
    if (!quote) throw notFound('Quote');
    return quote;
  }

  updateQuoteNotes(
    principal: Principal,
    id: string,
    notes: string,
  ): Promise<QuoteDto> {
    return this.database.withUser(principal, async (sql) => {
      if (!(await updateOwnQuoteNotes(sql, principal.userId, id, notes)))
        throw notFound('Quote');
      const quote = await findQuote(sql, id);
      if (!quote) throw notFound('Quote');
      return quote;
    });
  }

  async deleteQuote(principal: Principal, id: string): Promise<void> {
    const deleted = await this.database.withUser(principal, (sql) =>
      deleteOwnQuote(sql, principal.userId, id),
    );
    if (!deleted) throw notFound('Quote');
  }

  private async replay(
    sql: Sql,
    principal: Principal,
    key: string,
    requestSha256: Buffer,
  ): Promise<SavedQuote | never> {
    const existing = await findQuoteByIdempotencyKey(
      sql,
      principal.userId,
      key,
    );
    if (!existing)
      throw conflict('This request is still being processed. Try again.');
    if (!existing.requestSha256.equals(requestSha256))
      throw conflict(
        'This Idempotency-Key was already used for a different quote.',
      );
    const quote = await findQuote(sql, existing.id);
    if (!quote)
      throw conflict('This request is still being processed. Try again.');
    return { quote, replayed: true };
  }

  private async createQuoteInTransaction(
    sql: Sql,
    principal: Principal,
    dealId: string,
    idempotency: { key: string; requestSha256: Buffer },
    dto: QuoteCreateParsed,
  ): Promise<SavedQuote> {
    const deal = await findDeal(sql, dealId);
    if (!deal) throw notFound('Deal');
    if (await findQuoteByIdempotencyKey(sql, principal.userId, idempotency.key))
      return this.replay(
        sql,
        principal,
        idempotency.key,
        idempotency.requestSha256,
      );

    const signatureRow = await findFeeSignature(sql, dto.feeSignatureId);
    if (!signatureRow)
      throw validationFailed({ feeSignatureId: 'Fee signature not found.' });
    const signature = toFeeSignatureDomain(signatureRow);

    let calculated;
    try {
      calculated = calculateFromSignature(signature, quoteRequestFromDto(dto));
    } catch (error) {
      if (error instanceof QuoteCompositionError)
        throw validationFailed({ [error.field]: error.message });
      if (error instanceof QuoteValidationError || error instanceof RangeError)
        throw validationFailed(
          { body: 'The quote values are outside the supported range.' },
          'The quote could not be calculated.',
        );
      throw error;
    }
    const { result } = calculated;
    const snapshot: QuoteSnapshot = {
      feeSignatureId: signature.id,
      lenderName: signature.lenderName,
      feeSignatureName: signature.name,
      feeSignatureVersion: signature.version,
      commissionModel: signature.commissionModel,
      interestMethod: signature.interestMethod,
      paymentTiming: signature.paymentTiming,
      assetDescription: dto.assetDescription,
      financeAmount: dto.financeAmount,
      termMonths: dto.termMonths,
      balloon: dto.balloon,
      baseRate: dto.baseRate,
      ...summarizeCalculation(calculated),
      calculationInput: toJsonSnapshot(calculated.input),
      calculationResult: toJsonSnapshot(result),
      feeSignatureSnapshot: toJsonSnapshot(signature),
      engineVersion: FINANCE_ENGINE_VERSION,
      notes: dto.notes,
    };
    const id = await insertQuote(
      sql,
      principal.userId,
      deal.quoteLogId,
      idempotency,
      snapshot,
    );
    await touchDeal(sql, dealId);
    const quote = await findQuote(sql, id);
    if (!quote) throw new Error('Created quote is not visible');
    return { quote, replayed: false };
  }
}
