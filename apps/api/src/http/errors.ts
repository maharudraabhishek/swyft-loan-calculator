import type { ApiErrorCode } from '@swyft/contracts';

/**
 * An expected failure with a safe, user-presentable message. Anything that is not an
 * AppError becomes a generic 500 and is logged by category only.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly fields?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 400 with per-field messages the app shows next to the inputs. */
export const validationFailed = (
  fields: Readonly<Record<string, string>>,
  message = 'Some fields are invalid.',
) => new AppError(400, 'VALIDATION_FAILED', message, fields);

/** 401: no valid session. The app refreshes once, then asks the user to sign in. */
export const unauthenticated = () =>
  new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

/** Also used for objects that exist but belong to someone else: no existence oracle. */
export const notFound = (what = 'Resource') =>
  new AppError(404, 'NOT_FOUND', `${what} not found.`);

/** 409: the request clashes with existing data (for example a duplicate lender name). */
export const conflict = (message: string) =>
  new AppError(409, 'CONFLICT', message);

/** 415: the upload is not an accepted image type. */
export const unsupportedMediaType = (message: string) =>
  new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message);

/** 503: a dependency (database or storage) is temporarily unreachable. */
export const serviceUnavailable = () =>
  new AppError(
    503,
    'SERVICE_UNAVAILABLE',
    'The service is temporarily unavailable. Try again shortly.',
  );
