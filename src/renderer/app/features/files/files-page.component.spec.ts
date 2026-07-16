import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPageComponent } from './files-page.component';
import { RemoteNodesStore } from '../remote-nodes/remote-nodes.store';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';
import { IpcFacadeService } from '../../core/services/ipc';
import { RemoteFsIpcService } from '../../core/services/ipc/remote-fs-ipc.service';
import { ViewLayoutService } from '../../core/services/view-layout.service';

const windowsNode = {
  id: 'node-1',
  name: 'windows-pc',
  status: 'connected',
  connected: true,
  workingDirectories: ['C:\\Users\\shutu\\Documents\\Work'],
  fileTransfer: {
    enabled: true,
    maxFileBytes: 52_428_800,
    roots: [
      {
        id: 'scratch',
        label: 'AIO Scratch',
        path: 'C:\\Users\\shutu\\.orchestrator\\_scratch\\aio-transfers',
        read: true,
        write: true,
      },
      {
        id: 'downloads',
        label: 'Downloads',
        path: 'C:\\Users\\shutu\\Downloads',
        read: true,
        write: false,
      },
    ],
  },
};

function makeNodesStore() {
  return {
    nodes: signal([windowsNode]),
    refresh: vi.fn(async () => undefined),
  };
}

function makeRemoteNodeIpc() {
  return {
    copyToRemote: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
    copyFromRemote: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
  };
}

describe('FilesPageComponent', () => {
  let nodesStore: ReturnType<typeof makeNodesStore>;
  let remoteNodeIpc: ReturnType<typeof makeRemoteNodeIpc>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    nodesStore = makeNodesStore();
    remoteNodeIpc = makeRemoteNodeIpc();
    TestBed.configureTestingModule({
      imports: [FilesPageComponent],
      providers: [
        { provide: RemoteNodesStore, useValue: nodesStore },
        { provide: RemoteNodeIpcService, useValue: remoteNodeIpc },
        {
          provide: IpcFacadeService,
          useValue: {
            selectFolder: vi.fn(async () => null),
            readDir: vi.fn(async () => []),
          },
        },
        {
          provide: RemoteFsIpcService,
          useValue: {
            onFsEvent: vi.fn(() => () => undefined),
            readDirectory: vi.fn(async () => ({ entries: [] })),
            watch: vi.fn(async () => null),
            unwatch: vi.fn(async () => undefined),
          },
        },
        {
          provide: ViewLayoutService,
          useValue: {
            fileExplorerWidth: 280,
            setFileExplorerWidth: vi.fn(),
          },
        },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(FilesPageComponent);
    fixture.detectChanges();
    return fixture;
  }

  function dropEvent(): DragEvent {
    return { preventDefault: vi.fn() } as unknown as DragEvent;
  }

  it('lists worker transfer roots plus working directories for the selected node', () => {
    const fixture = render();
    const component = fixture.componentInstance;
    component.selectedNodeId.set('node-1');

    const roots = component.remoteRoots();
    expect(roots.map((root) => root.path)).toEqual([
      'C:\\Users\\shutu\\.orchestrator\\_scratch\\aio-transfers',
      'C:\\Users\\shutu\\Downloads',
      'C:\\Users\\shutu\\Documents\\Work',
    ]);
    expect(roots[1].write).toBe(false);
  });

  it('copies dropped local files onto the worker with node-style path joining', async () => {
    const fixture = render();
    const component = fixture.componentInstance;
    component.selectedNodeId.set('node-1');
    component.selectedRootPath.set('C:\\Users\\shutu\\.orchestrator\\_scratch\\aio-transfers');

    component.onPaneDragStart('local', ['/Users/suas/pics/rosette.jpg']);
    await component.onDropToRemote(dropEvent());

    expect(remoteNodeIpc.copyToRemote).toHaveBeenCalledExactlyOnceWith({
      nodeId: 'node-1',
      localPath: '/Users/suas/pics/rosette.jpg',
      remotePath: 'C:\\Users\\shutu\\.orchestrator\\_scratch\\aio-transfers\\rosette.jpg',
    });
    expect(component.transfers()[0]).toMatchObject({ name: 'rosette.jpg', status: 'done' });
  });

  it('refuses a fetch when no local destination folder is chosen', async () => {
    const fixture = render();
    const component = fixture.componentInstance;
    component.selectedNodeId.set('node-1');

    component.onPaneDragStart('remote', ['C:\\Users\\shutu\\Downloads\\report.pdf']);
    await component.onDropToLocal(dropEvent());

    expect(remoteNodeIpc.copyFromRemote).not.toHaveBeenCalled();
    expect(component.transfers()[0]).toMatchObject({ status: 'failed' });
  });

  it('does not transfer dragged folders', async () => {
    const fixture = render();
    const component = fixture.componentInstance;
    component.selectedNodeId.set('node-1');
    component.selectedRootPath.set('C:\\Users\\shutu\\.orchestrator\\_scratch\\aio-transfers');

    component.onPaneSingleDragStart('local', {
      path: '/Users/suas/pics',
      name: 'pics',
      isDirectory: true,
    });
    await component.onDropToRemote(dropEvent());

    expect(remoteNodeIpc.copyToRemote).not.toHaveBeenCalled();
  });

  it('surfaces a failed transfer with its error message', async () => {
    remoteNodeIpc.copyToRemote.mockResolvedValueOnce({ success: false, error: 'file too large' });
    const fixture = render();
    const component = fixture.componentInstance;
    component.selectedNodeId.set('node-1');
    component.selectedRootPath.set('C:\\Users\\shutu\\.orchestrator\\_scratch\\aio-transfers');

    component.onPaneDragStart('local', ['/Users/suas/big.mov']);
    await component.onDropToRemote(dropEvent());

    expect(component.transfers()[0]).toMatchObject({
      name: 'big.mov',
      status: 'failed',
      error: 'file too large',
    });
  });
});
