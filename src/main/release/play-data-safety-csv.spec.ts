import { describe, expect, it } from 'vitest';
import { generatePlayDataSafetyCsv } from './play-data-safety-csv';

describe('generatePlayDataSafetyCsv', () => {
  it('generates the five-column Google Play Data safety import format', () => {
    expect(generatePlayDataSafetyCsv([
      {
        questionId: 'PSL_DATA_TYPES_PERSONAL',
        responseId: 'PSL_NAME',
        responseValue: true,
        answerRequirement: 'MULTIPLE_CHOICE',
        questionLabel: 'Personal info Name',
      },
      {
        questionId: 'PSL_DATA_USAGE_RESPONSES:PSL_NAME:DATA_USAGE_USER_CONTROL',
        responseId: 'PSL_DATA_USAGE_USER_CONTROL_REQUIRED',
        responseValue: '',
        answerRequirement: 'SINGLE_CHOICE',
        questionLabel: 'Data collection is required (users cannot turn it off)',
      },
    ])).toBe(
      'Question ID (machine readable),Response (machine readable),Response value,Answer requirement,Human-friendly question label\n'
      + 'PSL_DATA_TYPES_PERSONAL,PSL_NAME,TRUE,MULTIPLE_CHOICE,Personal info Name\n'
      + 'PSL_DATA_USAGE_RESPONSES:PSL_NAME:DATA_USAGE_USER_CONTROL,PSL_DATA_USAGE_USER_CONTROL_REQUIRED,,SINGLE_CHOICE,Data collection is required (users cannot turn it off)\n',
    );
  });

  it('escapes commas, quotes, and newlines without changing Unicode', () => {
    const csv = generatePlayDataSafetyCsv([{
      questionId: 'Q1',
      responseId: 'R1',
      responseValue: false,
      answerRequirement: 'OPTIONAL',
      questionLabel: 'Location 📍, says "why"\nSecond line',
    }]);

    expect(csv).toContain('Q1,R1,FALSE,OPTIONAL,"Location 📍, says ""why""\nSecond line"');
  });

  it('rejects empty forms and invalid machine-readable identifiers', () => {
    expect(() => generatePlayDataSafetyCsv([])).toThrow('play_data_safety_csv_empty');
    expect(() => generatePlayDataSafetyCsv([{
      questionId: 'contains a space',
      responseId: 'R1',
      responseValue: true,
      answerRequirement: 'REQUIRED',
      questionLabel: 'Question',
    }])).toThrow('play_data_safety_csv_invalid_question_id');
  });
});
