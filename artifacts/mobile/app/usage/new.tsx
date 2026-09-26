import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, Alert, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';
import { useListStores, useListProducts, useCreateChemicalUsage } from '@workspace/api-client-react';
import * as Haptics from 'expo-haptics';

export default function NewChemicalUsageScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [storeId, setStoreId] = useState<number | null>(user?.storeId ?? null);
  const [productId, setProductId] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [equipment, setEquipment] = useState('');
  const [location, setLocation] = useState('');
  const [comments, setComments] = useState('');
  const [showStorePicker, setShowStorePicker] = useState(false);
  const [showProductPicker, setShowProductPicker] = useState(false);

  const { data: stores } = useListStores();
  const { data: products } = useListProducts({ activeOnly: true });
  const { mutateAsync: create, isPending } = useCreateChemicalUsage();

  const selectedStore = (stores ?? []).find((s) => s.id === storeId);
  const selectedProduct = (products ?? []).find((p) => p.id === productId);

  const handleSubmit = async () => {
    if (!storeId) { Alert.alert('Select Store'); return; }
    if (!productId) { Alert.alert('Select Product'); return; }
    if (!amount || parseFloat(amount) <= 0) { Alert.alert('Enter Amount', 'Enter a valid amount pulled.'); return; }

    try {
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await create({
        data: {
          storeId,
          productId,
          amountPulled: amount,
          reason: reason || undefined,
          equipment: equipment || undefined,
          location: location || undefined,
          comments: comments || undefined,
        },
      });
      router.back();
    } catch {
      Alert.alert('Error', 'Failed to record pull. Try again.');
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]} keyboardShouldPersistTaps="handled">

        {/* Store */}
        <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>STORE</Text>
        {isAdmin ? (
          <>
            <Pressable style={[styles.picker, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => { setShowStorePicker(!showStorePicker); setShowProductPicker(false); }}>
              <Feather name="map-pin" size={16} color={colors.mutedForeground} />
              <Text style={[styles.pickerText, { color: selectedStore ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {selectedStore?.name ?? 'Select store…'}
              </Text>
              <Feather name={showStorePicker ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
            </Pressable>
            {showStorePicker && (
              <View style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {(stores ?? []).filter((s) => s.isActive).map((s) => (
                  <Pressable key={s.id} style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setStoreId(s.id); setShowStorePicker(false); }}>
                    <Text style={[styles.dropdownText, { color: s.id === storeId ? colors.primary : colors.foreground, fontFamily: 'Inter_400Regular' }]}>{s.name}</Text>
                    {s.id === storeId && <Feather name="check" size={15} color={colors.primary} />}
                  </Pressable>
                ))}
              </View>
            )}
          </>
        ) : (
          <View style={[styles.picker, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <Feather name="map-pin" size={16} color={colors.mutedForeground} />
            <Text style={[styles.pickerText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>{selectedStore?.name ?? 'Your store'}</Text>
          </View>
        )}

        {/* Product */}
        <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 20 }]}>CHEMICAL / PRODUCT</Text>
        <Pressable style={[styles.picker, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={() => { setShowProductPicker(!showProductPicker); setShowStorePicker(false); }}>
          <Feather name="droplet" size={16} color={colors.mutedForeground} />
          <Text style={[styles.pickerText, { color: selectedProduct ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            {selectedProduct?.name ?? 'Select chemical…'}
          </Text>
          <Feather name={showProductPicker ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
        </Pressable>
        {showProductPicker && (
          <View style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.border, maxHeight: 180 }]}>
            <ScrollView nestedScrollEnabled>
              {(products ?? []).map((p) => (
                <Pressable key={p.id} style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setProductId(p.id); setShowProductPicker(false); }}>
                  <Text style={[styles.dropdownText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>{p.name}</Text>
                  {p.id === productId && <Feather name="check" size={15} color={colors.primary} />}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Amount */}
        <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 20 }]}>AMOUNT PULLED</Text>
        <View style={[styles.amountRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            style={[styles.amountInput, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={colors.mutedForeground}
          />
          <Text style={[styles.amountUnit, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            {selectedProduct?.unit ?? 'units'}
          </Text>
        </View>

        {/* Optional fields */}
        <Text style={[styles.label, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginTop: 20 }]}>DETAILS (OPTIONAL)</Text>
        {[
          { label: 'Reason / Purpose', value: reason, set: setReason, placeholder: 'e.g. Pre-treat application' },
          { label: 'Equipment', value: equipment, set: setEquipment, placeholder: 'e.g. Foam cannon #2' },
          { label: 'Location / Bay', value: location, set: setLocation, placeholder: 'e.g. Bay 3' },
          { label: 'Comments', value: comments, set: setComments, placeholder: 'Additional notes…' },
        ].map((f) => (
          <View key={f.label} style={styles.fieldRow}>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{f.label}</Text>
            <TextInput
              style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
              value={f.value}
              onChangeText={f.set}
              placeholder={f.placeholder}
              placeholderTextColor={colors.mutedForeground}
            />
          </View>
        ))}

        <Pressable
          style={({ pressed }) => [styles.submitBtn, { backgroundColor: colors.primary }, pressed && { opacity: 0.85 }, isPending && { opacity: 0.7 }]}
          onPress={handleSubmit}
          disabled={isPending}
        >
          <Feather name="droplet" size={18} color="#fff" />
          <Text style={[styles.submitText, { fontFamily: 'Inter_700Bold' }]}>{isPending ? 'Recording…' : 'Record Pull'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: 20 },
  label: { fontSize: 12, letterSpacing: 0.6, marginBottom: 8 },
  picker: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 4 },
  pickerText: { flex: 1, fontSize: 14 },
  dropdown: { borderRadius: 12, borderWidth: 1, marginBottom: 8, overflow: 'hidden' },
  dropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  dropdownText: { fontSize: 14 },
  amountRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  amountInput: { flex: 1, fontSize: 32 },
  amountUnit: { fontSize: 16 },
  fieldRow: { marginBottom: 10 },
  fieldLabel: { fontSize: 12, marginBottom: 4 },
  fieldInput: { borderRadius: 10, borderWidth: 1, padding: 12, fontSize: 14 },
  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 14, padding: 18, marginTop: 20 },
  submitText: { color: '#fff', fontSize: 17 },
});
