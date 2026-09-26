import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => <Text testID={`icon-${name}`}>{name}</Text>,
  };
});

jest.mock('@/components/LoadingState', () => {
  const { Text } = require('react-native');
  return { LoadingState: ({ message }: { message: string }) => <Text>{message}</Text> };
});

jest.mock('@/hooks/useColors', () => ({
  useColors: () => ({
    background: '#fff',
    foreground: '#000',
    card: '#f9f9f9',
    border: '#e0e0e0',
    primary: '#1a73e8',
    mutedForeground: '#888',
    success: '#34a853',
    warning: '#f59e0b',
  }),
}));

let mockHealth: unknown;

jest.mock('@workspace/api-client-react', () => ({
  useGetBackupHealth: () => ({
    data: mockHealth,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: jest.fn(),
  }),
}));

import BackupHealthScreen from '../app/admin/backup-health';

describe('BackupHealthScreen', () => {
  beforeEach(() => {
    mockHealth = {
      overallStatus: 'healthy',
      maxAgeHours: 26,
      latestRun: {
        status: 'success',
        finishedAt: '2026-09-23T20:00:00.000Z',
        message: 'backup completed and freshness was verified',
      },
      localCopy: { status: 'fresh', ageSeconds: 3600 },
      offsiteCopy: { status: 'fresh', ageSeconds: 3600 },
      latestCheck: { status: 'fresh', finishedAt: '2026-09-23T20:30:00.000Z', ageSeconds: 1800 },
      lastRestoreDrillAt: '2026-09-18T06:33:07.000Z',
      recoveryGuidance: 'Backups are fresh and verified.',
    };
  });

  it('shows the latest run and both copy freshness states', () => {
    const { getByText, getAllByText } = render(<BackupHealthScreen />);

    expect(getByText('Backups are healthy')).toBeTruthy();
    expect(getByText('Completed successfully')).toBeTruthy();
    expect(getByText('Local copy')).toBeTruthy();
    expect(getByText('Off-server copy')).toBeTruthy();
    expect(getAllByText('Fresh')).toHaveLength(2);
  });

  it('shows the date of the last successful restore drill', () => {
    const { getByText } = render(<BackupHealthScreen />);

    expect(getByText('LAST RESTORE DRILL')).toBeTruthy();
    expect(getByText('Last successful restore drill')).toBeTruthy();
    expect(getByText(new Date('2026-09-18T06:33:07.000Z').toLocaleString())).toBeTruthy();
  });

  it('clearly states when no successful restore drill has been recorded', () => {
    mockHealth = { ...(mockHealth as object), lastRestoreDrillAt: null };

    const { getByText } = render(<BackupHealthScreen />);

    expect(getByText('No successful restore drill has been recorded')).toBeTruthy();
  });

  it('shows server recovery guidance when backup health is degraded', () => {
    mockHealth = {
      ...(mockHealth as object),
      overallStatus: 'degraded',
      latestRun: {
        status: 'failure',
        finishedAt: '2026-09-23T18:00:00.000Z',
        message: 'backup command failed; inspect the systemd journal',
      },
      localCopy: { status: 'stale', ageSeconds: 100000 },
      offsiteCopy: { status: 'missing', ageSeconds: null },
      latestCheck: { status: 'stale', finishedAt: '2026-09-23T18:00:00.000Z', ageSeconds: 100000 },
      recoveryGuidance: "ACTION REQUIRED: inventory-backup.service failed. Check 'journalctl -u inventory-backup.service -n 100 --no-pager'; restore service health before relying on inventory data.",
    };

    const { getByText } = render(<BackupHealthScreen />);

    expect(getByText('Backup attention required')).toBeTruthy();
    expect(getByText(/ACTION REQUIRED: inventory-backup\.service failed/)).toBeTruthy();
  });
});