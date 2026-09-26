import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable, TextInput, Alert, Modal, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useListUsers, useCreateUser, useUpdateUser, useDeleteUser, useResetUserPin, useListStores } from '@workspace/api-client-react';
import type { UserProfile } from '@workspace/api-client-react';
import { EmptyState } from '@/components/EmptyState';
import { LoadingState } from '@/components/LoadingState';
import { PinKeypad, PinDots } from '@/components/PinKeypad';
import { getApiErrorMessage } from '@/lib/api-error';

interface UserForm { name: string; role: 'admin' | 'store_user'; storeId: number | null; }
const BLANK: UserForm = { name: '', role: 'store_user', storeId: null };

export default function AdminUsersScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [modalVisible, setModalVisible] = useState(false);
  const [pinModal, setPinModal] = useState<{ userId: number; name: string } | null>(null);
  const [newPin, setNewPin] = useState('');
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [form, setForm] = useState<UserForm>(BLANK);
  const [createPin, setCreatePin] = useState('');
  const [showStorePicker, setShowStorePicker] = useState(false);

  const { data: users, isLoading, refetch } = useListUsers();
  const { data: stores } = useListStores();
  const { mutateAsync: create, isPending: creating } = useCreateUser();
  const { mutateAsync: update, isPending: updating } = useUpdateUser();
  const { mutateAsync: deleteUser } = useDeleteUser();
  const { mutateAsync: resetPin, isPending: resettingPin } = useResetUserPin();

  const storeMap = Object.fromEntries((stores ?? []).map((s) => [s.id, s.name]));

  const openCreate = () => { setEditingUser(null); setForm(BLANK); setCreatePin(''); setModalVisible(true); };
  const openEdit = (u: UserProfile) => {
    setEditingUser(u);
    setForm({ name: u.name, role: u.role as 'admin' | 'store_user', storeId: u.storeId ?? null });
    setCreatePin('');
    setModalVisible(true);
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) { Alert.alert('Name required'); return; }
    if (!editingUser && createPin.length < 4) { Alert.alert('PIN required', 'Enter at least a 4-digit PIN for new users.'); return; }
    try {
      if (editingUser) {
        await update({ id: editingUser.id, data: { name, role: form.role, storeId: form.storeId } });
      } else {
        await create({ data: { name, role: form.role, pin: createPin, storeId: form.storeId ?? undefined } });
      }
      setModalVisible(false);
      refetch();
    } catch (error) {
      Alert.alert('Error', getApiErrorMessage(error, 'Failed to save user.'));
    }
  };

  const handleDelete = (u: UserProfile) => {
    Alert.alert(`Delete "${u.name}"?`, 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { try { await deleteUser({ id: u.id }); refetch(); } catch { Alert.alert('Error', 'Cannot delete user.'); } } },
    ]);
  };

  const handleResetPin = async () => {
    if (!pinModal || newPin.length < 4) { Alert.alert('PIN too short', 'PIN must be at least 4 digits.'); return; }
    try {
      await resetPin({ id: pinModal.userId, data: { newPin } });
      setPinModal(null);
      setNewPin('');
      Alert.alert('PIN Reset', `PIN updated for ${pinModal.name}.`);
    } catch (error) { Alert.alert('Error', getApiErrorMessage(error, 'Failed to reset PIN.')); }
  };

  const selectedStoreName = form.storeId ? storeMap[form.storeId] : null;

  if (isLoading) return <LoadingState />;

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <FlatList
        data={users ?? []}
        keyExtractor={(u) => String(u.id)}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.avatar, { backgroundColor: item.role === 'admin' ? colors.primary + '22' : colors.muted }]}>
              <Feather name={item.role === 'admin' ? 'shield' : 'user'} size={18} color={item.role === 'admin' ? colors.primary : colors.mutedForeground} />
            </View>
            <View style={styles.cardBody}>
              <Text style={[styles.name, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>{item.name}</Text>
              <Text style={[styles.sub, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {item.role === 'admin' ? 'Admin' : `Store User${item.storeId ? ` · ${storeMap[item.storeId] ?? '?'}` : ''}`}
              </Text>
            </View>
            <Pressable style={styles.iconBtn} onPress={() => { setPinModal({ userId: item.id, name: item.name }); setNewPin(''); }}>
              <Feather name="key" size={15} color={colors.warning} />
            </Pressable>
            <Pressable style={styles.iconBtn} onPress={() => openEdit(item)}>
              <Feather name="edit-2" size={15} color={colors.primary} />
            </Pressable>
            <Pressable style={styles.iconBtn} onPress={() => handleDelete(item)}>
              <Feather name="trash-2" size={15} color={colors.destructive} />
            </Pressable>
          </View>
        )}
        ListEmptyComponent={<EmptyState icon="users" title="No users" action={{ label: 'Add User', onPress: openCreate }} />}
        showsVerticalScrollIndicator={false}
      />
      <Pressable style={[styles.fab, { backgroundColor: colors.primary, bottom: insets.bottom + 24 }]} onPress={openCreate}>
        <Feather name="plus" size={24} color="#fff" />
      </Pressable>

      {/* Create/Edit Modal */}
      <Modal visible={modalVisible} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
              {editingUser ? 'Edit User' : 'New User'}
            </Text>
            <Pressable onPress={() => setModalVisible(false)}>
              <Feather name="x" size={22} color={colors.foreground} />
            </Pressable>
          </View>
          <ScrollView style={styles.modalBody}>
            <View style={styles.formField}>
              <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>Name *</Text>
              <TextInput
                style={[styles.formInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
                value={form.name}
                onChangeText={(v) => setForm((p) => ({ ...p, name: v }))}
                placeholder="Employee name"
                placeholderTextColor={colors.mutedForeground}
              />
            </View>

            {/* Role */}
            <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium', marginBottom: 8 }]}>Role</Text>
            <View style={styles.roleRow}>
              {(['admin', 'store_user'] as const).map((r) => (
                <Pressable
                  key={r}
                  style={[styles.roleBtn, { borderColor: form.role === r ? colors.primary : colors.border, backgroundColor: form.role === r ? colors.primary + '18' : colors.card }]}
                  onPress={() => setForm((p) => ({ ...p, role: r, storeId: r === 'admin' ? null : p.storeId }))}
                >
                  <Feather name={r === 'admin' ? 'shield' : 'user'} size={16} color={form.role === r ? colors.primary : colors.mutedForeground} />
                  <Text style={[styles.roleBtnText, { color: form.role === r ? colors.primary : colors.foreground, fontFamily: form.role === r ? 'Inter_600SemiBold' : 'Inter_400Regular' }]}>
                    {r === 'admin' ? 'Admin' : 'Store User'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Store (store_user only) */}
            {form.role === 'store_user' && (
              <View style={styles.formField}>
                <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>Assigned Store</Text>
                <Pressable
                  style={[styles.formInput, styles.picker, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() => setShowStorePicker(!showStorePicker)}
                >
                  <Text style={[{ color: selectedStoreName ? colors.foreground : colors.mutedForeground, fontFamily: 'Inter_400Regular', flex: 1, fontSize: 15 }]}>
                    {selectedStoreName ?? 'Select store…'}
                  </Text>
                  <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
                </Pressable>
                {showStorePicker && (
                  <View style={[styles.dropdown, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    {(stores ?? []).map((s) => (
                      <Pressable key={s.id} style={[styles.dropdownItem, { borderBottomColor: colors.border }]} onPress={() => { setForm((p) => ({ ...p, storeId: s.id })); setShowStorePicker(false); }}>
                        <Text style={[{ color: colors.foreground, fontFamily: 'Inter_400Regular', fontSize: 14 }]}>{s.name}</Text>
                        {s.id === form.storeId && <Feather name="check" size={14} color={colors.primary} />}
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}

            {/* PIN (create only) */}
            {!editingUser && (
              <View style={styles.formField}>
                <Text style={[styles.formLabel, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>Set PIN</Text>
                <PinDots value={createPin} maxLength={6} color={colors.primary} />
                <View style={{ marginTop: 12 }}>
                  <PinKeypad value={createPin} onChange={setCreatePin} maxLength={6} />
                </View>
              </View>
            )}

            <Pressable style={[styles.saveBtn, { backgroundColor: colors.primary, marginTop: 16, marginBottom: 40 }]} onPress={handleSave} disabled={creating || updating}>
              <Text style={[styles.saveBtnText, { fontFamily: 'Inter_700Bold' }]}>{creating || updating ? 'Saving…' : 'Save User'}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      {/* PIN Reset Modal */}
      <Modal visible={!!pinModal} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modal, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
              Reset PIN — {pinModal?.name}
            </Text>
            <Pressable onPress={() => setPinModal(null)}>
              <Feather name="x" size={22} color={colors.foreground} />
            </Pressable>
          </View>
          <View style={[styles.modalBody, { alignItems: 'center', gap: 24 }]}>
            <PinDots value={newPin} maxLength={6} color={colors.primary} />
            <PinKeypad value={newPin} onChange={setNewPin} maxLength={6} />
            <Pressable style={[styles.saveBtn, { backgroundColor: colors.primary, width: '80%' }]} onPress={handleResetPin} disabled={resettingPin || newPin.length < 4}>
              <Text style={[styles.saveBtnText, { fontFamily: 'Inter_700Bold' }]}>{resettingPin ? 'Resetting…' : 'Set New PIN'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: 16 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1 },
  name: { fontSize: 15 },
  sub: { fontSize: 12, marginTop: 2 },
  iconBtn: { padding: 8 },
  fab: { position: 'absolute', right: 24, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 4, boxShadow: '0 2px 6px rgba(0,0,0,0.2)' },
  modal: { flex: 1 },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderBottomWidth: StyleSheet.hairlineWidth },
  modalTitle: { fontSize: 18 },
  modalBody: { padding: 20 },
  formField: { gap: 6, marginBottom: 16 },
  formLabel: { fontSize: 13 },
  formInput: { borderRadius: 10, borderWidth: 1, padding: 12, fontSize: 15 },
  picker: { flexDirection: 'row', alignItems: 'center' },
  dropdown: { borderRadius: 10, borderWidth: 1, marginTop: 4, overflow: 'hidden' },
  dropdownItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  roleRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  roleBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, borderWidth: 1, padding: 14 },
  roleBtnText: { fontSize: 14 },
  saveBtn: { borderRadius: 12, padding: 16, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontSize: 16 },
});
