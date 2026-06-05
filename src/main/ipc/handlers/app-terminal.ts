import { spawn } from 'node:child_process';

/**
 * Spawn the platform-native terminal application at the given directory.
 */
export async function openTerminalAtDirectory(
  dirPath: string,
): Promise<{ success: true; terminal: string } | { success: false; message: string }> {
  if (process.platform === 'darwin') {
    const macCandidates = ['iTerm', 'Warp', 'WezTerm', 'kitty', 'Alacritty', 'Hyper', 'Ghostty', 'Terminal'];
    const errors: string[] = [];
    for (const app of macCandidates) {
      const attempt = await tryOpenMacApp(app, dirPath);
      if (attempt.success) {
        return { success: true, terminal: app };
      }
      errors.push(`${app}: ${attempt.message}`);
    }
    return {
      success: false,
      message: `No supported terminal application was found. Tried: ${errors.join('; ')}`,
    };
  }

  if (process.platform === 'win32') {
    const wtAttempt = await trySpawn('wt.exe', ['-d', dirPath]);
    if (wtAttempt.success) {
      return { success: true, terminal: 'Windows Terminal' };
    }

    const cmdAttempt = await trySpawn(
      'cmd.exe',
      ['/c', 'start', '""', '/D', dirPath, 'cmd.exe'],
    );
    if (cmdAttempt.success) {
      return { success: true, terminal: 'Command Prompt' };
    }

    return {
      success: false,
      message: `Failed to launch a terminal. wt: ${wtAttempt.message}; cmd: ${cmdAttempt.message}`,
    };
  }

  const candidates: { cmd: string; args: (dir: string) => string[]; label: string }[] = [
    { cmd: 'x-terminal-emulator', args: (dir) => ['--working-directory', dir], label: 'x-terminal-emulator' },
    { cmd: 'gnome-terminal', args: (dir) => [`--working-directory=${dir}`], label: 'GNOME Terminal' },
    { cmd: 'konsole', args: (dir) => ['--workdir', dir], label: 'Konsole' },
    { cmd: 'xfce4-terminal', args: (dir) => [`--working-directory=${dir}`], label: 'Xfce Terminal' },
    { cmd: 'alacritty', args: (dir) => ['--working-directory', dir], label: 'Alacritty' },
    { cmd: 'kitty', args: (dir) => ['--directory', dir], label: 'kitty' },
    { cmd: 'tilix', args: (dir) => ['--working-directory', dir], label: 'Tilix' },
    { cmd: 'xterm', args: (dir) => ['-e', `cd "${dir.replace(/"/g, '\\"')}" && exec $SHELL`], label: 'xterm' },
  ];

  const errors: string[] = [];
  for (const candidate of candidates) {
    const attempt = await trySpawn(candidate.cmd, candidate.args(dirPath));
    if (attempt.success) {
      return { success: true, terminal: candidate.label };
    }
    errors.push(`${candidate.cmd}: ${attempt.message}`);
  }

  return {
    success: false,
    message: `No supported terminal emulator was found. Tried: ${errors.join('; ')}`,
  };
}

function trySpawn(
  cmd: string,
  args: string[],
): Promise<{ success: true } | { success: false; message: string }> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      let settled = false;
      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ success: false, message: err.message });
      });
      proc.once('spawn', () => {
        if (settled) return;
        settled = true;
        proc.unref();
        resolve({ success: true });
      });
    } catch (error) {
      resolve({ success: false, message: (error as Error).message });
    }
  });
}

function tryOpenMacApp(
  app: string,
  dirPath: string,
): Promise<{ success: true } | { success: false; message: string }> {
  return new Promise((resolve) => {
    try {
      const proc = spawn('/usr/bin/open', ['-a', app, dirPath], { stdio: 'ignore' });
      let settled = false;
      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        resolve({ success: false, message: err.message });
      });
      proc.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, message: `open exited with code ${code ?? 'null'}` });
        }
      });
    } catch (error) {
      resolve({ success: false, message: (error as Error).message });
    }
  });
}
