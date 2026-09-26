import React from 'react';
import { View, Text, Pressable, StyleSheet, Vibration, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';

interface PinKeypadProps {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  onBiometric?: () => void;
  showBiometric?: boolean;
}

const KEYS = ['1','2','3','4','5','6','7','8','9','bio','0','del'];

export function PinDots({ value, maxLength = 6, color }: { value: string; maxLength?: number; color: string }) {
  const colors = useColors();
  return (
    <View style={styles.dotsRow}>
      {Array.from({ length: maxLength }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            {
              backgroundColor: i < value.length ? color : 'transparent',
              borderColor: i < value.length ? color : colors.mutedForeground,
            },
          ]}
        />
      ))}
    </View>
  );
}

export function PinKeypad({ value, onChange, maxLength = 6, onBiometric, showBiometric = false }: PinKeypadProps) {
  const colors = useColors();

  const press = async (key: string) => {
    if (Platform.OS !== 'web') {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (key === 'del') {
      onChange(value.slice(0, -1));
    } else if (key === 'bio') {
      onBiometric?.();
    } else if (value.length < maxLength) {
      onChange(value + key);
    }
  };

  return (
    <View style={styles.grid}>
      {KEYS.map((key) => {
        const isBio = key === 'bio';
        const isDel = key === 'del';
        const isDisabled = isBio && !showBiometric;

        return (
          <Pressable
            key={key}
            style={({ pressed }) => [
              styles.key,
              { backgroundColor: colors.card, borderColor: colors.border },
              pressed && { opacity: 0.6, transform: [{ scale: 0.95 }] },
              isDisabled && { opacity: 0 },
            ]}
            onPress={() => press(key)}
            disabled={isDisabled}
            testID={`pin-key-${key}`}
          >
            {isBio ? (
              <Feather name="cpu" size={22} color={colors.primary} />
            ) : isDel ? (
              <Feather name="delete" size={22} color={colors.foreground} />
            ) : (
              <Text style={[styles.keyText, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                {key}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dotsRow: {
    flexDirection: 'row',
    gap: 16,
    justifyContent: 'center',
    marginBottom: 8,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingHorizontal: 32,
    justifyContent: 'center',
  },
  key: {
    width: 80,
    height: 72,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 1,
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  },
  keyText: {
    fontSize: 26,
  },
});
