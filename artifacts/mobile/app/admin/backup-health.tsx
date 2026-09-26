import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGetBackupHealth } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { LoadingState } from '@/components/LoadingState';

type Status = 'healthy' | 'degraded' | 'unknown' | 'fresh' | 'stale' | 'missing';

function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return 'Not available';
  if (ageSeconds < 60) return 'Less than a minute ago';
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function statusLabel(status: Status): string {
  switch (status) {
    case 'healthy':
    case 'fresh':
      return 'Fresh';
    case 'degraded':
    case 'stale':
      return 'Stale';
    case 'missing':
      return 'Missing';
    default:
      return 'Unknown';
  }
}

function statusIcon(status: Status): 'check-circle' | 'alert-circle' | 'help-circle' {
  if (status === 'healthy' || status === 'fresh') return 'check-circle';
  if (status === 'degraded' || status === 'stale' || status === 'missing') return 'alert-circle';
  return 'help-circle';
}

export default function BackupHealthScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { data, isLoading, isError, isRefetching, refetch } = useGetBackupHealth();

  if (isLoading) return <LoadingState message="Checking backup health…" />;

  const overallStatus = data?.overallStatus ?? 'unknown';
  const statusColor = overallStatus === 'healthy'
    ? colors.success
    : overallStatus === 'degraded'
      ? colors.warning
      : colors.mutedForeground;

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}
      showsVerticalScrollIndicator={false}
    >
      <View style={[styles.hero, { backgroundColor: statusColor + '18', borderColor: statusColor + '45' }]}>
        <Feather name={statusIcon(overallStatus)} size={24} color={statusColor} />
        <View style={styles.heroBody}>
          <Text style={[styles.heroTitle, { color: statusColor, fontFamily: 'Inter_700Bold' }]}>
            {isError ? 'Backup health unavailable' : overallStatus === 'healthy' ? 'Backups are healthy' : overallStatus === 'degraded' ? 'Backup attention required' : 'Backup health unknown'}
          </Text>
          <Text style={[styles.heroText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>
            {isError
              ? 'The server could not provide backup metadata. Check the API and backup services before relying on inventory data.'
              : `Copies should be no more than ${data?.maxAgeHours ?? 26} hours old.`}
          </Text>
        </View>
      </View>

      {data && (
        <>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>LAST RESTORE DRILL</Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.cardRow}>
              <View style={[styles.iconBox, { backgroundColor: data.lastRestoreDrillAt ? colors.success + '18' : colors.mutedForeground + '18' }]}>
                <Feather
                  name={data.lastRestoreDrillAt ? 'check-circle' : 'help-circle'}
                  size={18}
                  color={data.lastRestoreDrillAt ? colors.success : colors.mutedForeground}
                />
              </View>
              <View style={styles.cardBody}>
                <Text style={[styles.cardTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                  {data.lastRestoreDrillAt ? 'Last successful restore drill' : 'No successful restore drill has been recorded'}
                </Text>
                {data.lastRestoreDrillAt && (
                  <Text style={[styles.cardMeta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                    {new Date(data.lastRestoreDrillAt).toLocaleString()}
                  </Text>
                )}
              </View>
            </View>
          </View>

          <Text style={[styles.sectionTitle, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>LATEST BACKUP RUN</Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.cardRow}>
              <View style={[styles.iconBox, { backgroundColor: data.latestRun.status === 'success' ? colors.success + '18' : colors.warning + '18' }]}>
                <Feather name={statusIcon(data.latestRun.status === 'success' ? 'fresh' : data.latestRun.status === 'failure' ? 'stale' : 'unknown')} size={18} color={data.latestRun.status === 'success' ? colors.success : colors.warning} />
              </View>
              <View style={styles.cardBody}>
                <Text style={[styles.cardTitle, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                  {data.latestRun.status === 'success' ? 'Completed successfully' : data.latestRun.status === 'failure' ? 'Failed' : 'No recorded run'}
                </Text>
                <Text style={[styles.cardMeta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  {data.latestRun.finishedAt ? new Date(data.latestRun.finishedAt).toLocaleString() : 'Run metadata is not available'}
                </Text>
              </View>
            </View>
            {data.latestRun.message && (
              <Text style={[styles.message, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{data.latestRun.message}</Text>
            )}
          </View>

          <Text style={[styles.sectionTitle, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>COPY FRESHNESS</Text>
          <View style={styles.copyGrid}>
            {[
              { label: 'Local copy', copy: data.localCopy },
              { label: 'Off-server copy', copy: data.offsiteCopy },
            ].map(({ label, copy }) => {
              const copyColor = copy.status === 'fresh' ? colors.success : copy.status === 'unknown' ? colors.mutedForeground : colors.warning;
              return (
                <View key={label} style={[styles.copyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.copyHeader}>
                    <Text style={[styles.copyLabel, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>{label}</Text>
                    <Feather name={statusIcon(copy.status)} size={17} color={copyColor} />
                  </View>
                  <Text style={[styles.copyStatus, { color: copyColor, fontFamily: 'Inter_700Bold' }]}>{statusLabel(copy.status)}</Text>
                  <Text style={[styles.cardMeta, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{formatAge(copy.ageSeconds)}</Text>
                </View>
              );
            })}
          </View>

          <View style={[styles.checkRow, { borderColor: colors.border }]}>
            <Feather name={statusIcon(data.latestCheck.status)} size={16} color={data.latestCheck.status === 'fresh' ? colors.success : colors.warning} />
            <Text style={[styles.checkText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              Freshness check: {statusLabel(data.latestCheck.status)} · {formatAge(data.latestCheck.ageSeconds)}
            </Text>
          </View>

          {overallStatus !== 'healthy' && (
            <View style={[styles.guidance, { backgroundColor: colors.warning + '12', borderColor: colors.warning + '45' }]}>
              <Feather name="life-buoy" size={18} color={colors.warning} />
              <Text style={[styles.guidanceText, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]}>{data.recoveryGuidance}</Text>
            </View>
          )}

          <Text style={[styles.privacyNote, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            This view contains backup and restore-verification metadata only. Database contents, credentials, backup files, and dump contents stay on the server.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16 },
  hero: { flexDirection: 'row', gap: 12, borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 24 },
  heroBody: { flex: 1 },
  heroTitle: { fontSize: 18 },
  heroText: { fontSize: 13, lineHeight: 19, marginTop: 5 },
  sectionTitle: { fontSize: 11, letterSpacing: 0.6, marginBottom: 10, marginTop: 4 },
  card: { borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 22 },
  cardRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  iconBox: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1 },
  cardTitle: { fontSize: 15 },
  cardMeta: { fontSize: 12, marginTop: 3 },
  message: { fontSize: 12, lineHeight: 17, marginTop: 12 },
  copyGrid: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  copyCard: { flex: 1, minHeight: 104, borderRadius: 14, borderWidth: 1, padding: 13 },
  copyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  copyLabel: { fontSize: 13, flex: 1 },
  copyStatus: { fontSize: 16, marginTop: 16 },
  checkRow: { flexDirection: 'row', gap: 8, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 13, marginBottom: 18 },
  checkText: { fontSize: 12, flex: 1 },
  guidance: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderRadius: 12, borderWidth: 1, padding: 13, marginBottom: 16 },
  guidanceText: { flex: 1, fontSize: 13, lineHeight: 19 },
  privacyNote: { fontSize: 11, lineHeight: 17, textAlign: 'center', paddingHorizontal: 8 },
});