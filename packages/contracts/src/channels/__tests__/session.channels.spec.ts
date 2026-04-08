import { SESSION_CHANNELS } from '../session.channels';

describe('SESSION_CHANNELS', () => {
  it('has correct session values', () => {
    expect(SESSION_CHANNELS.SESSION_FORK).toBe('session:fork');
    expect(SESSION_CHANNELS.SESSION_LIST_RESUMABLE).toBe('session:list-resumable');
    expect(SESSION_CHANNELS.SESSION_CREATE_SNAPSHOT).toBe('session:create-snapshot');
  });

  it('has correct archive values', () => {
    expect(SESSION_CHANNELS.ARCHIVE_SESSION).toBe('archive:session');
    expect(SESSION_CHANNELS.ARCHIVE_SEARCH).toBe('archive:search');
    expect(SESSION_CHANNELS.ARCHIVE_CLEANUP).toBe('archive:cleanup');
  });

  it('has correct history values', () => {
    expect(SESSION_CHANNELS.HISTORY_LIST).toBe('history:list');
    expect(SESSION_CHANNELS.HISTORY_RESTORE).toBe('history:restore');
  });
});
