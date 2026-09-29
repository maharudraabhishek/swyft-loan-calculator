import { useEffect, useId, useState } from 'react';
import type { FeeSignatureDto } from '@swyft/contracts';
import {
  formatMoney,
  formatRate,
  fractionToPercent,
} from '../../../shared/format';
import { useBridge } from '../lib/bridge';
import { toQuoteRequest, type QuoteFormValues } from './quote-form-model';

type Result =
  | { readonly status: 'idle' }
  | { readonly status: 'working' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'solved';
      readonly field: 'contractRate' | 'commissionRate';
      readonly percent: string;
      readonly text: string;
    };

/**
 * Target commission calculator (reverse calculation). Solves, for the current inputs, the
 * contract rate (commission-overs lenders) or commission % (other models) that earns the
 * broker's target, using the shared engine in Main, and offers to apply it.
 */
export function TargetCommission({
  signature,
  values,
  onApply,
}: {
  readonly signature: FeeSignatureDto;
  readonly values: QuoteFormValues;
  readonly onApply: (
    field: 'contractRate' | 'commissionRate',
    percent: string,
  ) => void;
}): React.JSX.Element {
  const bridge = useBridge();
  const id = useId();
  const [target, setTarget] = useState('');
  const [result, setResult] = useState<Result>({ status: 'idle' });
  const overs = signature.commissionModel === 'overs';

  // A solved rate belongs to the inputs it was solved for.
  const inputsKey = JSON.stringify([signature.id, signature.version, values]);
  useEffect(() => setResult({ status: 'idle' }), [inputsKey]);

  const solve = async () => {
    const cleaned = target.replace(/[\s,$]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned))
      return setResult({
        status: 'error',
        message: 'Enter the commission you want in dollars, e.g. 1500.',
      });
    // The rate being solved for must not block the request.
    const built = toQuoteRequest(
      overs
        ? { ...values, contractRate: values.baseRate }
        : { ...values, commissionRate: '' },
      signature,
    );
    if (!built.ok)
      return setResult({
        status: 'error',
        message:
          'Complete the finance amount, term, base rate and any required dates first.',
      });
    setResult({ status: 'working' });
    const response = await bridge.quotes.targetCommission({
      signature,
      request: built.request,
      targetCommission: cleaned,
    });
    if (!response.ok)
      return setResult({ status: 'error', message: response.message });
    const earns = formatMoney(response.commission);
    const text =
      response.solves === 'contractRate'
        ? response.metByBaseCommission
          ? `The base commission already meets this target: the base rate ${formatRate(response.rate)} earns ${earns}.`
          : `A contract rate of ${formatRate(response.rate)} earns ${earns}.`
        : `A commission of ${formatRate(response.rate)} earns ${earns}${
            response.contractRate === null
              ? ''
              : ` (contract rate ${formatRate(response.contractRate)})`
          }.`;
    setResult({
      status: 'solved',
      field: response.solves,
      percent: fractionToPercent(response.rate),
      text,
    });
  };

  return (
    <div className="target-commission">
      <label htmlFor={id}>Target commission</label>
      <div className="row">
        <div className="input-wrap">
          <span className="affix" aria-hidden="true">
            $
          </span>
          <input
            id={id}
            inputMode="decimal"
            placeholder="1500"
            value={target}
            aria-describedby={`${id}-result`}
            onChange={(event) => setTarget(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault(); // Enter here solves; it must not save the quote.
              void solve();
            }}
          />
        </div>
        <button
          type="button"
          className="button secondary small"
          disabled={result.status === 'working'}
          onClick={() => void solve()}
        >
          {result.status === 'working'
            ? 'Calculating…'
            : overs
              ? 'Find contract rate'
              : 'Find commission %'}
        </button>
      </div>
      <div
        id={`${id}-result`}
        role="status"
        aria-live="polite"
        className="small"
      >
        {result.status === 'error' && (
          <p className="field-error">{result.message}</p>
        )}
        {result.status === 'solved' && (
          <p className="target-result">
            {result.text}{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => onApply(result.field, result.percent)}
            >
              Use this rate
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
