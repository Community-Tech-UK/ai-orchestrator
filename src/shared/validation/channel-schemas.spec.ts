import { describe, expect, it } from 'vitest';
import { ChannelPairSenderPayloadSchema } from './channel-schemas';

describe('ChannelSchemas', () => {
  describe('ChannelPairSenderPayloadSchema', () => {
    it('accepts a six-character hex pairing code', () => {
      const result = ChannelPairSenderPayloadSchema.safeParse({
        platform: 'discord',
        code: 'A1b2C3',
      });

      expect(result.success).toBe(true);
    });

    it('rejects pairing codes shorter than six characters', () => {
      const result = ChannelPairSenderPayloadSchema.safeParse({
        platform: 'discord',
        code: 'ABC12',
      });

      expect(result.success).toBe(false);
    });

    it('rejects pairing codes longer than six characters', () => {
      const result = ChannelPairSenderPayloadSchema.safeParse({
        platform: 'whatsapp',
        code: 'ABC1234',
      });

      expect(result.success).toBe(false);
    });

    it('rejects non-hex pairing codes', () => {
      const result = ChannelPairSenderPayloadSchema.safeParse({
        platform: 'whatsapp',
        code: 'ZZZZZZ',
      });

      expect(result.success).toBe(false);
    });
  });
});
