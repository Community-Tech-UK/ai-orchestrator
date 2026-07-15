import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { coerceWritableSettingValue } from './settings-control-policy';

describe('notification settings control policy', () => {
  it('ships conservative cooldown and disabled quiet hours defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      notificationCooldownSeconds: 30,
      notificationQuietHoursEnabled: false,
      notificationQuietHoursStartHour: 22,
      notificationQuietHoursEndHour: 7,
    });
  });

  it('accepts only bounded cooldown and clock-hour settings', () => {
    expect(coerceWritableSettingValue('notificationCooldownSeconds', 15).value).toBe(15);
    expect(coerceWritableSettingValue('notificationQuietHoursEnabled', true).value).toBe(true);
    expect(coerceWritableSettingValue('notificationQuietHoursStartHour', 0).value).toBe(0);
    expect(coerceWritableSettingValue('notificationQuietHoursEndHour', 23).value).toBe(23);
    expect(() => coerceWritableSettingValue('notificationCooldownSeconds', -1)).toThrow();
    expect(() => coerceWritableSettingValue('notificationQuietHoursStartHour', 24)).toThrow();
  });
});
