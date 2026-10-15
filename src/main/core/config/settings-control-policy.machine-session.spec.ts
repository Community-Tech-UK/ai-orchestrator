import { describe, expect, it } from 'vitest';
import { coerceRendererSettingValue, coerceWritableSettingValue } from './settings-control-policy';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { SETTING_SURFACING } from '../../../shared/types/settings-surfacing';
describe('machine session settings',()=>{
  it('allows disabled or validated context ceilings on both write surfaces',()=>{
    for(const key of ['ownChatContextCeilingTokens','machineContextCeilingTokens'] as const){
      expect(DEFAULT_SETTINGS[key]).toBe(0);expect(SETTING_SURFACING[key]).toBe('tab');
      for(const n of [0,100000,1000000])expect(coerceWritableSettingValue(key,n).value).toBe(n);
      for(const n of [1,50000,99999,1000001,NaN]){
        expect(()=>coerceWritableSettingValue(key,n)).toThrow();expect(()=>coerceRendererSettingValue(key,n)).toThrow();
      }
    }
  });
  it('keeps helper trial and Codex default tuning choices explicit',()=>{
    expect(DEFAULT_SETTINGS.codexHelperAgentsChats).toBe('trial');expect(DEFAULT_SETTINGS.codexHelperAgentsHarnessWork).toBe('trial');
    expect(coerceWritableSettingValue('codexContextTuning','codex').value).toBe('codex');
    expect(()=>coerceWritableSettingValue('codexHelperAgentsHarnessWork','economy')).toThrow();
  });
});
