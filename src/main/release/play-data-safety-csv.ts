export interface PlayDataSafetyCsvRow {
  questionId: string;
  responseId: string;
  responseValue: boolean | '';
  answerRequirement:
    | 'OPTIONAL'
    | 'REQUIRED'
    | 'MULTIPLE_CHOICE'
    | 'SINGLE_CHOICE'
    | 'MAYBE_REQUIRED';
  questionLabel: string;
}

const HEADER = [
  'Question ID (machine readable)',
  'Response (machine readable)',
  'Response value',
  'Answer requirement',
  'Human-friendly question label',
];
const MACHINE_ID_PATTERN = /^[A-Z0-9_:.-]+$/;

export function generatePlayDataSafetyCsv(rows: PlayDataSafetyCsvRow[]): string {
  if (rows.length === 0) {
    throw new Error('play_data_safety_csv_empty');
  }
  for (const row of rows) {
    validateMachineId(row.questionId, 'question_id', false);
    validateMachineId(row.responseId, 'response_id', true);
    if (row.questionLabel.length > 10_000) {
      throw new Error('play_data_safety_csv_question_label_too_long');
    }
  }
  return [
    HEADER,
    ...rows.map((row) => [
      row.questionId,
      row.responseId,
      row.responseValue === '' ? '' : String(row.responseValue).toUpperCase(),
      row.answerRequirement,
      row.questionLabel,
    ]),
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\n') + '\n';
}

function validateMachineId(
  value: string,
  field: 'question_id' | 'response_id',
  allowEmpty: boolean,
): void {
  if ((allowEmpty && value === '') || (value.length <= 1_024 && MACHINE_ID_PATTERN.test(value))) {
    return;
  }
  throw new Error(`play_data_safety_csv_invalid_${field}`);
}

function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}
