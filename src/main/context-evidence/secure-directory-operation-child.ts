import { lstatSync, renameSync, statSync, unlinkSync } from 'node:fs';

const EXIT_INVALID_REQUEST = 70;
const EXIT_IDENTITY_MISMATCH = 71;
const EXIT_OPERATION_FAILED = 72;

function isSafeLeafName(value: string | undefined): value is string {
  return Boolean(
    value
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0'),
  );
}

function run(): number {
  const [kind, expectedDevice, expectedInode, sourceName, targetName] = process.argv.slice(2);
  if (
    (kind !== 'rename' && kind !== 'remove')
    || !expectedDevice
    || !expectedInode
    || !isSafeLeafName(sourceName)
    || (kind === 'rename' && !isSafeLeafName(targetName))
  ) {
    return EXIT_INVALID_REQUEST;
  }

  try {
    const directory = statSync('.');
    if (String(directory.dev) !== expectedDevice || String(directory.ino) !== expectedInode) {
      return EXIT_IDENTITY_MISMATCH;
    }

    const source = lstatSync(sourceName);
    if (!source.isFile() || source.isSymbolicLink()) return EXIT_IDENTITY_MISMATCH;
    if (kind === 'rename') {
      renameSync(sourceName, targetName!);
    } else {
      unlinkSync(sourceName);
    }
    return 0;
  } catch (error) {
    if (kind === 'remove' && (error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    return EXIT_OPERATION_FAILED;
  }
}

process.exitCode = run();
