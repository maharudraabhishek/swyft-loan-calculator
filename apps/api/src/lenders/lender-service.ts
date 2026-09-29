import { randomUUID } from 'node:crypto';
import type {
  FeeSignatureDefinitionParsed,
  FeeSignatureDto,
  LenderDto,
} from '@swyft/contracts';
import { feeSignatureProblems } from '@swyft/quoting';
import { sqlState, type Database, type Principal } from '../db/database.js';
import {
  AppError,
  conflict,
  notFound,
  unsupportedMediaType,
  validationFailed,
} from '../http/errors.js';
import {
  logoExtension,
  maxLogoBytes,
  sniffLogo,
  type LogoStorage,
  type StoredLogo,
} from '../storage/logo-storage.js';
import {
  copyFeeSignature,
  definitionToDomain,
  deleteOwnFeeSignature,
  deleteOwnLender,
  findFeeSignature,
  findLender,
  insertFeeSignature,
  insertLender,
  listFeeSignatures,
  listLenders,
  replaceOwnLenderLogo,
  toFeeSignatureDto,
  toLenderDto,
  updateOwnFeeSignature,
  updateOwnLender,
} from './lender-repository.js';

const uniqueViolation = '23505';

/** Logs a storage clean-up failure without failing an already-committed request. */
export type OrphanReporter = (key: string) => void;

/**
 * Per-user lenders and fee signatures. Presets are readable by everyone and never
 * writable; a user "edits" a preset by copying it into an owned signature.
 */
export class LenderService {
  constructor(
    private readonly database: Database,
    private readonly storage: LogoStorage,
    private readonly reportOrphan: OrphanReporter,
  ) {}

  listLenders(principal: Principal): Promise<LenderDto[]> {
    return this.database.withUser(principal, listLenders);
  }

  async createLender(
    principal: Principal,
    input: { name: string; websiteUrl: string | null },
  ): Promise<LenderDto> {
    try {
      return await this.database.withUser(principal, (sql) =>
        insertLender(sql, principal.userId, input),
      );
    } catch (error) {
      if (sqlState(error) === uniqueViolation)
        throw conflict('You already have a lender with this name.');
      throw error;
    }
  }

  async updateLender(
    principal: Principal,
    id: string,
    input: {
      name?: string | undefined;
      websiteUrl?: string | null | undefined;
    },
  ): Promise<LenderDto> {
    try {
      const lender = await this.database.withUser(principal, (sql) =>
        updateOwnLender(sql, principal.userId, id, input),
      );
      if (!lender) throw notFound('Lender');
      return lender;
    } catch (error) {
      if (sqlState(error) === uniqueViolation)
        throw conflict('You already have a lender with this name.');
      throw error;
    }
  }

  async deleteLender(principal: Principal, id: string): Promise<void> {
    const deleted = await this.database.withUser(principal, (sql) =>
      deleteOwnLender(sql, principal.userId, id),
    );
    if (!deleted) throw notFound('Lender');
    if (deleted.logo) await this.removeObject(deleted.logo.key);
  }

  async getLogo(principal: Principal, id: string): Promise<StoredLogo> {
    const lender = await this.database.withUser(principal, (sql) =>
      findLender(sql, id),
    );
    if (!lender?.logo_object_key) throw notFound('Logo');
    const logo = await this.storage.get(lender.logo_object_key);
    if (!logo) throw notFound('Logo');
    return logo;
  }

  /**
   * Stores a new logo for an owned lender. The object is written first under a fresh
   * server-generated key, then the row is switched in a transaction; the old object is
   * removed after commit. A failed switch removes the new object.
   */
  async putLogo(
    principal: Principal,
    id: string,
    declaredContentType: string,
    bytes: Buffer,
  ): Promise<LenderDto> {
    if (bytes.length === 0)
      throw validationFailed({ body: 'The image is empty.' });
    if (bytes.length > maxLogoBytes)
      throw new AppError(
        413,
        'PAYLOAD_TOO_LARGE',
        'Logos must be 512 KB or smaller.',
      );
    const contentType = sniffLogo(bytes);
    if (!contentType || contentType !== declaredContentType)
      throw unsupportedMediaType('Upload a PNG, JPEG or WebP image.');

    const owned = await this.database.withUser(principal, (sql) =>
      findLender(sql, id),
    );
    if (!owned || owned.owner_user_id !== principal.userId)
      throw notFound('Lender');

    const key = `lender-logos/${principal.userId}/${id}/${randomUUID()}.${logoExtension(contentType)}`;
    await this.storage.put(key, { bytes, contentType });
    let replaced;
    try {
      replaced = await this.database.withUser(principal, (sql) =>
        replaceOwnLenderLogo(sql, principal.userId, id, { key, contentType }),
      );
    } catch (error) {
      await this.removeObject(key);
      throw error;
    }
    if (!replaced) {
      await this.removeObject(key);
      throw notFound('Lender');
    }
    if (replaced.previousKey) await this.removeObject(replaced.previousKey);
    const lender = await this.database.withUser(principal, (sql) =>
      findLender(sql, id),
    );
    if (!lender) throw notFound('Lender');
    return toLenderDto(lender);
  }

  async deleteLogo(principal: Principal, id: string): Promise<void> {
    const replaced = await this.database.withUser(principal, (sql) =>
      replaceOwnLenderLogo(sql, principal.userId, id, null),
    );
    if (!replaced) throw notFound('Lender');
    if (replaced.previousKey) await this.removeObject(replaced.previousKey);
  }

  listFeeSignatures(principal: Principal): Promise<FeeSignatureDto[]> {
    return this.database.withUser(principal, listFeeSignatures);
  }

  async getFeeSignature(
    principal: Principal,
    id: string,
  ): Promise<FeeSignatureDto> {
    const row = await this.database.withUser(principal, (sql) =>
      findFeeSignature(sql, id),
    );
    if (!row) throw notFound('Fee signature');
    return toFeeSignatureDto(row);
  }

  async createFeeSignature(
    principal: Principal,
    input:
      | { copyFromId: string; name?: string | undefined }
      | FeeSignatureDefinitionParsed,
  ): Promise<FeeSignatureDto> {
    return this.database.withUser(principal, async (sql) => {
      let id: string;
      if ('copyFromId' in input) {
        const source = await findFeeSignature(sql, input.copyFromId);
        if (!source) throw notFound('Fee signature');
        id = await copyFeeSignature(
          sql,
          principal.userId,
          source,
          input.name ?? `${source.name} (copy)`.slice(0, 120),
        );
      } else {
        await this.validateDefinition(sql, input);
        id = await insertFeeSignature(sql, principal.userId, input);
      }
      const created = await findFeeSignature(sql, id);
      if (!created) throw new Error('Created fee signature is not visible');
      return toFeeSignatureDto(created);
    });
  }

  async updateFeeSignature(
    principal: Principal,
    id: string,
    definition: FeeSignatureDefinitionParsed,
  ): Promise<FeeSignatureDto> {
    return this.database.withUser(principal, async (sql) => {
      await this.validateDefinition(sql, definition);
      if (!(await updateOwnFeeSignature(sql, principal.userId, id, definition)))
        throw notFound('Fee signature');
      const updated = await findFeeSignature(sql, id);
      if (!updated) throw notFound('Fee signature');
      return toFeeSignatureDto(updated);
    });
  }

  async deleteFeeSignature(principal: Principal, id: string): Promise<void> {
    const deleted = await this.database.withUser(principal, (sql) =>
      deleteOwnFeeSignature(sql, principal.userId, id),
    );
    if (!deleted) throw notFound('Fee signature');
  }

  private async validateDefinition(
    sql: Parameters<typeof findLender>[0],
    definition: FeeSignatureDefinitionParsed,
  ): Promise<void> {
    const lender = await findLender(sql, definition.lenderId);
    if (!lender) throw validationFailed({ lenderId: 'Lender not found.' });
    const problems = feeSignatureProblems(
      definitionToDomain(definition, lender.name),
    );
    if (problems.length > 0)
      throw validationFailed({ commissionModel: problems.join('; ') });
  }

  private async removeObject(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch {
      this.reportOrphan(key);
    }
  }
}
