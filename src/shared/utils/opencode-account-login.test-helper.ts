/** External CLI double characterized against native 2.0.30's import/switch behavior. */
export const V2_LOGIN_CLI_FIXTURE = String.raw`
if (process.argv[2] === 'auth' && ['import', 'switch'].includes(process.argv[3])) {
  const fs = require('node:fs'), path = require('node:path');
  if (process.env.TEST_AUTH_CALLS) fs.appendFileSync(process.env.TEST_AUTH_CALLS, JSON.stringify({ args: process.argv.slice(2), config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}') }) + '\n');
  const file = process.env.OPENCODE_DB || path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (require('node:sqlite').DatabaseSync)(file);
  db.exec('CREATE TABLE IF NOT EXISTS credential (id TEXT PRIMARY KEY, integration_id TEXT, active INTEGER, value TEXT)');
  if (process.argv[3] === 'switch') {
    if (process.env.TEST_SWITCH_EXIT) { db.close(); process.exit(Number(process.env.TEST_SWITCH_EXIT)); }
    if (!process.env.TEST_SWITCH_NOOP) {
      db.exec('BEGIN');
      db.prepare('UPDATE credential SET active=0 WHERE integration_id=?').run(process.argv[4]);
      db.prepare('UPDATE credential SET active=1 WHERE integration_id=? AND id=?').run(process.argv[4], process.argv[5]);
      db.exec('COMMIT');
    }
    db.close(); process.exit(0);
  }
  let input = '';
  process.stdin.on('data', part => input += part);
  process.stdin.on('end', () => {
    const value = JSON.parse(input);
    if (process.env.TEST_IMPORT) fs.writeFileSync(process.env.TEST_IMPORT, JSON.stringify({ args: process.argv.slice(2), value }));
    for (const row of value) {
      if (process.env.TEST_CONCURRENT_CREDENTIAL) {
        db.prepare('INSERT INTO credential VALUES (?, ?, 1, ?)').run('concurrent-placeholder', row.integrationID, '{}');
      }
      const existing = db.prepare('SELECT id FROM credential WHERE integration_id=? AND active=1').get(row.integrationID);
      db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?)').run(row.id, row.integrationID, existing ? 0 : Number(row.active), JSON.stringify(row.value));
    }
    db.close();
  });
}
`;
