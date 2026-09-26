import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useListStores, useListWarehouses, useListUsers, useListProducts, useListCategories } from '@workspace/api-client-react';

const SECTIONS = [
  {
    title: 'Organization',
    items: [
      { label: 'Stores', icon: 'map-pin' as const, route: '/admin/stores', countKey: 'stores', description: 'Manage locations' },
      { label: 'Warehouses', icon: 'home' as const, route: '/admin/warehouses', countKey: 'warehouses', description: 'Central inventory locations' },
      { label: 'Users', icon: 'users' as const, route: '/admin/users', countKey: 'users', description: 'PINs & roles' },
    ],
  },
  {
    title: 'Catalog',
    items: [
      { label: 'Products', icon: 'package' as const, route: '/admin/products', countKey: 'products', description: 'Chemicals & supplies' },
      { label: 'Categories', icon: 'tag' as const, route: '/admin/categories', countKey: 'categories', description: 'Product groupings' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { label: 'Backup Health', icon: 'shield' as const, route: '/admin/backup-health', countKey: null, description: 'Freshness of local & off-server copies' },
    ],
  },
  {
    title: 'Configuration',
    items: [
      { label: 'AI Settings', icon: 'cpu' as const, route: '/admin/ai-settings', countKey: null, description: 'API key & provider' },
    ],
  },
];

export default function AdminIndexScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const { data: stores } = useListStores();
  const { data: warehouses } = useListWarehouses();
  const { data: users } = useListUsers();
  const { data: products } = useListProducts();
  const { data: categories } = useListCategories();

  const counts: Record<string, number> = {
    stores: stores?.length ?? 0,
    warehouses: warehouses?.length ?? 0,
    users: users?.length ?? 0,
    products: products?.length ?? 0,
    categories: categories?.length ?? 0,
  };

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 30 }]}
      showsVerticalScrollIndicator={false}
    >
      {SECTIONS.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>
            {section.title.toUpperCase()}
          </Text>
          {section.items.map((item) => (
            <Pressable
              key={item.label}
              style={({ pressed }) => [styles.row, { backgroundColor: colors.card, borderColor: colors.border }, pressed && { opacity: 0.85 }]}
              onPress={() => router.push(item.route as any)}
            >
              <View style={[styles.rowIcon, { backgroundColor: colors.primary + '18' }]}>
                <Feather name={item.icon} size={20} color={colors.primary} />
              </View>
              <View style={styles.rowBody}>
                <Text style={[styles.rowLabel, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>{item.label}</Text>
                <Text style={[styles.rowDesc, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{item.description}</Text>
              </View>
              {item.countKey && (
                <View style={[styles.countBadge, { backgroundColor: colors.muted }]}>
                  <Text style={[styles.countText, { color: colors.mutedForeground, fontFamily: 'Inter_700Bold' }]}>
                    {counts[item.countKey]}
                  </Text>
                </View>
              )}
              <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: 16 },
  section: { marginBottom: 28 },
  sectionTitle: { fontSize: 12, letterSpacing: 0.6, marginBottom: 10 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderRadius: 14, borderWidth: 1, padding: 16, marginBottom: 8,
    elevation: 1, boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  rowIcon: { width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 16 },
  rowDesc: { fontSize: 13, marginTop: 2 },
  countBadge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  countText: { fontSize: 16 },
});
