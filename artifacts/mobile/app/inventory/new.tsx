import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { useListStores, useListWarehouses, useCreateInventorySession } from '@workspace/api-client-react';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import * as Haptics from 'expo-haptics';

export default function NewInventorySession() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [selectedStoreId, setSelectedStoreId] = useState<number | null>(
    user?.storeId ?? null
  );
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [showStorePicker, setShowStorePicker] = useState(false);
  const [showWarehousePicker, setShowWarehousePicker] = useState(false);

  const { data: stores } = useListStores();
  const { data: warehouses } = useListWarehouses();
  const { mutateAsync: createSession, isPending } = useCreateInventorySession();

  const selectedStore = (stores ?? []).find((s) => s.id === selectedStoreId);
  const selectedWarehouse = (warehouses ?? []).find((w) => w.id === selectedWarehouseId);

  const handleCreate = async () => {
    if (!selectedStoreId) {
      Alert.alert('Select a Store', 'Please select a store to count.');
      return;
    }
    try {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const session = await createSession({ data: { storeId: selectedStoreId, warehouseId: selectedWarehouseId ?? undefined, notes: notes || undefined } });
      router.replace(`/inventory/${session.id}`);
    } catch {
      Alert.alert('Error', 'Failed to create session. Please try again.');
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
        keyboardShouldPersistTaps="handled"
        bottomOffset={20}
      >
        {/* Store picker */}
        <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
          STORE
        </Text>
        {isAdmin ? (
          <>
            <Pressable
              style={[styles.picker, { backgroundColor: colors.card, borderColor: colors.border }]}
              onPress={() => setShowStorePicker(!showStorePicker)}
            >
              <Feather name="map-pin" size={16} color={colors.mutedForeground} />
              <Text style={[styles.pickerText, { color: selectedStore ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {selectedStore?.name ?? 'Select a store…'}
              </Text>
              <Feather name={showStorePicker ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
            </Pressable>
            {showStorePicker && (
              <View style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {(stores ?? []).filter((s) => s.isActive).map((s) => (
                  <Pressable
                    key={s.id}
                    style={[styles.dropdownItem, { borderBottomColor: colors.border }]}
                    onPress={() => { setSelectedStoreId(s.id); setShowStorePicker(false); }}
                  >
                    <Text style={[styles.dropdownText, { color: s.id === selectedStoreId ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>
                      {s.name}
                    </Text>
                    {s.id === selectedStoreId && <Feather name="check" size={16} color={colors.primary} />}
                  </Pressable>
                ))}
              </View>
            )}
          </>
        ) : (
          <View style={[styles.picker, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Feather name="map-pin" size={16} color={colors.mutedForeground} />
            <Text style={[styles.pickerText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>
              {selectedStore?.name ?? 'Your assigned store'}
            </Text>
          </View>
        )}

        <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 20 }]}>
          WAREHOUSE (OPTIONAL)
        </Text>
        <Pressable
          style={[styles.picker, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => setShowWarehousePicker(!showWarehousePicker)}
        >
          <Feather name="home" size={16} color={colors.mutedForeground} />
          <Text style={[styles.pickerText, { color: selectedWarehouse ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            {selectedWarehouse?.name ?? 'No warehouse selected'}
          </Text>
          <Feather name={showWarehousePicker ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
        </Pressable>
        {showWarehousePicker && (
          <View style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Pressable style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setSelectedWarehouseId(null); setShowWarehousePicker(false); }}>
              <Text style={[styles.dropdownText, { color: !selectedWarehouseId ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>No warehouse selected</Text>
              {!selectedWarehouseId && <Feather name="check" size={16} color={colors.primary} />}
            </Pressable>
            {(warehouses ?? []).filter((w) => w.isActive).map((w) => (
              <Pressable key={w.id} style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setSelectedWarehouseId(w.id); setShowWarehousePicker(false); }}>
                <Text style={[styles.dropdownText, { color: w.id === selectedWarehouseId ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>{w.name}</Text>
                {w.id === selectedWarehouseId && <Feather name="check" size={16} color={colors.primary} />}
              </Pressable>
            ))}
          </View>
        )}

        {/* Notes */}
        <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 24 }]}>
          NOTES (OPTIONAL)
        </Text>
        <TextInput
          style={[styles.textarea, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
          placeholder="e.g. Monthly count, after delivery…"
          placeholderTextColor={colors.mutedForeground}
          value={notes}
          onChangeText={setNotes}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />

        {/* Info card */}
        <View style={[styles.infoCard, { backgroundColor: colors.primary + '12', borderColor: colors.primary + '30' }]}>
          <Feather name="info" size={16} color={colors.primary} />
          <Text style={[styles.infoText, { color: colors.primary, fontFamily: 'Inter_400Regular' }]}>
            A new session will open. You can scan barcodes, add counts, and finalize when done.
          </Text>
        </View>

        {/* Create button */}
        <Pressable
          style={({ pressed }) => [styles.createBtn, { backgroundColor: colors.primary }, pressed && { opacity: 0.85 }, isPending && { opacity: 0.7 }]}
          onPress={handleCreate}
          disabled={isPending}
        >
          <Feather name="clipboard" size={18} color="#fff" />
          <Text style={[styles.createText, { fontFamily: 'Inter_700Bold' }]}>
            {isPending ? 'Creating…' : 'Start Count Session'}
          </Text>
        </Pressable>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: 20 },
  label: { fontSize: 12, letterSpacing: 0.6, marginBottom: 8 },
  picker: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, padding: 16,
  },
  pickerText: { flex: 1, fontSize: 15 },
  dropdown: { borderRadius: 12, borderWidth: 1, marginTop: 4, overflow: 'hidden' },
  dropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  dropdownText: { fontSize: 15 },
  textarea: { borderRadius: 12, borderWidth: 1, padding: 14, fontSize: 15, minHeight: 80 },
  infoCard: { flexDirection: 'row', gap: 10, borderRadius: 12, borderWidth: 1, padding: 14, marginTop: 20 },
  infoText: { flex: 1, fontSize: 13, lineHeight: 18 },
  createBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 14, padding: 18, marginTop: 24 },
  createText: { color: '#fff', fontSize: 17 },
});
