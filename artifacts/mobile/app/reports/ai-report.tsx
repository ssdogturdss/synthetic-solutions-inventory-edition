import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import AiReportView from '@/components/AiReportView';

/**
 * Standalone AI Report screen — reachable via /reports/ai-report.
 * The same content is also embedded inside the AI tab's "Reports" segment.
 */
export default function AiReportScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <AiReportView bottomPadding={insets.bottom + 32} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
