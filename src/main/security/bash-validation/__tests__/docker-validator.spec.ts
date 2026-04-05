import { describe, it, expect } from 'vitest';
import { DockerValidator } from '../validators/docker-validator';
import { CommandParser } from '../command-parser';
import type { ValidationContext } from '../types';

const validator = new DockerValidator();
const parser = new CommandParser();
const ctx: ValidationContext = {
  mode: 'prompt', workspacePath: '/workspace', instanceDepth: 0, yoloMode: false, instanceId: 'test',
};

function check(cmd: string) {
  return validator.validate(cmd, parser.parse(cmd), ctx);
}

describe('DockerValidator', () => {
  describe('blocked patterns', () => {
    it.each([
      'docker run --privileged ubuntu',
      'docker run --cap-add=ALL ubuntu',
      'docker run --cap-add=SYS_ADMIN ubuntu',
      'docker run -v /:/host ubuntu',
      'docker run -v /etc/:/config ubuntu',
      'docker run -v /var/run/docker.sock:/var/run/docker.sock ubuntu',
      'docker run -v ~/.ssh:/ssh ubuntu',
      'podman run --privileged fedora',
      'nsenter --target 1 --mount --uts --ipc --net --pid',
    ])('blocks "%s"', (cmd) => {
      expect(check(cmd).action).toBe('block');
    });
  });

  describe('warn patterns', () => {
    it.each([
      'docker run --pid=host ubuntu',
      'docker run --network=host ubuntu',
      'docker exec -u root container_id bash',
      'docker cp malware.sh container_id:/',
    ])('warns on "%s"', (cmd) => {
      expect(check(cmd).action).toBe('warn');
    });
  });

  describe('safe docker commands', () => {
    it.each([
      'docker ps', 'docker images', 'docker build .',
      'docker run ubuntu echo hello',
      'docker-compose up -d',
    ])('allows "%s"', (cmd) => {
      expect(check(cmd).action).toBe('allow');
    });
  });

  it('ignores non-docker commands', () => {
    expect(check('ls -la').action).toBe('allow');
  });
});
