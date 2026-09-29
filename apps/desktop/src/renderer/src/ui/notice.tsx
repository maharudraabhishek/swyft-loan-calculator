import { Component, type ReactNode } from 'react';
import type { ApiFailure } from '@swyft/contracts';

/** A failed request with its safe message and, where retrying can help, a retry button. */
export function ErrorNotice({
  error,
  onRetry,
  context,
}: {
  readonly error: ApiFailure;
  readonly onRetry?: () => void;
  /** What failed, e.g. "Deals could not be loaded." */
  readonly context?: string;
}): React.JSX.Element {
  const retryable =
    error.kind === 'offline' ||
    error.kind === 'server' ||
    error.kind === 'rate-limited';
  return (
    <div className="notice error" role="alert">
      <span className="notice-icon" aria-hidden="true">
        !
      </span>
      <div>
        {context && <strong>{context} </strong>}
        <span>{error.message}</span>
      </div>
      {onRetry && retryable && (
        <button
          type="button"
          className="button secondary small"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function LoadingRows({
  label,
  rows = 3,
}: {
  readonly label: string;
  readonly rows?: number;
}): React.JSX.Element {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}

/** Keeps a rendering bug in one area from blanking the whole window. */
export class ErrorBoundary extends Component<
  { readonly children: ReactNode; readonly resetKey?: string },
  { readonly failed: boolean; readonly resetKey?: string }
> {
  override state: { failed: boolean; resetKey?: string } = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { failed: boolean; resetKey?: string },
  ) {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, resetKey: props.resetKey };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="notice error" role="alert">
        <span className="notice-icon" aria-hidden="true">
          !
        </span>
        <div>
          <strong>Something went wrong displaying this view.</strong> Your saved
          data is safe.
        </div>
        <button
          type="button"
          className="button secondary small"
          onClick={() => this.setState({ failed: false })}
        >
          Try again
        </button>
      </div>
    );
  }
}
