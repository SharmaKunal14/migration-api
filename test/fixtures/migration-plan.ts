import type { MigrationPlan } from '@migration/contracts';

export const validPlan: MigrationPlan = {
  schemaVersion: '1.0',
  scenarioId: 'orbitchat-typescript-v1-v2',
  packageName: '@orbitchat/sdk',
  sourceCompatibility: '1.x',
  targetVersion: '2.0.0',
  changes: [
    {
      changeId: 'C-01',
      category: 'request',
      summary: 'messages.send becomes messages.create',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-01'],
    },
    {
      changeId: 'C-02',
      category: 'request',
      summary: 'room becomes channelId',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-02'],
    },
    {
      changeId: 'C-03',
      category: 'request',
      summary: 'text becomes content',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-03'],
    },
    {
      changeId: 'C-04',
      category: 'behavior',
      summary:
        'Explicit notify maps to notification.enabled; omission remains unresolved',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-04'],
    },
    {
      changeId: 'C-05',
      category: 'response',
      summary: 'message_id becomes id',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-05'],
    },
    {
      changeId: 'C-06',
      category: 'response',
      summary: 'created_at becomes createdAt',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-06'],
    },
    {
      changeId: 'C-07',
      category: 'runtime',
      summary: 'Node.js 22 is required',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-07'],
    },
  ],
  evidence: ['C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07'].map(
    evidenceId => ({
      evidenceId,
      summary: `Evidence for ${evidenceId}`,
    }),
  ),
  unresolved: ['Notification defaults vary by account policy.'],
  verificationRecommendations: ['typescript_static', 'typescript_unit'],
  reviewerNotes: ['Review notification behavior for the target account.'],
};
