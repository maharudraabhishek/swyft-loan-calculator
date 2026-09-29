import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApiFailure,
  DealDto,
  DisplayOptions,
  FeeSignatureDto,
  LenderDto,
  QuoteCreateDto,
  QuoteDto,
} from '@swyft/contracts';
import { formatMoney } from '../../../shared/format';
import { useBridge } from '../lib/bridge';
import { Checkbox, TextField } from '../ui/field';
import { ErrorNotice } from '../ui/notice';
import { PreviewPanel, type PreviewState } from './preview-panel';
import { TargetCommission } from './target-commission';
import { LenderLogo } from '../lenders/lender-logo';
import {
  initialFormValues,
  planFor,
  toFieldErrors,
  toQuoteRequest,
  valuesForSignature,
  type FieldErrors,
  type QuoteFormField,
  type QuoteFormValues,
} from './quote-form-model';
import {
  commissionModelLabels,
  commissionSummary,
  feeSummary,
  signatureTitle,
  paymentTimingLabel,
} from './signature-labels';

const previewDelayMs = 200;
const commonTerms = [12, 24, 36, 48, 60, 72, 84];

/** Outcome of the last "Add quote to log", tied to the deal it was for. */
type SaveState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | {
      readonly status: 'failed';
      readonly error: ApiFailure;
      /** `undefined` when naming a new deal failed. */
      readonly dealId: string | undefined;
    }
  | {
      readonly status: 'saved';
      readonly quote: QuoteDto;
      readonly dealId: string;
      /** The lender's settings changed on the server after this preview was made. */
      readonly signatureChanged: boolean;
    };

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Lender → signature options, presets first, then the broker's own. */
function groupSignatures(signatures: readonly FeeSignatureDto[]) {
  const groups = new Map<string, FeeSignatureDto[]>();
  for (const signature of [...signatures].sort(
    (a, b) =>
      Number(b.isPreset) - Number(a.isPreset) ||
      a.lenderName.localeCompare(b.lenderName) ||
      a.name.localeCompare(b.name),
  )) {
    const label = signature.isPreset
      ? signature.lenderName
      : `${signature.lenderName} (custom)`;
    groups.set(label, [...(groups.get(label) ?? []), signature]);
  }
  return [...groups.entries()];
}

/**
 * The quote calculator: loan details, lender, rate, commission and fees with a live local
 * preview. It works without a deal; "Add quote to log" saves to the open deal, or creates
 * one from the name entered here, and the API recalculates what it stores.
 */
export function QuoteBuilder({
  deal,
  signatures,
  lenders,
  display,
  onSaved,
  onDealCreated,
  onViewSaved,
}: {
  /** Where "Add quote to log" saves; `undefined` asks for a new deal name. */
  readonly deal: DealDto | undefined;
  readonly signatures: readonly FeeSignatureDto[];
  readonly lenders: readonly LenderDto[];
  readonly display: DisplayOptions;
  readonly onSaved: (quote: QuoteDto, deal: DealDto) => void;
  readonly onDealCreated: (deal: DealDto) => void;
  readonly onViewSaved: () => void;
}): React.JSX.Element {
  const bridge = useBridge();
  const ordered = useMemo(() => groupSignatures(signatures), [signatures]);
  const firstId = ordered[0]?.[1][0]?.id ?? '';
  const [chosenId, setSignatureId] = useState(firstId);
  // A custom signature deleted in the lender library falls back to the first option.
  const signature =
    signatures.find((item) => item.id === chosenId) ??
    signatures.find((item) => item.id === firstId);
  const signatureId = signature?.id ?? '';
  const [values, setValues] = useState<QuoteFormValues>(() =>
    signature
      ? valuesForSignature(initialFormValues(), signature)
      : initialFormValues(),
  );
  const [submitted, setSubmitted] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({
    status: 'incomplete',
  });
  const [previewFields, setPreviewFields] = useState<FieldErrors>({});
  const [previewKey, setPreviewKey] = useState<string>();
  const [saveState, setSave] = useState<SaveState>({ status: 'idle' });
  // An outcome for another deal is not shown once the broker opens a different one.
  const save: SaveState =
    (saveState.status === 'saved' || saveState.status === 'failed') &&
    saveState.dealId !== deal?.id
      ? { status: 'idle' }
      : saveState;
  const [dealName, setDealName] = useState('');
  const [serverFields, setServerFields] = useState<FieldErrors>({});
  /**
   * Reused while retrying the same draft for the same deal so a lost response cannot
   * double-save; a different draft or deal gets a new key.
   */
  const attempt = useRef<{
    requestKey: string;
    dealId: string;
    idempotencyKey: string;
  }>(undefined);

  const plan = signature ? planFor(signature) : undefined;
  const built = useMemo(
    () => (signature ? toQuoteRequest(values, signature) : undefined),
    [values, signature],
  );
  const requestKey = built?.ok ? JSON.stringify(built.request) : undefined;
  // Monthly lenders: the settlement date only dates the preview schedule (not saved).
  const scheduleStartDate =
    plan &&
    !plan.needsDates &&
    /^\d{4}-\d{2}-\d{2}$/.test(values.settlementDate)
      ? values.settlementDate
      : undefined;

  // Debounced local preview; only the newest response may publish.
  useEffect(() => {
    if (!signature || !built?.ok || requestKey === undefined) {
      setPreview({ status: 'incomplete' });
      setPreviewFields({});
      setPreviewKey(undefined);
      return undefined;
    }
    let current = true;
    setPreview({ status: 'calculating' });
    const timer = setTimeout(() => {
      bridge.quotes
        .preview({
          signature,
          request: built.request,
          ...(scheduleStartDate !== undefined && { scheduleStartDate }),
        })
        .then((response) => {
          if (!current) return;
          if (response.ok) {
            setPreview({ status: 'ready', preview: response.preview });
            setPreviewFields({});
            setPreviewKey(requestKey);
          } else {
            setPreview({ status: 'error', message: response.message });
            setPreviewFields(toFieldErrors(response.fields));
            setPreviewKey(undefined);
          }
        })
        .catch(() => {
          if (current)
            setPreview({
              status: 'error',
              message:
                'The preview is unavailable. Restart the app if this continues.',
            });
        });
    }, previewDelayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [bridge, signature, built, requestKey, scheduleStartDate]);

  const change = <K extends keyof QuoteFormValues>(
    key: K,
    value: QuoteFormValues[K],
  ) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setServerFields((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key as QuoteFormField];
      return next;
    });
    if (save.status !== 'saving') setSave({ status: 'idle' });
  };

  const chooseSignature = (id: string) => {
    const next = signatures.find((item) => item.id === id);
    setSignatureId(id);
    if (next) setValues((previous) => valuesForSignature(previous, next));
    setServerFields({});
    setSave({ status: 'idle' });
  };

  const formErrors: FieldErrors = built && !built.ok ? built.errors : {};
  const errorFor = (field: QuoteFormField): string | undefined => {
    const message =
      serverFields[field] ?? previewFields[field] ?? formErrors[field];
    // Blank required fields are only flagged once the broker tries to save.
    if (
      !submitted &&
      formErrors[field] &&
      !serverFields[field] &&
      !previewFields[field]
    ) {
      const typed = values[field];
      return typeof typed === 'string' && typed.trim() === ''
        ? undefined
        : message;
    }
    return message;
  };

  const ready = preview.status === 'ready' && previewKey === requestKey;
  const dealNameError =
    submitted && !deal && dealName.trim() === ''
      ? 'Name a deal to keep this quote in, or open one from the deal list.'
      : undefined;

  const saveDraft = async () => {
    setSubmitted(true);
    if (!signature || !built?.ok || !ready || requestKey === undefined) return;
    const newDealName = dealName.trim();
    if (!deal && newDealName === '') return;
    const request: QuoteCreateDto = built.request;
    setSave({ status: 'saving' });

    let target = deal;
    let created = false;
    if (!target) {
      const result = await bridge.deals.create(newDealName);
      if (!result.ok) {
        setSave({ status: 'failed', error: result.error, dealId: undefined });
        return;
      }
      target = result.data;
      created = true;
      setDealName('');
    }

    if (
      attempt.current?.requestKey !== requestKey ||
      attempt.current.dealId !== target.id
    )
      attempt.current = {
        requestKey,
        dealId: target.id,
        idempotencyKey: newIdempotencyKey(),
      };
    const result = await bridge.quotes.save(
      target.id,
      attempt.current.idempotencyKey,
      request,
    );
    // The new deal opens only after the save, so its quote log loads with the quote.
    if (created) onDealCreated(target);
    if (result.ok) {
      attempt.current = undefined;
      setSave({
        status: 'saved',
        quote: result.data,
        dealId: target.id,
        signatureChanged: result.data.feeSignatureVersion !== signature.version,
      });
      setSubmitted(false);
      onSaved(result.data, target);
    } else {
      setSave({ status: 'failed', error: result.error, dealId: target.id });
      if (result.error.fields)
        setServerFields(toFieldErrors(result.error.fields));
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void saveDraft();
  };

  if (signatures.length === 0)
    return (
      <p className="muted">
        No lenders are available. Open Lenders to check your lender library.
      </p>
    );

  return (
    <div className="builder">
      <form className="builder-form" onSubmit={submit} noValidate>
        <fieldset>
          <legend>Lender</legend>
          <div className="field">
            <label htmlFor="signature">Lender and fee signature</label>
            <select
              id="signature"
              value={signatureId}
              onChange={(event) => chooseSignature(event.target.value)}
            >
              {ordered.map(([lender, items]) => (
                <optgroup key={lender} label={lender}>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {signatureTitle(item)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {signature && (
            <div className="signature-card" aria-live="polite">
              <div className="signature-card-heading">
                <LenderLogo
                  lender={
                    lenders.find(
                      (lender) => lender.id === signature.lenderId,
                    ) ?? {
                      id: signature.lenderId,
                      name: signature.lenderName,
                      hasLogo: false,
                      logoUpdatedAt: null,
                    }
                  }
                />
                <strong>{signatureTitle(signature)}</strong>
              </div>
              <p>
                <span className="badge">
                  {commissionModelLabels[signature.commissionModel]}
                </span>{' '}
                <span className="badge neutral">
                  {paymentTimingLabel(signature)}
                  {signature.interestMethod === 'daily'
                    ? ' · daily interest'
                    : ''}
                </span>
                {!signature.isPreset && (
                  <span className="badge custom">Custom</span>
                )}
              </p>
              <p className="small">{feeSummary(signature)}</p>
              <p className="small muted">
                Commission: {commissionSummary(signature)}
              </p>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>Loan details</legend>
          <div className="field-grid">
            <TextField
              label="Finance amount"
              prefix="$"
              inputMode="decimal"
              required
              value={values.financeAmount}
              onChange={(value) => change('financeAmount', value)}
              error={errorFor('financeAmount')}
              placeholder="30000"
            />
            <TextField
              label="Term (months)"
              inputMode="numeric"
              required
              list="term-options"
              value={values.termMonths}
              onChange={(value) => change('termMonths', value)}
              error={errorFor('termMonths')}
            />
            <datalist id="term-options">
              {commonTerms.map((term) => (
                <option key={term} value={term} />
              ))}
            </datalist>
            <TextField
              label="Asset description"
              value={values.assetDescription}
              onChange={(value) => change('assetDescription', value)}
              error={errorFor('assetDescription')}
              placeholder="e.g. 2024 Toyota HiLux"
            />
            <TextField
              label="Balloon / residual"
              prefix="$"
              inputMode="decimal"
              value={values.balloon}
              onChange={(value) => change('balloon', value)}
              error={errorFor('balloon')}
              placeholder="0"
            />
            {plan && !plan.needsDates && (
              <TextField
                label="Settlement date"
                type="date"
                value={values.settlementDate}
                onChange={(value) => change('settlementDate', value)}
                hint="Dates the repayment schedule; not needed to price this lender."
              />
            )}
          </div>
        </fieldset>

        {plan && signature && (
          <fieldset>
            <legend>Rate and commission</legend>
            <div className="field-grid">
              <TextField
                label={plan.baseRateLabel}
                suffix="%"
                inputMode="decimal"
                required
                value={values.baseRate}
                onChange={(value) => change('baseRate', value)}
                error={errorFor('baseRate')}
                placeholder="8.5"
              />
              {plan.commission === 'rate' ? (
                <TextField
                  label="Commission"
                  suffix="%"
                  inputMode="decimal"
                  value={values.commissionRate}
                  onChange={(value) => change('commissionRate', value)}
                  error={errorFor('commissionRate')}
                  hint={
                    plan.maxCommissionPercent
                      ? `Up to ${plan.maxCommissionPercent}%`
                      : plan.defaultCommissionPercent
                        ? undefined
                        : 'Required for this lender'
                  }
                />
              ) : (
                <TextField
                  label="Contract (customer) rate"
                  suffix="%"
                  inputMode="decimal"
                  required
                  value={values.contractRate}
                  onChange={(value) => change('contractRate', value)}
                  error={errorFor('contractRate')}
                  hint="Commission comes from the overs above the base rate"
                />
              )}
            </div>
            <TargetCommission
              signature={signature}
              values={values}
              onApply={(field, percent) => change(field, percent)}
            />
            {signature.commissionModel === 'daily_interest' &&
              signature.rateMarkupFactor !== null && (
                <p className="hint">
                  Contract rate = base rate + commission ×{' '}
                  {signature.rateMarkupFactor}. The commission is capitalised
                  into the loan.
                </p>
              )}
          </fieldset>
        )}

        {plan && (
          <fieldset>
            <legend>Fees</legend>
            <div className="field-grid">
              <TextField
                label="Broker origination fee"
                prefix="$"
                inputMode="decimal"
                value={values.originationFee}
                onChange={(value) => change('originationFee', value)}
                error={errorFor('originationFee')}
                placeholder="0"
                hint={
                  plan.maxOrigination
                    ? `Up to ${formatMoney(plan.maxOrigination)} for this lender`
                    : undefined
                }
              />
            </div>
            <div
              className="toggle-list"
              role="group"
              aria-label="Fee financing"
            >
              <Checkbox
                label="Finance the origination fee (unticked: payable at settlement)"
                checked={values.originationFinanced}
                onChange={(checked) => change('originationFinanced', checked)}
              />
              {plan.fees.map((fee) => (
                <Checkbox
                  key={fee.kind}
                  label={`Finance ${fee.label.toLowerCase()} (${formatMoney(fee.amount)}${
                    fee.maxAmount ? `–${formatMoney(fee.maxAmount)}` : ''
                  })`}
                  checked={
                    values.feeFinancing[fee.kind] ?? fee.financedByDefault
                  }
                  onChange={(checked) =>
                    change('feeFinancing', {
                      ...values.feeFinancing,
                      [fee.kind]: checked,
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
        )}

        {plan?.needsDates && (
          <fieldset>
            <legend>Payment dates</legend>
            <p className="hint">
              This lender charges daily interest over actual calendar days.
              Settlement day counts as an extra day in the first period;
              repayments falling on a weekend or NSW public holiday move to the
              next business day.
            </p>
            <p className="hint">
              The first repayment date sets when repayments start: a date a few
              days after settlement is an advance-style start, a month later is
              a standard start. Every repayment, including the first, pays the
              interest accrued since the previous date. Use the date from the
              lender&apos;s contract.
            </p>
            <div className="field-grid">
              <TextField
                label="Settlement date"
                type="date"
                required
                value={values.settlementDate}
                onChange={(value) => change('settlementDate', value)}
                error={errorFor('settlementDate')}
              />
              <TextField
                label="First repayment date"
                type="date"
                required
                value={values.firstRepaymentDate}
                onChange={(value) => change('firstRepaymentDate', value)}
                error={errorFor('firstRepaymentDate')}
              />
            </div>
          </fieldset>
        )}

        {(formErrors.form ?? serverFields.form ?? previewFields.form) &&
          submitted && (
            <p className="field-error">
              {formErrors.form ?? serverFields.form ?? previewFields.form}
            </p>
          )}

        <fieldset>
          <legend>Quote log</legend>
          {deal ? (
            <p className="hint">
              Quotes are added to the log of <strong>{deal.name}</strong>.
            </p>
          ) : (
            <TextField
              label="New deal name"
              value={dealName}
              onChange={(value) => {
                setDealName(value);
                if (save.status === 'failed') setSave({ status: 'idle' });
              }}
              error={dealNameError}
              placeholder="e.g. Jones — 2024 HiLux"
              hint="Adding a quote creates this deal and keeps the quote in its log. To add to an existing deal, open it from the deal list."
            />
          )}
        </fieldset>

        <div className="form-actions">
          <button
            type="submit"
            className="button primary"
            disabled={
              save.status === 'saving' || preview.status === 'calculating'
            }
          >
            {save.status === 'saving' ? 'Saving…' : 'Add quote to log'}
          </button>
          <div role="status" aria-live="polite" className="save-status">
            {save.status === 'saved' && (
              <span className="success">
                Saved: {signatureTitle(save.quote)} at{' '}
                {formatMoney(save.quote.grossMonthlyPayment)}/month.{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={onViewSaved}
                >
                  View saved quotes
                </button>
                {save.signatureChanged && (
                  <span className="block field-error">
                    This lender&apos;s settings changed since the preview; the
                    saved figures use the current settings. Reopen the deal to
                    refresh.
                  </span>
                )}
              </span>
            )}
            {submitted &&
              !ready &&
              save.status === 'idle' &&
              built?.ok &&
              preview.status === 'error' && (
                <span className="field-error">
                  Fix the preview problem before saving.
                </span>
              )}
          </div>
        </div>
        {save.status === 'failed' && (
          <ErrorNotice
            error={save.error}
            context="The quote was not saved."
            onRetry={() => void saveDraft()}
          />
        )}
      </form>
      <PreviewPanel state={preview} signature={signature} display={display} />
    </div>
  );
}
