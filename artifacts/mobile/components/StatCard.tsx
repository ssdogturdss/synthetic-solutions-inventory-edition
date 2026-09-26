import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

interface StatCardProps {
  label: string;
  value: string | number;
  icon: keyof typeof Feather.glyphMap;
  tint?: 'primary' | 'success' | 'warning' | 'destructive';
  onPress?: () => void;
}

export function StatCard({ label, value, icon, tint = 'primary', onPress }: StatCardProps) {
  const colors = useColors();
  const tintColor = {
    primary: colors.primary,
    success: colors.success,
    warning: colors.warning,
    destructive: colors.destructive,
  }[tint];

  return (
    <Pressable
      style={({ pressed }) => [styles.card, { backgroundColor: colors.card, borderColor: colors.border }, pressed && onPress && { opacity: 0.8 }]}
      onPress={onPress}
      disabled={!onPress}
    >
      <View style={[styles.iconWrap, { backgroundColor: tintColor + '18' }]}>
        <Feather name={icon} size={18} color={tintColor} />
      </View>
      <Text style={[styles.value, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>{value}</Text>
      <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    gap: 6,
    minWidth: 120,
    elevation: 1,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: { fontSize: 24 },
  label: { fontSize: 12 },
});
