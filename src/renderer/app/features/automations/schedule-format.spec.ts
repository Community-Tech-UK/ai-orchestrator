import { describe, expect, it } from 'vitest';
import { describeCron, describeSchedule } from './schedule-format';

describe('describeCron', () => {
  it('describes daily schedules with unpadded hour and padded minute', () => {
    expect(describeCron('0 20 * * *')).toBe('Daily at 20:00');
    expect(describeCron('0 5 * * *')).toBe('Daily at 5:00');
    expect(describeCron('30 9 * * *')).toBe('Daily at 9:30');
  });

  it('describes weekday and weekend schedules', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 9:00');
    expect(describeCron('0 9 * * 0,6')).toBe('Weekends at 9:00');
    expect(describeCron('0 9 * * 6,0')).toBe('Weekends at 9:00');
  });

  it('describes weekly schedules on a named day', () => {
    expect(describeCron('0 5 * * 1')).toBe('Weekly on Monday at 5:00');
    expect(describeCron('0 5 * * 0')).toBe('Weekly on Sunday at 5:00');
    expect(describeCron('0 5 * * 7')).toBe('Weekly on Sunday at 5:00');
  });

  it('describes monthly schedules with an ordinal day', () => {
    expect(describeCron('0 9 1 * *')).toBe('Monthly on the 1st at 9:00');
    expect(describeCron('0 9 15 * *')).toBe('Monthly on the 15th at 9:00');
    expect(describeCron('0 9 22 * *')).toBe('Monthly on the 22nd at 9:00');
  });

  it('describes interval schedules', () => {
    expect(describeCron('*/30 * * * *')).toBe('Every 30 minutes');
    expect(describeCron('*/1 * * * *')).toBe('Every minute');
    expect(describeCron('0 */2 * * *')).toBe('Every 2 hours');
    expect(describeCron('0 * * * *')).toBe('Every hour');
  });

  it('returns null for shapes it does not recognise', () => {
    expect(describeCron('5,35 * * * *')).toBeNull();
    expect(describeCron('0 9 * 1 *')).toBeNull();
    expect(describeCron('not a cron')).toBeNull();
    expect(describeCron('0 9 * *')).toBeNull();
  });
});

describe('describeSchedule', () => {
  it('falls back to the raw expression for unrecognised cron', () => {
    expect(describeSchedule({ type: 'cron', expression: '5,35 1 * * *', timezone: 'UTC' })).toBe('5,35 1 * * *');
  });

  it('uses the friendly label for recognised cron', () => {
    expect(describeSchedule({ type: 'cron', expression: '0 20 * * *', timezone: 'UTC' })).toBe('Daily at 20:00');
  });

  it('describes a one-time schedule', () => {
    const runAt = new Date('2030-01-15T08:00:00Z').getTime();
    const label = describeSchedule({ type: 'oneTime', runAt });
    expect(label.startsWith('Once on ')).toBe(true);
  });
});
