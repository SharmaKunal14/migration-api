export {
  downloadBoundedArtifact,
  materializeVerificationWorkspace,
} from '@migration/verifier-workspace';

const event = {
  timestamp: new Date().toISOString(),
  level: 'warn',
  service: 'migration-api',
  event: 'verification_runtime_not_implemented',
  safeErrorCode: 'MIGRATION_VERIFICATION_NOT_IMPLEMENTED',
};

process.stderr.write(`${JSON.stringify(event)}\n`);
process.stderr.write(
  'Invalid service configuration: verification runtime is not implemented.\n',
);
process.exitCode = 78;
