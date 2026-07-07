/**
 * Pure option-matching logic for robust <select> / listbox handling.
 *
 * The managed page bridge's old `select` action set `element.value = value`
 * and fired change events. That silently no-ops when `value` is not an exact
 * option `value` (native selects) and does nothing at all for custom listbox
 * widgets (Material/Chakra/Reach), which have no `.value`. For unattended
 * operation a silent no-op is the worst failure mode — the form looks filled
 * but isn't.
 *
 * This module is the decision brain, kept in Node (not the serialized in-page
 * bridge closure) so it is unit-testable. The bridge only reports the option
 * list + current state; the driver resolves the target here and verifies the
 * read-back with `selectionMatches`.
 */

export interface SelectOptionDescriptor {
  /** The option's form `value` (native `<option value>`; may be absent). */
  value?: string;
  /** The option's visible label / text content. */
  label?: string;
}

export interface SelectControlState {
  /** 'native' = <select>; 'custom' = role=listbox/combobox widget. */
  kind: 'native' | 'custom';
  options: SelectOptionDescriptor[];
  /** Current form value (native). */
  value?: string;
  /** Currently selected visible label (native or custom). */
  selectedLabel?: string;
}

export interface ResolvedSelectOption {
  /** Index into the reported `options` array. */
  index: number;
  value?: string;
  label?: string;
  /** How the match was made — surfaced for audit/debugging. */
  matchedBy: 'value-exact' | 'label-exact' | 'value-normalized' | 'label-normalized';
}

/** Trim, lowercase, collapse internal whitespace, drop trailing punctuation. */
export function normalizeSelectText(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:*]+$/g, '')
    .trim();
}

/**
 * Resolve the desired value to a concrete option, trying the most precise
 * match first. Returns null when nothing matches (caller must fail loudly —
 * never fall back to a guess for a form control).
 */
export function resolveSelectOption(
  options: SelectOptionDescriptor[],
  desired: string,
): ResolvedSelectOption | null {
  if (!Array.isArray(options) || options.length === 0) {
    return null;
  }

  const exactValue = options.findIndex((option) => option.value === desired);
  if (exactValue !== -1) {
    return describe(options, exactValue, 'value-exact');
  }

  const exactLabel = options.findIndex(
    (option) => (option.label ?? '') === desired,
  );
  if (exactLabel !== -1) {
    return describe(options, exactLabel, 'label-exact');
  }

  const normalizedDesired = normalizeSelectText(desired);
  if (normalizedDesired === '') {
    return null;
  }

  const normValue = options.findIndex(
    (option) => normalizeSelectText(option.value) === normalizedDesired,
  );
  if (normValue !== -1) {
    return describe(options, normValue, 'value-normalized');
  }

  const normLabel = options.findIndex(
    (option) => normalizeSelectText(option.label) === normalizedDesired,
  );
  if (normLabel !== -1) {
    return describe(options, normLabel, 'label-normalized');
  }

  return null;
}

/**
 * Verify the control's post-set state actually reflects the desired option.
 * Used by the driver to convert silent no-ops into loud errors.
 */
export function selectionMatches(
  state: Pick<SelectControlState, 'value' | 'selectedLabel'>,
  desired: string,
): boolean {
  if (state.value === desired || state.selectedLabel === desired) {
    return true;
  }
  const normalizedDesired = normalizeSelectText(desired);
  if (normalizedDesired === '') {
    return false;
  }
  return (
    normalizeSelectText(state.value) === normalizedDesired ||
    normalizeSelectText(state.selectedLabel) === normalizedDesired
  );
}

export function summarizeOptions(options: SelectOptionDescriptor[], limit = 20): string {
  if (!Array.isArray(options) || options.length === 0) {
    return '(none)';
  }
  const shown = options
    .slice(0, limit)
    .map((option) => {
      const value = option.value ? `value=${JSON.stringify(option.value)}` : '';
      const label = option.label ? `label=${JSON.stringify(option.label)}` : '';
      return [value, label].filter(Boolean).join(' ');
    })
    .filter(Boolean);
  const suffix = options.length > limit ? `, ...${options.length - limit} more` : '';
  return shown.length > 0 ? `${shown.join(', ')}${suffix}` : '(blank options)';
}

function describe(
  options: SelectOptionDescriptor[],
  index: number,
  matchedBy: ResolvedSelectOption['matchedBy'],
): ResolvedSelectOption {
  const option = options[index];
  return {
    index,
    value: option.value,
    label: option.label,
    matchedBy,
  };
}
