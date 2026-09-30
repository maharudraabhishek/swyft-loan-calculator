import { useState } from 'react';
import {
  feeSignatureDefinitionSchema,
  type ApiFailure,
  type FeeSignatureDto,
  type FeeSignatureEditDto,
  type LenderDto,
} from '@swyft/contracts';
import {
  formatRateCompact,
  fractionToPercent,
  percentToFraction,
} from '../../../shared/format';
import { useBridge } from '../lib/bridge';
import type { Resource } from '../lib/use-resource';
import {
  commissionModelLabels,
  commissionSummary,
  feeLabels,
  feeSummary,
  lenderFeeKinds,
  paymentTimingLabel,
  type LenderFeeKind,
} from '../quotes/signature-labels';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Checkbox, TextField } from '../ui/field';
import { ErrorNotice, LoadingRows } from '../ui/notice';
import { CustomLenders } from './custom-lenders';
import { LenderLogo } from './lender-logo';

/**
 * The broker's lender library. Built-in presets are shared and read-only; "Duplicate to
 * customise" creates the broker's own copy (copy-on-write on the API), which can then be
 * edited or deleted. Saved quotes keep their own snapshot, so edits never change them.
 */
export function LenderLibrary({
  signatures,
  lenders,
  onChanged,
  onLendersChanged,
  onRetry,
}: {
  readonly signatures: Resource<readonly FeeSignatureDto[]>;
  readonly lenders: Resource<readonly LenderDto[]>;
  readonly onChanged: () => void;
  /** Reloads lenders; deleting a lender also removes its signatures. */
  readonly onLendersChanged: () => void;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const bridge = useBridge();
  const [editing, setEditing] = useState<FeeSignatureDto>();
  const [deleting, setDeleting] = useState<FeeSignatureDto>();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<ApiFailure>();
  const [message, setMessage] = useState<string>();

  const duplicate = async (signature: FeeSignatureDto) => {
    setBusyId(signature.id);
    setError(undefined);
    const result = await bridge.lenders.copySignature(
      signature.id,
      `${signature.name} (custom)`.slice(0, 120),
    );
    setBusyId(undefined);
    if (!result.ok) return setError(result.error);
    setMessage(
      `Created “${result.data.lenderName} — ${result.data.name}”. You can edit it now.`,
    );
    onChanged();
    setEditing(result.data);
  };

  const remove = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    const result = await bridge.lenders.removeSignature(deleting.id);
    setBusyId(undefined);
    if (!result.ok && result.error.kind !== 'not-found')
      return setError(result.error);
    setMessage(`Deleted “${deleting.lenderName} — ${deleting.name}”.`);
    setDeleting(undefined);
    onChanged();
  };

  const list = signatures.data ?? [];
  const presets = list.filter((item) => item.isPreset);
  const custom = list.filter((item) => !item.isPreset);

  return (
    <div className="lender-library">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">Lenders</p>
          <h2>Lender library</h2>
          <p className="muted">
            Built-in fee signatures follow each lender&apos;s published
            structure. Duplicate one to adjust fees or commission for your own
            use.
          </p>
        </div>
      </header>
      <div role="status" aria-live="polite">
        {message && <p className="notice success">{message}</p>}
      </div>
      {error && !deleting && (
        <ErrorNotice error={error} context="The change was not saved." />
      )}
      {signatures.status === 'error' && (
        <ErrorNotice
          error={signatures.error}
          context="Lenders could not be loaded."
          onRetry={onRetry}
        />
      )}
      {signatures.status === 'loading' && !signatures.data && (
        <LoadingRows label="Loading lenders…" />
      )}

      {editing && (
        <SignatureEditor
          key={editing.id}
          signature={editing}
          lenders={lenders.data ?? []}
          onCancel={() => setEditing(undefined)}
          onSaved={(saved) => {
            setEditing(undefined);
            setMessage(`Saved “${saved.lenderName} — ${saved.name}”.`);
            onChanged();
          }}
        />
      )}

      {lenders.status === 'error' && (
        <ErrorNotice
          error={lenders.error}
          context="Your lenders could not be loaded."
          onRetry={onLendersChanged}
        />
      )}
      {lenders.data && (
        <CustomLenders
          lenders={lenders.data}
          signatures={list}
          onChanged={(text) => {
            setMessage(text);
            onLendersChanged();
            onChanged();
          }}
        />
      )}

      <section aria-labelledby="custom-heading">
        <h3 id="custom-heading">Your custom signatures</h3>
        {signatures.data && custom.length === 0 && (
          <p className="muted">
            None yet. Duplicate a built-in signature below to create one.
          </p>
        )}
        <SignatureTable
          items={custom}
          lenders={lenders.data ?? []}
          actions={(signature) => (
            <>
              <button
                type="button"
                className="button secondary small"
                onClick={() => setEditing(signature)}
              >
                Edit
              </button>
              <button
                type="button"
                className="button secondary small danger-text"
                onClick={() => {
                  setError(undefined);
                  setDeleting(signature);
                }}
              >
                Delete
              </button>
            </>
          )}
        />
      </section>

      <section aria-labelledby="preset-heading">
        <h3 id="preset-heading">Built-in lenders</h3>
        <SignatureTable
          items={presets}
          lenders={lenders.data ?? []}
          actions={(signature) => (
            <button
              type="button"
              className="button secondary small"
              disabled={busyId === signature.id}
              onClick={() => void duplicate(signature)}
            >
              {busyId === signature.id
                ? 'Duplicating…'
                : 'Duplicate to customise'}
            </button>
          )}
        />
      </section>

      {deleting && (
        <ConfirmDialog
          title="Delete this custom signature?"
          confirmLabel="Delete signature"
          busy={busyId === deleting.id}
          onCancel={() => {
            setDeleting(undefined);
            setError(undefined);
          }}
          onConfirm={() => void remove()}
        >
          <p>
            “{deleting.lenderName} — {deleting.name}” will be removed from your
            lender list. Quotes already saved with it are not changed.
          </p>
          {error && <ErrorNotice error={error} context="Not deleted." />}
        </ConfirmDialog>
      )}
    </div>
  );
}

function SignatureTable({
  items,
  lenders,
  actions,
}: {
  readonly items: readonly FeeSignatureDto[];
  readonly lenders: readonly LenderDto[];
  readonly actions: (signature: FeeSignatureDto) => React.ReactNode;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="table-scroll">
      <table className="data-table lender-table">
        <thead>
          <tr>
            <th scope="col">Lender</th>
            <th scope="col">Commission model</th>
            <th scope="col">Timing</th>
            <th scope="col">Fees</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((signature) => {
            const lender = lenders.find(
              (item) => item.id === signature.lenderId,
            );
            const website = lender?.websiteUrl
              ? websiteLabel(lender.websiteUrl)
              : undefined;
            return (
              <tr key={signature.id}>
                <td className="lender-cell">
                  <LenderLogo
                    lender={
                      lender ?? {
                        id: signature.lenderId,
                        name: signature.lenderName,
                        hasLogo: false,
                        logoUpdatedAt: null,
                      }
                    }
                  />
                  <strong>{signature.lenderName}</strong>
                  <span className="block muted small">
                    {signature.name}{' '}
                    <span
                      className={`badge ${signature.isPreset ? 'neutral' : 'custom'}`}
                    >
                      {signature.isPreset ? 'Built-in' : 'Custom'}
                    </span>
                  </span>
                  {website && (
                    <span
                      className="block muted small"
                      title={lender?.websiteUrl ?? undefined}
                    >
                      {website}
                    </span>
                  )}
                </td>
                <td>
                  {commissionModelLabels[signature.commissionModel]}
                  <span className="block muted small">
                    {commissionSummary(signature)}
                  </span>
                </td>
                <td>
                  {paymentTimingLabel(signature)}
                  {signature.interestMethod === 'daily' && (
                    <span className="block muted small">daily interest</span>
                  )}
                </td>
                <td className="small">{feeSummary(signature)}</td>
                <td className="actions">{actions(signature)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The lender's website (brief "Lender Logos" table) as plain text, e.g.
 * `peppermoney.com.au`. Not a link: the app opens no external pages and loads no
 * third-party images, so presets without a supplied logo file show initials.
 */
function websiteLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface EditorValues {
  lenderId: string;
  name: string;
  paymentTiming: FeeSignatureDto['paymentTiming'];
  monthlyFee: string;
  defaultCommission: string;
  maxCommission: string;
  /** Lender charges whole-dollar instalments (cent payment rounded up). */
  roundPaymentUpToDollar: boolean;
  fees: Partial<Record<LenderFeeKind, { amount: string; financed: boolean }>>;
}

function editorValues(signature: FeeSignatureDto): EditorValues {
  const fees: EditorValues['fees'] = {};
  for (const kind of lenderFeeKinds) {
    const fee = signature.fees[kind];
    if (fee) fees[kind] = { amount: fee.amount, financed: fee.financed };
  }
  return {
    lenderId: signature.lenderId,
    name: signature.name,
    paymentTiming: signature.paymentTiming,
    monthlyFee: signature.monthlyFee,
    defaultCommission:
      signature.defaultCommissionRate === null
        ? ''
        : fractionToPercent(signature.defaultCommissionRate),
    maxCommission:
      signature.maxCommissionRate === null
        ? ''
        : fractionToPercent(signature.maxCommissionRate),
    roundPaymentUpToDollar: signature.roundPaymentUpToDollar === true,
    fees,
  };
}

const percentPattern = /^\d+(\.\d+)?$/;

/** Builds the full definition the API's PUT expects, keeping every model parameter. */
function toDefinition(
  signature: FeeSignatureDto,
  values: EditorValues,
): { definition?: FeeSignatureEditDto; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const percent = (text: string, field: string) => {
    const cleaned = text.trim().replace('%', '');
    if (cleaned === '') return null;
    if (!percentPattern.test(cleaned) || Number(cleaned) > 100) {
      errors[field] = 'Enter a percentage from 0 to 100';
      return null;
    }
    return percentToFraction(cleaned);
  };
  const fees: FeeSignatureEditDto['fees'] = {};
  for (const kind of lenderFeeKinds) {
    const fee = values.fees[kind];
    if (!fee) continue;
    const existing = signature.fees[kind];
    const maxAmount =
      existing && 'maxAmount' in existing ? existing.maxAmount : undefined;
    fees[kind] = {
      amount: fee.amount.trim().replace(/[$,]/g, ''),
      financed: fee.financed,
      ...(maxAmount !== undefined && { maxAmount }),
    };
  }
  const candidate = {
    lenderId: values.lenderId,
    name: values.name,
    commissionModel: signature.commissionModel,
    paymentTiming: values.paymentTiming,
    defaultCommissionRate: percent(
      values.defaultCommission,
      'defaultCommission',
    ),
    maxCommissionRate: percent(values.maxCommission, 'maxCommission'),
    baseCommission: signature.baseCommission,
    oversShare: signature.oversShare,
    gstRate: signature.gstRate,
    loadingFactor: signature.loadingFactor,
    rateMarkupFactor: signature.rateMarkupFactor,
    monthlyFee: values.monthlyFee.trim().replace(/[$,]/g, '') || '0',
    slidingFee: signature.slidingFee,
    maxBrokerOrigination: signature.maxBrokerOrigination,
    // Sent only when it is on or being switched off, so ordinary edits also work
    // against an API that predates the field (it rejects unknown keys).
    ...((values.roundPaymentUpToDollar ||
      signature.roundPaymentUpToDollar === true) && {
      roundPaymentUpToDollar: values.roundPaymentUpToDollar,
    }),
    fees,
  };
  const parsed = feeSignatureDefinitionSchema.safeParse(candidate);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const [first, second] = issue.path;
      const key =
        first === 'fees' && typeof second === 'string'
          ? `fee-${second}`
          : String(first);
      errors[key] ??= issue.message;
    }
  return Object.keys(errors).length > 0
    ? { errors }
    : { definition: candidate, errors };
}

function SignatureEditor({
  signature,
  lenders,
  onCancel,
  onSaved,
}: {
  readonly signature: FeeSignatureDto;
  /** The signature's current lender and the broker's own lenders can be chosen. */
  readonly lenders: readonly LenderDto[];
  readonly onCancel: () => void;
  readonly onSaved: (signature: FeeSignatureDto) => void;
}): React.JSX.Element {
  const bridge = useBridge();
  const [values, setValues] = useState(() => editorValues(signature));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure>();
  const daily = signature.commissionModel === 'daily_interest';
  const overs = signature.commissionModel === 'overs';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const { definition, errors: found } = toDefinition(signature, values);
    setErrors(found);
    if (!definition) return;
    setSaving(true);
    setFailure(undefined);
    const result = await bridge.lenders.updateSignature(
      signature.id,
      definition,
    );
    setSaving(false);
    if (result.ok) onSaved(result.data);
    else setFailure(result.error);
  };

  return (
    <form
      className="panel editor"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h3>
        Edit {signature.lenderName} — {signature.name}
      </h3>
      <p className="muted small">
        {commissionModelLabels[signature.commissionModel]}
        {overs && signature.oversShare
          ? ` · overs share ${formatRateCompact(signature.oversShare)}`
          : ''}
      </p>
      <div className="field-grid">
        <TextField
          label="Signature name"
          value={values.name}
          onChange={(name) => setValues({ ...values, name })}
          error={errors.name}
          required
        />
        <div className="field">
          <label htmlFor="edit-lender">Lender</label>
          <select
            id="edit-lender"
            value={values.lenderId}
            onChange={(event) =>
              setValues({ ...values, lenderId: event.target.value })
            }
          >
            <option value={signature.lenderId}>{signature.lenderName}</option>
            {lenders
              .filter(
                (lender) =>
                  !lender.isPreset && lender.id !== signature.lenderId,
              )
              .map((lender) => (
                <option key={lender.id} value={lender.id}>
                  {`${lender.name} (your lender)`}
                </option>
              ))}
          </select>
          {errors.lenderId && <p className="field-error">{errors.lenderId}</p>}
        </div>
        {!daily && (
          <div className="field">
            <label htmlFor="edit-timing">Payment timing</label>
            <select
              id="edit-timing"
              value={values.paymentTiming}
              onChange={(event) =>
                setValues({
                  ...values,
                  paymentTiming: event.target
                    .value as FeeSignatureDto['paymentTiming'],
                })
              }
            >
              <option value="advance">Advance</option>
              <option value="arrears">Arrears</option>
            </select>
          </div>
        )}
        <TextField
          label="Monthly fee"
          prefix="$"
          inputMode="decimal"
          value={values.monthlyFee}
          onChange={(monthlyFee) => setValues({ ...values, monthlyFee })}
          error={errors.monthlyFee}
        />
        {!overs && (
          <>
            <TextField
              label="Standard commission"
              suffix="%"
              inputMode="decimal"
              value={values.defaultCommission}
              onChange={(defaultCommission) =>
                setValues({ ...values, defaultCommission })
              }
              error={errors.defaultCommission ?? errors.defaultCommissionRate}
              hint="Blank: enter per quote"
            />
            <TextField
              label="Maximum commission"
              suffix="%"
              inputMode="decimal"
              value={values.maxCommission}
              onChange={(maxCommission) =>
                setValues({ ...values, maxCommission })
              }
              error={errors.maxCommission ?? errors.maxCommissionRate}
              hint="Blank: no cap"
            />
          </>
        )}
        {lenderFeeKinds.map((kind) => {
          const fee = values.fees[kind];
          if (!fee) return null;
          return (
            <div key={kind} className="fee-edit">
              <TextField
                label={feeLabels[kind]}
                prefix="$"
                inputMode="decimal"
                value={fee.amount}
                onChange={(amount) =>
                  setValues({
                    ...values,
                    fees: { ...values.fees, [kind]: { ...fee, amount } },
                  })
                }
                error={errors[`fee-${kind}`]}
              />
              <Checkbox
                label="Financed by default"
                checked={fee.financed}
                onChange={(financed) =>
                  setValues({
                    ...values,
                    fees: { ...values.fees, [kind]: { ...fee, financed } },
                  })
                }
              />
            </div>
          );
        })}
      </div>
      <div className="toggle-list">
        <Checkbox
          label="Round repayments up to the whole dollar"
          checked={values.roundPaymentUpToDollar}
          onChange={(roundPaymentUpToDollar) =>
            setValues({ ...values, roundPaymentUpToDollar })
          }
        />
        <p className="hint">
          For lenders that charge whole-dollar instalments: the repayment is
          rounded up to the next dollar and the final instalment is reduced so
          the loan closes exactly. Commission is unchanged.
        </p>
      </div>
      {failure && <ErrorNotice error={failure} context="Not saved." />}
      <div className="form-actions">
        <button type="submit" className="button primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save signature'}
        </button>
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
