import { Pipe, type PipeTransform } from '@angular/core';
import type { NodePlatform } from '../../../../shared/types/worker-node.types';

@Pipe({ name: 'nodePath', standalone: true })
export class NodePathPipe implements PipeTransform {
  transform(path: string | null | undefined, platform: NodePlatform): string {
    if (!path) return '';
    if (platform === 'win32') {
      return path.replace(/\//g, '\\');
    }
    return path;
  }
}
