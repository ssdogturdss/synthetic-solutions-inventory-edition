import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable, TextInput, Alert, Modal, Switch, Clipboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useListStores, useCreateStore, useUpdateStore, useDeleteStore, getBaseUrl } from '@workspace/api-client-react';
import type { Store } from '@workspace/api-client-react';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';
import { useAuth } from '@/contexts/AuthContext';
import { getApiErrorMessage } from '@/lib/api-error';

interface StoreForm { name: string; storeNumber: string; address: string; phone: string; isActive: boolean; }
const BLANK: StoreForm = { name: '', storeNumber: '', address: '', phone: '', isActive: true };

export default function AdminStoresScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { token: authToken } = useAuth();
  const [modalVisible, setModalVisible] = useState(false);
  const [editingStore, setEditingStore] = useState<Store | null>(null);
  const [form, setForm] = useState<StoreForm>(BLANK);
  const [kioskModalStore, setKioskModalStore] = useState<Store | null>(null);
  const [kioskUrl, setKioskUrl] = useState<string | null>(null);
  const [kioskLoading, setKioskLoading] = useState(false);

  const { data: stores, isLoading, refetch } = useListStores();
  const { mutateAsync: create, isPending: creating } = useCreateStore();
  const { mutateAsync: update, isPending: updating } = useUpdateStore();
  const { mutateAsync: deleteStore } = useDeleteStore();

  const openCreate = () => { setEditingStore(null); setForm(BLANK); setModalVisible(true); };
  const openEdit = (s: Store) => { setEditingStore(s); setForm({ name: s.name, storeNumber: s.storeNumber ?? '', address: s.address ?? '', phone: s.phone ?? '', isActive: s.isActive }); setModalVisible(true); };

  const handleSave = async () => {
    const name = form.name.trim();
    const storeNumber = form.storeNumber.trim();
    if (!name) { Alert.alert('Name required'); return; }
    if (!storeNumber && editingStore) { Alert.alert('Store number required'); return; }
    try {
      if (editingStore) {
        await update({
          id: editingStore.id,
          data: {
            name,
            storeNumber,
            address: form.address.trim() || undefined,
            phone: form.phone.trim() || undefined,
            isActive: form.isActive,
          },
        });
      } else {
        await create({
          data: {
            name,
            storeNumber: storeNumber || `S${Date.now()}`,
            address: form.address.trim() || undefined,
            phone: form.phone.trim() || undefined,
          },
        });
      }
      setModalVisible(false);
      refetch();
    } catch (error) {
      Alert.alert('Error', getApiErrorMessage(error, 'Failed to save store.'));
    }
  };

  const handleDelete = (s: Store) => {
    const doDelete = async () => {
      try { await deleteStore({ id: s.id }); setModalVisible(false); refetch(); }
      catch { Alert.alert('Error', 'Cannot delete store.'); }
    };
    // Alert.alert works on native; fall back to window.confirm on web
    if (typeof window !== 'undefined' && typeof (window as any).confirm === 'function') {
      if ((window as any).confirm(`Delete "${s.name}"? This cannot be undone.`)) doDelete();
    } else {
      Alert.alert(`Delete "${s.name}"?`, 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: doDelete },
      ]);
    }
  };

  const openKiosk = async (s: Store) => {
    setKioskModalStore(s);
    setKioskUrl(null);
    setKioskLoading(true);
    try {
      const base = getBaseUrl();
      const res = await fetch(`${base}api/stores/${s.id}/kiosk-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) throw new Error('Failed to generate token');
      const { token } = await res.json() as { token: string };
      const url = `${getBaseUrl()}kiosk/${s.id}?token=${token}`;
      setKioskUrl(url);
    } catch {
      Alert.alert('Error', 'Could not generate kiosk token.');
      setKioskModalStore(null);
    } finally {
      setKioskLoading(false);
    }
  };

  if (isLoading) return <LoadingState />;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <FlatList
        data={stores ?? []}
        keyExtractor={(s) => String(s.id)}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.dot, { backgroundColor: item.isActive ? colors.success : colors.mutedForeground }]} />
            <View style={styles.cardBody}>
              <Text style={[styles.name, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>{item.name}</Text>
              {item.address && <Text style={[styles.sub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{item.address}</Text>}
            </View>
            <Pressable style={styles.iconBtn} onPress={() => openKiosk(item)}>
              <Feather name="monitor" size={16} color={colors.accent} />
            </Pressable>
            <Pressable style={styles.iconBtn} onPress={() => openEdit(item)}>
              <Feather name="edit-2" size={16} color={colors.primary} />
            </Pressable>
            <Pressable style={styles.iconBtn} onPress={() => handleDelete(item)}>
              <Feather name="trash-2" size={16} color={colors.destructive} />
            </Pressable>
          </View>
        )}
        ListEmptyComponent={<EmptyState icon="map-pin" title="No stores" subtitle="Add your first store location" action={{ label: 'Add Store', onPress: openCreate }} />}
        showsVerticalScrollIndicator={false}
      />
      <Pressable style={[styles.fab, { backgroundColor: colors.primary, bottom: insets.bottom + 24 }]} onPress={openCreate}>
        <Feather name="plus" size={24} color="#fff" />
      </Pressable>

      {/* Edit / Create modal */}
      <Modal visible={modalVisible} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
              {editingStore ? 'Edit Store' : 'New Store'}
            </Text>
            <Pressable onPress={() => setModalVisible(false)}>
              <Feather name="x" size={22} color={colors.foreground} />
            </Pressable>
          </View>
          <View style={styles.modalBody}>
            {[
              { label: 'Store Name *', key: 'name' as const, placeholder: 'e.g. Highway 9 Location' },
              { label: 'Store Number', key: 'storeNumber' as const, placeholder: 'e.g. S001' },
              { label: 'Address', key: 'address' as const, placeholder: '123 Main St' },
              { label: 'Phone', key: 'phone' as const, placeholder: '(555) 000-0000' },
            ].map((f) => (
              <View key={f.key} style={styles.formField}>
                <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>{f.label}</Text>
                <TextInput
                  style={[styles.formInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
                  value={(form as any)[f.key]}
                  onChangeText={(v) => setForm((p) => ({ ...p, [f.key]: v }))}
                  placeholder={f.placeholder}
                  placeholderTextColor={colors.mutedForeground}
                />
              </View>
            ))}
            {editingStore && (
              <View style={styles.switchRow}>
                <Text style={[styles.formLabel, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]}>Active</Text>
                <Switch value={form.isActive} onValueChange={(v) => setForm((p) => ({ ...p, isActive: v }))} trackColor={{ true: colors.primary }} />
              </View>
            )}
            <Pressable style={[styles.saveBtn, { backgroundColor: colors.primary }]} onPress={handleSave} disabled={creating || updating}>
              <Text style={[styles.saveBtnText, { fontFamily: 'Inter_700Bold' }]}>{creating || updating ? 'Saving…' : 'Save Store'}</Text>
            </Pressable>
            {editingStore && (
              <Pressable
                style={[styles.deleteBtn, { borderColor: colors.destructive }]}
                onPress={() => handleDelete(editingStore)}
              >
                <Feather name="trash-2" size={15} color={colors.destructive} />
                <Text style={[styles.deleteBtnText, { color: colors.destructive, fontFamily: 'Inter_600SemiBold' }]}>
                  Delete Store
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </Modal>

      {/* Kiosk URL modal */}
      <Modal visible={kioskModalStore !== null} animationType="slide" presentationStyle="formSheet" onRequestClose={() => setKioskModalStore(null)}>
        <View style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
              Kiosk Display — {kioskModalStore?.name}
            </Text>
            <Pressable onPress={() => setKioskModalStore(null)}>
              <Feather name="x" size={22} color={colors.foreground} />
            </Pressable>
          </View>
          <View style={styles.modalBody}>
            {kioskLoading ? (
              <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>Generating link…</Text>
            ) : kioskUrl ? (
              <>
                <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
                  Open this URL on a wall-mounted tablet or display. It auto-refreshes every 60 seconds and requires no login.
                </Text>
                <View style={[styles.urlBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                  <Text style={[styles.urlText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]} selectable>
                    {kioskUrl}
                  </Text>
                </View>
                <Pressable
                  style={[styles.saveBtn, { backgroundColor: colors.accent }]}
                  onPress={() => {
                    Clipboard.setString(kioskUrl);
                    Alert.alert('Copied!', 'Kiosk URL copied to clipboard.');
                  }}
                >
                  <Feather name="copy" size={16} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={[styles.saveBtnText, { fontFamily: 'Inter_700Bold' }]}>Copy URL</Text>
                </Pressable>
                <Text style={[styles.tokenNote, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  This link is valid for 30 days. Generate a new one from this screen if it expires.
                </Text>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: 16 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardBody: { flex: 1 },
  name: { fontSize: 15 },
  sub: { fontSize: 12, marginTop: 2 },
  iconBtn: { padding: 8 },
  fab: { position: 'absolute', right: 24, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 4, boxShadow: '0 2px 6px rgba(0,0,0,0.2)' },
  modal: { flex: 1 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderBottomWidth: StyleSheet.hairlineWidth },
  modalTitle: { fontSize: 20, flex: 1, marginRight: 12 },
  modalBody: { padding: 20, gap: 16 },
  formField: { gap: 6 },
  formLabel: { fontSize: 13 },
  formInput: { borderRadius: 10, borderWidth: 1, padding: 12, fontSize: 15 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  saveBtn: { borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8, flexDirection: 'row', justifyContent: 'center' },
  saveBtnText: { color: '#fff', fontSize: 16 },
  urlBox: { borderRadius: 10, borderWidth: 1, padding: 14 },
  urlText: { fontSize: 13, lineHeight: 20 },
  tokenNote: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, borderWidth: 1, padding: 14 },
  deleteBtnText: { fontSize: 15 },
});
