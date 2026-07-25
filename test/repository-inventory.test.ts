import { describe, expect, it } from 'vitest';

import {
  inventoryRepository,
  type InventoryError,
  type InventoryFile,
} from '@migration/repository-inventory';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

describe('repository npm inventory', () => {
  it('records declared and reliably resolved dependency versions separately', () => {
    const inventory = inventoryRepository([
      {
        path: 'package.json',
        content: encode({
          dependencies: { '@orbitchat/sdk': '^1.4.0' },
          devDependencies: { typescript: '^6.0.0' },
        }),
      },
      {
        path: 'package-lock.json',
        content: encode({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { '@orbitchat/sdk': '^1.4.0' } },
            'node_modules/@orbitchat/sdk': { version: '1.4.7' },
            'node_modules/typescript': { version: '6.0.3' },
          },
        }),
      },
    ]);

    expect(inventory.manifests).toEqual(['package.json']);
    expect(inventory.lockfiles).toEqual(['package-lock.json']);
    expect(inventory.observations).toEqual([
      {
        packageName: '@orbitchat/sdk',
        kind: 'dependency',
        manifestPath: 'package.json',
        lockfilePath: 'package-lock.json',
        declaredRange: '^1.4.0',
        resolvedVersion: '1.4.7',
        discoveryMethod: 'npm_lockfile',
      },
      {
        packageName: 'typescript',
        kind: 'development',
        manifestPath: 'package.json',
        lockfilePath: 'package-lock.json',
        declaredRange: '^6.0.0',
        resolvedVersion: '6.0.3',
        discoveryMethod: 'npm_lockfile',
      },
    ]);
  });

  it('uses the nearest ancestor npm lockfile for a workspace manifest', () => {
    const inventory = inventoryRepository([
      {
        path: 'packages/client/package.json',
        content: encode({ dependencies: { react: '^19.0.0' } }),
      },
      {
        path: 'package-lock.json',
        content: encode({
          lockfileVersion: 3,
          packages: {
            'node_modules/react': { version: '19.2.0' },
          },
        }),
      },
    ]);

    expect(inventory.observations[0]).toMatchObject({
      manifestPath: 'packages/client/package.json',
      lockfilePath: 'package-lock.json',
      resolvedVersion: '19.2.0',
    });
  });

  it('does not represent a declared range as a resolved version', () => {
    const inventory = inventoryRepository([
      {
        path: 'package.json',
        content: encode({ peerDependencies: { react: '>=18' } }),
      },
    ]);
    expect(inventory.observations[0]).toMatchObject({
      declaredRange: '>=18',
      resolvedVersion: null,
      discoveryMethod: 'manifest',
    });
  });

  it.each([
    '../package.json',
    '/package.json',
    'packages//package.json',
    'packages/./package.json',
    'packages\\package.json',
    'C:/package.json',
  ])('rejects unsafe repository path %s', path => {
    expect(() =>
      inventoryRepository([{ path, content: encode({ dependencies: {} }) }]),
    ).toThrow(
      expect.objectContaining<Partial<InventoryError>>({
        safeCode: 'INVENTORY_PATH_UNSAFE',
      }),
    );
  });

  it('rejects duplicate normalized paths', () => {
    const files: InventoryFile[] = [
      { path: 'package.json', content: encode({}) },
      { path: 'package.json', content: encode({}) },
    ];
    expect(() => inventoryRepository(files)).toThrow(
      expect.objectContaining<Partial<InventoryError>>({
        safeCode: 'INVENTORY_PATH_UNSAFE',
      }),
    );
  });

  it('rejects malformed manifests and unsupported npm lockfile formats', () => {
    expect(() =>
      inventoryRepository([
        {
          path: 'package.json',
          content: new TextEncoder().encode('{'),
        },
      ]),
    ).toThrow(
      expect.objectContaining<Partial<InventoryError>>({
        safeCode: 'MANIFEST_INVALID',
      }),
    );

    expect(() =>
      inventoryRepository([
        { path: 'package.json', content: encode({ dependencies: { react: '^19' } }) },
        {
          path: 'package-lock.json',
          content: encode({ lockfileVersion: 1, dependencies: {} }),
        },
      ]),
    ).toThrow(
      expect.objectContaining<Partial<InventoryError>>({
        safeCode: 'LOCKFILE_INVALID',
      }),
    );
  });
});
