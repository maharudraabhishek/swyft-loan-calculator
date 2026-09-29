/** Expected rejection of invalid finance-domain input at a trust boundary. */
export class QuoteValidationError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteValidationError';
  }
}
