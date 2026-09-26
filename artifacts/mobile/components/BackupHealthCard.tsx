import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useGetBackupHealth } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

export function BackupHealthCard() {
  const colors = useColors();
  const router = useRouter();
  const { data, isLoading, isError } = useGetBackupHealth();
  const status = data?.overallStatus ?? 'unknown';
  const statusColor = status === 'healthy' ? colors.success : status === 'degraded' ? colors.warning : colors.mutedForeground;

  return (
    <Pressable
      testID="operations-backup-health"
      style={({ pressed }) => [styles.card, { backgroundColor: colors.card, borderColor: colors.border }, pressed && { opacity: 0.85 }]}
      onPress={() => router.push('/admin/backup-health' as any)}
    >
      <View style={[styles.iconBox, { backgroundColor: statusColor + '18' }]}>
        <Feather name={status === 'healthy' ? 'check-circle' : status === 'degraded' ? 'alert-circle' : 'shield'} size={18} color={statusColor} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>Backup health</Text>
        <Text style={[styles.detail, { color: statusColor, fontFamily: 'Inter_500Medium' }]}>
          {isLoading ? 'Checking…' : isError ? 'Unavailable — check server health' : status === 'healthy' ? 'Local and off-server copies are fresh' : status === 'degraded' ? 'Action required before relying on inventory' : 'No recent freshness check'}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginBottom: 4, borderRadius: 14, borderWidth: 1, padding: 13 },
  iconBox: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1 },
  title: { fontSize: 14 },
  detail: { fontSize: 12, marginTop: 3 },
});