import {
  paymentFrequencies,
  type DisplayOptions,
  type PaymentFrequency,
} from '@swyft/contracts';
import { Checkbox } from '../ui/field';

const frequencyLabels: Record<PaymentFrequency, string> = {
  monthly: 'Monthly',
  fortnightly: 'Fortnightly',
  weekly: 'Weekly',
};

const visibility = [
  ['showBaseRate', 'Base rate'],
  ['showComparisonRate', 'Comparison rate'],
  ['showCommission', 'Commissions'],
  ['showTotalHiring', 'Total hiring'],
] as const;

/** One set of toggles for the log, the comparison and the client email. */
export function DisplayToolbar({
  display,
  onChange,
}: {
  readonly display: DisplayOptions;
  readonly onChange: (next: DisplayOptions) => void;
}): React.JSX.Element {
  const selectedCount = paymentFrequencies.filter(
    (frequency) => display.frequencies[frequency],
  ).length;
  return (
    <div className="display-toolbar">
      <div
        role="group"
        aria-labelledby="frequency-label"
        className="toolbar-group"
      >
        <span id="frequency-label" className="toolbar-label">
          Repayments
        </span>
        {paymentFrequencies.map((frequency) => {
          const checked = display.frequencies[frequency];
          return (
            <Checkbox
              key={frequency}
              label={frequencyLabels[frequency]}
              checked={checked}
              // The last selected frequency cannot be cleared: a quote always shows a payment.
              disabled={checked && selectedCount === 1}
              onChange={(value) =>
                onChange({
                  ...display,
                  frequencies: { ...display.frequencies, [frequency]: value },
                })
              }
            />
          );
        })}
      </div>
      <div role="group" aria-labelledby="show-label" className="toolbar-group">
        <span id="show-label" className="toolbar-label">
          Show
        </span>
        {/* Brief: checkbox toggles for frequencies, toggle switches for fields. */}
        {visibility.map(([key, label]) => (
          <Checkbox
            key={key}
            appearance="switch"
            label={label}
            checked={display[key]}
            onChange={(value) => onChange({ ...display, [key]: value })}
          />
        ))}
      </div>
    </div>
  );
}
