import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@migration/authorization': new URL(
        './packages/authorization/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/agent-tools': new URL(
        './packages/agent-tools/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/config': new URL('./packages/config/src/index.ts', import.meta.url)
        .pathname,
      '@migration/candidate-matching': new URL(
        './packages/candidate-matching/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/contracts': new URL(
        './packages/contracts/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/database': new URL(
        './packages/database/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/domain': new URL('./packages/domain/src/index.ts', import.meta.url)
        .pathname,
      '@migration/model-gateway': new URL(
        './packages/model-gateway/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/observability': new URL(
        './packages/observability/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/package-source-discovery': new URL(
        './packages/package-source-discovery/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/package-release-polling': new URL(
        './packages/package-release-polling/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/npm-registry': new URL(
        './packages/npm-registry/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/patch-format': new URL(
        './packages/patch-format/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/patch-policy': new URL(
        './packages/patch-policy/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/repository-inventory': new URL(
        './packages/repository-inventory/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/source-acquisition': new URL(
        './packages/source-acquisition/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/vendor-intelligence': new URL(
        './packages/vendor-intelligence/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/verifier-workspace': new URL(
        './packages/verifier-workspace/src/index.ts',
        import.meta.url,
      ).pathname,
      '@migration/verification-runtime': new URL(
        './packages/verification-runtime/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    coverage: {
      include: [
        'packages/authorization/src/**/*.ts',
        'packages/config/src/**/*.ts',
        'packages/contracts/src/**/*.ts',
        'packages/domain/src/**/*.ts',
        'packages/patch-format/src/**/*.ts',
        'packages/patch-policy/src/**/*.ts',
        'packages/repository-inventory/src/**/*.ts',
        'packages/source-acquisition/src/**/*.ts',
        'packages/vendor-intelligence/src/**/*.ts',
        'packages/verifier-workspace/src/**/*.ts',
        'packages/verification-runtime/src/**/*.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
