import { useState } from 'react';
import {
  lenderCreateSchema,
  type ApiFailure,
  type FeeSignatureDto,
  type LenderDto,
} from '@swyft/contracts';
import { useBridge } from '../lib/bridge';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { TextField } from '../ui/field';
import { ErrorNotice } from '../ui/notice';
import { LenderLogo } from './lender-logo';

type Draft = { readonly name: string; readonly website: string };

/** Validates with the API's own schema so the app and the API agree on the rules. */
function parseDraft(
  draft: Draft,
):
  | { ok: true; value: { name: string; websiteUrl: string | null } }
  | { ok: false; errors: Partial<Record<keyof Draft, string>> } {
  const parsed = lenderCreateSchema.safeParse({
    name: draft.name,
    websiteUrl: draft.website.trim() === '' ? null : draft.website.trim(),
  });
  if (parsed.success) return { ok: true, value: parsed.data };
  const errors: Partial<Record<keyof Draft, string>> = {};
  for (const issue of parsed.error.issues)
    if (issue.path[0] === 'websiteUrl')
      errors.website ??= 'Enter a full https:// address, or leave it blank.';
    else errors.name ??= 'Enter a lender name (up to 120 characters).';
  return { ok: false, errors };
}

function LenderForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly initial: Draft;
  readonly submitLabel: string;
  readonly onSubmit: (value: {
    name: string;
    websiteUrl: string | null;
  }) => Promise<ApiFailure | undefined>;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>(
    {},
  );
  const [failure, setFailure] = useState<ApiFailure>();
  const [saving, setSaving] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parseDraft(draft);
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});
    setSaving(true);
    const problem = await onSubmit(parsed.value);
    setSaving(false);
    setFailure(problem);
  };
  return (
    <form className="panel" onSubmit={(event) => void submit(event)} noValidate>
      <div className="field-grid">
        <TextField
          label="Lender name"
          required
          value={draft.name}
          onChange={(name) => setDraft({ ...draft, name })}
          error={errors.name}
        />
        <TextField
          label="Website"
          value={draft.website}
          placeholder="https://"
          onChange={(website) => setDraft({ ...draft, website })}
          error={errors.website}
        />
      </div>
      {failure && <ErrorNotice error={failure} context="Not saved." />}
      <div className="form-actions">
        <button
          type="submit"
          className="button primary small"
          disabled={saving}
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button
          type="button"
          className="button secondary small"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The broker's own lenders: create, rename, set the website, upload or remove a logo
 * (stored in Cloud Storage through the API), and delete. Built-in lenders are shared
 * and read-only; a custom fee signature can be assigned to one of these lenders.
 */
export function CustomLenders({
  lenders,
  signatures,
  onChanged,
}: {
  readonly lenders: readonly LenderDto[];
  readonly signatures: readonly FeeSignatureDto[];
  readonly onChanged: (message: string) => void;
}): React.JSX.Element {
  const bridge = useBridge();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<LenderDto>();
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<ApiFailure>();
  const own = lenders.filter((lender) => !lender.isPreset);

  const act = async (
    lender: LenderDto,
    operation: () => Promise<{ ok: boolean; error?: ApiFailure }>,
    message: string,
  ) => {
    setBusy(lender.id);
    setFailure(undefined);
    const result = await operation();
    setBusy(undefined);
    if (!result.ok) return setFailure(result.error);
    onChanged(message);
  };

  return (
    <section aria-labelledby="own-lenders-heading">
      <div className="section-heading">
        <h3 id="own-lenders-heading">Your lenders</h3>
        {!creating && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => setCreating(true)}
          >
            Add lender
          </button>
        )}
      </div>
      {creating && (
        <LenderForm
          initial={{ name: '', website: '' }}
          submitLabel="Create lender"
          onCancel={() => setCreating(false)}
          onSubmit={async (value) => {
            const result = await bridge.lenders.createLender(value);
            if (!result.ok) return result.error;
            setCreating(false);
            onChanged(
              `Created lender “${result.data.name}”. Duplicate a fee signature and assign it to this lender.`,
            );
            return undefined;
          }}
        />
      )}
      {failure && !deleting && (
        <ErrorNotice error={failure} context="The change was not saved." />
      )}
      {own.length === 0 && !creating && (
        <p className="muted">
          No custom lenders yet. Add one to quote a lender that is not built in.
        </p>
      )}
      <ul className="lender-list">
        {own.map((lender) => {
          const count = signatures.filter(
            (item) => item.lenderId === lender.id,
          ).length;
          return (
            <li key={lender.id} className="lender-row">
              {editing === lender.id ? (
                <LenderForm
                  initial={{
                    name: lender.name,
                    website: lender.websiteUrl ?? '',
                  }}
                  submitLabel="Save lender"
                  onCancel={() => setEditing(undefined)}
                  onSubmit={async (value) => {
                    const result = await bridge.lenders.updateLender(
                      lender.id,
                      value,
                    );
                    if (!result.ok) return result.error;
                    setEditing(undefined);
                    onChanged(`Saved lender “${result.data.name}”.`);
                    return undefined;
                  }}
                />
              ) : (
                <>
                  <LenderLogo lender={lender} size={40} />
                  <div className="lender-meta">
                    <strong>{lender.name}</strong>
                    <span className="muted small block">
                      {lender.websiteUrl ?? 'No website'} · {count}{' '}
                      {count === 1 ? 'fee signature' : 'fee signatures'}
                    </span>
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => setEditing(lender.id)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={busy === lender.id}
                      onClick={() =>
                        void act(
                          lender,
                          async () => {
                            const result = await bridge.lenders.uploadLogo(
                              lender.id,
                            );
                            // Cancelling the file picker changes nothing.
                            return result.ok && result.data === null
                              ? { ok: false }
                              : result;
                          },
                          `Logo updated for “${lender.name}”.`,
                        )
                      }
                    >
                      {busy === lender.id
                        ? 'Working…'
                        : lender.hasLogo
                          ? 'Replace logo'
                          : 'Upload logo'}
                    </button>
                    {lender.hasLogo && (
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={busy === lender.id}
                        onClick={() =>
                          void act(
                            lender,
                            () => bridge.lenders.removeLogo(lender.id),
                            `Logo removed from “${lender.name}”.`,
                          )
                        }
                      >
                        Remove logo
                      </button>
                    )}
                    <button
                      type="button"
                      className="button secondary small danger-text"
                      onClick={() => {
                        setFailure(undefined);
                        setDeleting(lender);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {deleting && (
        <ConfirmDialog
          title="Delete this lender?"
          confirmLabel="Delete lender"
          busy={busy === deleting.id}
          onCancel={() => {
            setDeleting(undefined);
            setFailure(undefined);
          }}
          onConfirm={() =>
            void (async () => {
              setBusy(deleting.id);
              const result = await bridge.lenders.removeLender(deleting.id);
              setBusy(undefined);
              if (!result.ok && result.error.kind !== 'not-found')
                return setFailure(result.error);
              const name = deleting.name;
              setDeleting(undefined);
              onChanged(`Deleted lender “${name}”.`);
            })()
          }
        >
          <p>
            “{deleting.name}”, its logo and its{' '}
            {signatures.filter((item) => item.lenderId === deleting.id).length}{' '}
            custom fee signature(s) will be deleted. Quotes already saved keep
            their figures.
          </p>
          {failure && <ErrorNotice error={failure} context="Not deleted." />}
        </ConfirmDialog>
      )}
    </section>
  );
}
