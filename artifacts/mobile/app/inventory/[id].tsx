import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable, TextInput,
  Alert, Platform, ActivityIndicator, ScrollView, Animated,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import {
  useGetInventorySession, useListProducts, useFinalizeInventorySession,
  useUpsertInventorySessionItems, useAdminEditInventorySessionItems,
} from '@workspace/api-client-react';
import type { InventoryItemInput, Product } from '@workspace/api-client-react';
import { LoadingState } from '@/components/LoadingState';
import { BarcodeScannerSheet } from '@/components/BarcodeScannerSheet';
import { useAuth } from '@/contexts/AuthContext';
import * as Haptics from 'expo-haptics';

/** AsyncStorage key for the unsaved draft of a given session. */
function draftKey(sessionId: number) {
  return `inventory-draft-${sessionId}`;
}

interface LineItem {
  productId: number;
  full: string;
  partial: string;
  pct: string;
  comments: string;
}

export default function InventorySessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const sessionId = parseInt(id, 10);

  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const { data: session, isLoading: loadingSession, refetch } = useGetInventorySession(sessionId);
  const { data: products, isLoading: loadingProducts } = useListProducts({ activeOnly: true });
  const { mutateAsync: saveItems, isPending: saving } = useUpsertInventorySessionItems();
  const { mutateAsync: finalize, isPending: finalizing } = useFinalizeInventorySession();
  const { mutateAsync: adminSaveItems, isPending: adminSaving } = useAdminEditInventorySessionItems();

  const [items, setItems] = useState<Record<number, LineItem>>({});
  const [search, setSearch] = useState('');
  const [saved, setSaved] = useState(false);
  const [adminSaved, setAdminSaved] = useState(false);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [highlightedProductId, setHighlightedProductId] = useState<number | null>(null);
  const [quickAddMode, setQuickAddMode] = useState(false);
  const [showAllUsage, setShowAllUsage] = useState(false);
  const [showZeroUsage, setShowZeroUsage] = useState(false);

  // Tracks whether the AsyncStorage draft check has completed, so the server
  // pre-fill effect knows whether a local draft already loaded.
  const [draftChecked, setDraftChecked] = useState(false);
  const hasDraftRef = useRef(false);

  // Prevents stale state-setter calls after unmount (timers, animation callbacks).
  const mountedRef = useRef(true);

  // Undo last scan or manual edit
  interface UndoEntry {
    productId: number;
    productName: string;
    /** Which LineItem field the undo restores. */
    field: keyof Omit<LineItem, 'productId'>;
    /** Value to restore when undoing. */
    previousValue: string;
    /**
     * When true, undo removes the entire line item instead of just restoring
     * the field value.  Only set for scan-created rows where the product had
     * no entry at all before the scan — never for manual edits, because other
     * fields (Partial, % Full) may already have values.
     */
    removeEntireItem?: boolean;
    /** Short description shown in the toast. */
    toastLabel: string;
  }
  const [undoEntry, setUndoEntry] = useState<UndoEntry | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoOpacity = useRef(new Animated.Value(0)).current;

  // Clear all pending timers and animations on unmount so no callbacks fire
  // after the component is gone (keeps the Jest test runner exit clean too).
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
      undoOpacity.stopAnimation();
    };
  }, [undoOpacity]);

  const dismissUndo = useCallback(() => {
    Animated.timing(undoOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      if (mountedRef.current) setUndoEntry(null);
    });
  }, [undoOpacity]);

  const showUndoToast = useCallback((entry: UndoEntry) => {
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setUndoEntry(entry);
    Animated.timing(undoOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    undoTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) dismissUndo();
    }, 5000);
  }, [undoOpacity, dismissUndo]);

  const handleUndo = useCallback(() => {
    if (!undoEntry) return;
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setItems((prev) => {
      if (undoEntry.removeEntireItem) {
        // Scan created this row with no prior data — remove the entry entirely
        const next = { ...prev };
        delete next[undoEntry.productId];
        return next;
      }
      const existing = prev[undoEntry.productId];
      return {
        ...prev,
        [undoEntry.productId]: {
          ...(existing ?? { productId: undoEntry.productId, full: '', partial: '0', pct: '', comments: '' }),
          [undoEntry.field]: undoEntry.previousValue,
        },
      };
    });
    setSaved(false);
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Animated.timing(undoOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
      if (mountedRef.current) setUndoEntry(null);
    });
  }, [undoEntry, undoOpacity]);

  // Map of productId → "Full" TextInput ref, used for auto-focus after scan
  const inputRefs = useRef<Map<number, TextInput>>(new Map());

  /**
   * Snapshot of the field value captured when a TextInput receives focus.
   * Used by the onBlur handler to detect whether the value actually changed
   * and to populate the undo toast with the pre-edit value.
   */
  const editSnapshotRef = useRef<{
    productId: number;
    field: keyof Omit<LineItem, 'productId'>;
    value: string;
  } | null>(null);
  const flatListRef = useRef<FlatList<Product>>(null);

  /**
   * Tracks the last timestamp (ms) at which the normal-mode duplicate-scan
   * alert was triggered for each product.  Used to debounce rapid re-scans of
   * the same barcode so an accidental double-scan cannot fire the alert twice.
   * Quick-add mode bypasses this entirely.
   */
  const lastNormalScanTimeRef = useRef<Map<number, number>>(new Map());
  /** How long (ms) to ignore a second normal-mode scan of the same product. */
  const NORMAL_SCAN_COOLDOWN_MS = 800;

  const isFinalized = session?.status === 'finalized';

  // Build a lookup of previous session counts (productId → previous count string)
  const previousItemMap = React.useMemo<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    for (const pi of session?.previousItems ?? []) {
      map[pi.productId] = pi.estimatedGallons ?? String(pi.fullContainers);
    }
    return map;
  }, [session?.previousItems]);

  const filteredProducts = (products ?? []).filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.productNumber ?? '').toLowerCase().includes(search.toLowerCase())
  );

  // Restore any unsaved draft from AsyncStorage on mount (runs once per session).
  // This preserves counts accumulated before the app was backgrounded/killed.
  React.useEffect(() => {
    AsyncStorage.getItem(draftKey(sessionId)).then((raw) => {
      if (!mountedRef.current) return;
      if (raw) {
        try {
          const draft: Record<number, LineItem> = JSON.parse(raw);
          // Only apply the draft if no items have been set yet (server pre-fill
          // hasn't run, or session had no saved items).
          setItems((prev) => {
            if (Object.keys(prev).length === 0) {
              hasDraftRef.current = true;
              return draft;
            }
            return prev;
          });
        } catch {
          // Corrupt draft — ignore it.
        }
      }
      if (mountedRef.current) setDraftChecked(true);
    }).catch(() => {
      if (mountedRef.current) setDraftChecked(true);
    });
  }, [sessionId]);

  // Pre-fill items from existing session data, but only when:
  //   a) the draft check has completed, AND
  //   b) no local draft was restored (the draft is the authoritative unsaved state).
  React.useEffect(() => {
    if (!draftChecked || hasDraftRef.current) return;
    if (session?.items?.length && Object.keys(items).length === 0) {
      const prefilled: Record<number, LineItem> = {};
      for (const i of session.items) {
        prefilled[i.productId] = {
          productId: i.productId,
          full: String(i.fullContainers),
          partial: String(i.partialContainers),
          pct: i.estimatedPercentage ?? '',
          comments: i.comments ?? '',
        };
      }
      setItems(prefilled);
      // Server data is already saved — mark clean so back-navigation
      // doesn't warn when the user hasn't made any edits yet.
      setSaved(true);
    }
  }, [session?.items, draftChecked]);

  // Warn staff when they attempt to navigate away with unsaved counts.
  // The draft is preserved in AsyncStorage so no data is lost on confirm.
  React.useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e: any) => {
      // No warning needed for finalized sessions (non-admin can't edit anyway)
      // or when there are no items entered yet, or when counts are already saved.
      const hasItems = Object.keys(items).length > 0;
      if (saved || !hasItems || (isFinalized && !isAdmin)) {
        return;
      }
      // Prevent the default navigation action while the alert is shown.
      e.preventDefault();
      Alert.alert(
        'Unsaved Counts',
        'You have unsaved counts — leave anyway? Your draft will be kept for next time.',
        [
          { text: 'Stay', style: 'cancel' },
          {
            text: 'Leave',
            style: 'destructive',
            onPress: () => navigation.dispatch(e.data.action),
          },
        ]
      );
    });
    return unsubscribe;
  }, [navigation, saved, items, isFinalized, isAdmin]);

  const updateItem = useCallback((productId: number, field: keyof Omit<LineItem, 'productId'>, value: string) => {
    setItems((prev) => {
      const next = {
        ...prev,
        [productId]: {
          ...(prev[productId] ?? { productId, full: '', partial: '0', pct: '', comments: '' }),
          [field]: value,
        },
      };
      // Persist unsaved counts so backgrounding the app cannot cause data loss.
      AsyncStorage.setItem(draftKey(sessionId), JSON.stringify(next)).catch(() => {});
      return next;
    });
    setSaved(false);
  }, [sessionId]);

  const handleSave = async () => {
    const toSave = Object.values(items).filter((i) => i.full !== '' && !isNaN(parseInt(i.full)));
    if (toSave.length === 0) {
      Alert.alert('No Items', 'Enter counts for at least one product.');
      return;
    }
    const payload: InventoryItemInput[] = toSave.map((i) => ({
      productId: i.productId,
      fullContainers: parseInt(i.full) || 0,
      partialContainers: parseInt(i.partial) || 0,
      estimatedPercentage: i.pct || undefined,
      comments: i.comments || undefined,
    }));
    try {
      await saveItems({ id: sessionId, data: { items: payload } });
      // Draft has been committed to the server — clear it so a future mount
      // doesn't re-apply stale local counts.
      AsyncStorage.removeItem(draftKey(sessionId)).catch(() => {});
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSaved(true);
      refetch();
    } catch {
      Alert.alert('Error', 'Failed to save items.');
    }
  };

  const handleFinalize = async () => {
    Alert.alert(
      'Finalize Session',
      'This will compute usage and close the session. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Finalize',
          style: 'destructive',
          onPress: async () => {
            try {
              if (Object.keys(items).length > 0) await handleSave();
              await finalize({ id: sessionId });
              // Ensure draft is cleared even when handleSave was skipped.
              AsyncStorage.removeItem(draftKey(sessionId)).catch(() => {});
              if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              refetch();
            } catch {
              Alert.alert('Error', 'Failed to finalize session.');
            }
          },
        },
      ]
    );
  };

  /** Scroll to and highlight a product row after a scan */
  const scrollAndHighlight = useCallback((productId: number, allProducts: Product[]) => {
    setSearch('');
    setHighlightedProductId(productId);
    const index = allProducts.findIndex((p) => p.id === productId);
    if (index >= 0) {
      setTimeout(() => {
        if (!mountedRef.current) return;
        flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
      }, 100);
    }
    setTimeout(() => {
      if (mountedRef.current) setHighlightedProductId(null);
    }, 3000);
  }, []);

  const handleBarcodeScan = useCallback((code: string) => {
    const allProducts = products ?? [];
    const match = allProducts.find(
      (p) => (p.productNumber ?? '').toLowerCase() === code.toLowerCase()
    );

    if (!match) {
      Alert.alert('No Product Found', `No product matched barcode "${code}".`);
      return;
    }

    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }

    const existingFull = items[match.id]?.full;
    const hasPriorCount = existingFull !== undefined && existingFull !== '';

    if (quickAddMode) {
      // Quick-add: always increment fullContainers by 1
      const current = hasPriorCount ? parseInt(existingFull!, 10) || 0 : 0;
      updateItem(match.id, 'full', String(current + 1));
      scrollAndHighlight(match.id, allProducts);
      showUndoToast({ productId: match.id, productName: match.name, field: 'full', previousValue: hasPriorCount ? existingFull! : '', removeEntireItem: !hasPriorCount, toastLabel: '+1 scan' });
      return;
    }

    if (hasPriorCount) {
      // Debounce: ignore duplicate scans of the same product within the cooldown
      // window so that an accidental double-scan can't fire the alert twice.
      const now = Date.now();
      const lastScan = lastNormalScanTimeRef.current.get(match.id) ?? 0;
      if (now - lastScan < NORMAL_SCAN_COOLDOWN_MS) {
        return; // silently drop the duplicate scan
      }
      lastNormalScanTimeRef.current.set(match.id, now);

      // Product already has a count — ask what to do
      const currentCount = existingFull!;
      Alert.alert(
        match.name,
        `Already counted: ${currentCount} full container${parseInt(currentCount, 10) !== 1 ? 's' : ''}.\nWhat would you like to do?`,
        [
          {
            text: 'Add 1 More',
            onPress: () => {
              const next = (parseInt(currentCount, 10) || 0) + 1;
              updateItem(match.id, 'full', String(next));
              scrollAndHighlight(match.id, allProducts);
              showUndoToast({ productId: match.id, productName: match.name, field: 'full', previousValue: currentCount, toastLabel: '+1 scan' });
            },
          },
          {
            text: 'Replace Count',
            onPress: () => {
              scrollAndHighlight(match.id, allProducts);
              setTimeout(() => {
                const inputRef = inputRefs.current.get(match.id);
                inputRef?.focus();
                inputRef?.setNativeProps?.({ selection: { start: 0, end: currentCount.length } });
              }, 400);
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    // No prior count — scroll to product and focus its input
    scrollAndHighlight(match.id, allProducts);
    setTimeout(() => {
      const inputRef = inputRefs.current.get(match.id);
      inputRef?.focus();
    }, 350);
  }, [products, items, quickAddMode, updateItem, scrollAndHighlight]);

  const handleAdminSave = async () => {
    const toSave = Object.values(items).filter((i) => i.full !== '' && !isNaN(parseInt(i.full)));
    if (toSave.length === 0) {
      Alert.alert('No Items', 'Enter counts for at least one product.');
      return;
    }
    const payload: InventoryItemInput[] = toSave.map((i) => ({
      productId: i.productId,
      fullContainers: parseInt(i.full) || 0,
      partialContainers: parseInt(i.partial) || 0,
      estimatedPercentage: i.pct || undefined,
      comments: i.comments || undefined,
    }));
    try {
      await adminSaveItems({ id: sessionId, data: { items: payload } });
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setAdminSaved(true);
      refetch();
    } catch {
      Alert.alert('Error', 'Failed to save edited items.');
    }
  };

  if (loadingSession || loadingProducts) return <LoadingState message="Loading session…" />;

  // Admin can edit even finalized sessions
  const adminEditMode = isFinalized && isAdmin;

  const renderProduct = ({ item: product }: { item: Product }) => {
    const line = items[product.id];
    const hasCount = line?.full !== '' && line?.full !== undefined;
    const isHighlighted = highlightedProductId === product.id;
    const prevCount = previousItemMap[product.id];

    // Full input is "unfilled" (yellow) when no value has been entered yet
    const fullUnfilled = !hasCount;

    return (
      <View style={[
        styles.productRow,
        {
          backgroundColor: colors.card,
          borderColor: isHighlighted
            ? colors.primary
            : hasCount
              ? colors.primary + '40'
              : colors.border,
        },
        isHighlighted && (Platform.OS === 'web'
          ? { boxShadow: `0 2px 8px ${colors.primary}4d` } as any
          : { shadowColor: colors.primary, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4 }),
      ]}>
        <View style={styles.productHeader}>
          <View style={styles.productTitleRow}>
            <Text style={[styles.productName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]} numberOfLines={1}>
              {product.name}
            </Text>
            {hasCount && !adminEditMode && <Feather name="check-circle" size={14} color={colors.success} />}
            {isHighlighted && (
              <View style={[styles.scannedBadge, { backgroundColor: colors.primary + '22' }]}>
                <Feather name="zap" size={11} color={colors.primary} />
                <Text style={[styles.scannedBadgeText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>Scanned</Text>
              </View>
            )}
          </View>
          <View style={styles.productMeta}>
            {product.unit && (
              <Text style={[styles.productUnit, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {product.unit}
              </Text>
            )}
            {prevCount !== undefined && (
              <Text style={[styles.prevCount, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                Last: <Text style={{ fontFamily: 'Inter_500Medium' }}>{prevCount}</Text>
              </Text>
            )}
          </View>
        </View>

        {/* Active session inputs — also shown in admin edit mode on finalized sessions */}
        {(!isFinalized || adminEditMode) && (
          <View style={styles.countRow}>
            <View style={styles.countField}>
              <Text style={[styles.countLabel, { color: fullUnfilled ? '#b45309' : colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>Full</Text>
              <TextInput
                ref={(r) => {
                  if (r) inputRefs.current.set(product.id, r);
                  else inputRefs.current.delete(product.id);
                }}
                style={[
                  styles.countInput,
                  {
                    backgroundColor: fullUnfilled ? '#fef9c3' : colors.background,
                    borderColor: fullUnfilled
                      ? '#fbbf24'
                      : isHighlighted ? colors.primary : colors.border,
                    color: colors.foreground,
                    fontFamily: 'Inter_500Medium',
                  },
                ]}
                value={line?.full ?? ''}
                onChangeText={(v) => updateItem(product.id, 'full', v.replace(/[^0-9]/g, ''))}
                onFocus={() => {
                  editSnapshotRef.current = { productId: product.id, field: 'full', value: items[product.id]?.full ?? '' };
                }}
                onBlur={() => {
                  const snap = editSnapshotRef.current;
                  if (snap && snap.productId === product.id && snap.field === 'full') {
                    const newVal = items[product.id]?.full ?? '';
                    if (newVal !== snap.value) {
                      // Pass snap.value verbatim (may be '') — never undefined — so undo
                      // restores only the Full field without removing the whole item.
                      showUndoToast({ productId: product.id, productName: product.name, field: 'full', previousValue: snap.value, toastLabel: 'Full edited' });
                    }
                    editSnapshotRef.current = null;
                  }
                }}
                keyboardType="number-pad"
                placeholder="—"
                placeholderTextColor={fullUnfilled ? '#b45309' : colors.mutedForeground}
                maxLength={4}
                editable={!isFinalized || adminEditMode}
              />
            </View>
            <View style={styles.countField}>
              <Text style={[styles.countLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>Partial</Text>
              <TextInput
                style={[styles.countInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_500Medium' }]}
                value={line?.partial ?? ''}
                onChangeText={(v) => updateItem(product.id, 'partial', v.replace(/[^0-9]/g, ''))}
                onFocus={() => {
                  editSnapshotRef.current = { productId: product.id, field: 'partial', value: items[product.id]?.partial ?? '' };
                }}
                onBlur={() => {
                  const snap = editSnapshotRef.current;
                  if (snap && snap.productId === product.id && snap.field === 'partial') {
                    const newVal = items[product.id]?.partial ?? '';
                    if (newVal !== snap.value) {
                      showUndoToast({ productId: product.id, productName: product.name, field: 'partial', previousValue: snap.value, toastLabel: 'Partial edited' });
                    }
                    editSnapshotRef.current = null;
                  }
                }}
                keyboardType="number-pad"
                placeholder="0"
                placeholderTextColor={colors.mutedForeground}
                maxLength={4}
                editable={!isFinalized || adminEditMode}
              />
            </View>
            <View style={styles.countField}>
              <Text style={[styles.countLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>% Full</Text>
              <TextInput
                style={[styles.countInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_500Medium' }]}
                value={line?.pct ?? ''}
                onChangeText={(v) => updateItem(product.id, 'pct', v.replace(/[^0-9.]/g, ''))}
                onFocus={() => {
                  editSnapshotRef.current = { productId: product.id, field: 'pct', value: items[product.id]?.pct ?? '' };
                }}
                onBlur={() => {
                  const snap = editSnapshotRef.current;
                  if (snap && snap.productId === product.id && snap.field === 'pct') {
                    const newVal = items[product.id]?.pct ?? '';
                    if (newVal !== snap.value) {
                      showUndoToast({ productId: product.id, productName: product.name, field: 'pct', previousValue: snap.value, toastLabel: '% Full edited' });
                    }
                    editSnapshotRef.current = null;
                  }
                }}
                keyboardType="decimal-pad"
                placeholder="—"
                placeholderTextColor={colors.mutedForeground}
                maxLength={5}
                editable={!isFinalized || adminEditMode}
              />
            </View>
          </View>
        )}

        {/* Read-only finalized view (non-admin) */}
        {isFinalized && !adminEditMode && line && (
          <View style={styles.countRow}>
            <Text style={[styles.finalText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
              {line.full} full · {line.partial} partial {line.pct ? `· ${line.pct}%` : ''}
            </Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Status bar */}
      <View style={[styles.statusBar, { backgroundColor: isFinalized ? colors.success + '18' : colors.warning + '18', borderBottomColor: colors.border }]}>
        <View style={[styles.statusDot, { backgroundColor: isFinalized ? colors.success : colors.warning }]} />
        <Text style={[styles.statusText, { color: isFinalized ? colors.success : colors.warning, fontFamily: 'Inter_600SemiBold' }]}>
          {isFinalized ? 'Finalized' : 'Open — In Progress'}
        </Text>
        <Text style={[styles.countedText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
          {Object.keys(items).length} / {products?.length ?? 0} counted
        </Text>
      </View>

      {/* Search + Scan button */}
      {!isFinalized && (
        <View style={[styles.searchWrap, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
            placeholder="Search products…"
            placeholderTextColor={colors.mutedForeground}
            value={search}
            onChangeText={setSearch}
            returnKeyType="search"
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')}>
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </Pressable>
          )}
          <Pressable
            style={[
              styles.quickAddBtn,
              {
                backgroundColor: quickAddMode ? colors.primary : colors.secondary,
                borderColor: quickAddMode ? colors.primary : colors.border,
              },
            ]}
            onPress={() => setQuickAddMode((v) => !v)}
            accessibilityLabel={quickAddMode ? 'Quick-add mode on: tap to disable' : 'Quick-add mode off: tap to enable'}
            accessibilityRole="button"
          >
            <Feather name="plus-circle" size={14} color={quickAddMode ? '#fff' : colors.mutedForeground} />
            <Text style={[styles.scanBtnText, { color: quickAddMode ? '#fff' : colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>+1</Text>
          </Pressable>
          <Pressable
            style={[styles.scanBtn, { backgroundColor: colors.primary + '18', borderColor: colors.primary + '40' }]}
            onPress={() => setScannerVisible(true)}
            accessibilityLabel="Scan barcode"
            accessibilityRole="button"
          >
            <Feather name="camera" size={16} color={colors.primary} />
            <Text style={[styles.scanBtnText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>Scan</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        ref={flatListRef}
        data={filteredProducts}
        keyExtractor={(p) => String(p.id)}
        renderItem={renderProduct}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 120 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onScrollToIndexFailed={() => {
          // Gracefully ignore scroll failures (e.g. item not yet rendered)
        }}
      />

      {/* Bottom actions — active sessions */}
      {!isFinalized && (
        <View style={[styles.bottomBar, { backgroundColor: colors.background, borderTopColor: colors.border, paddingBottom: insets.bottom + 8 }]}>
          <Pressable
            style={({ pressed }) => [styles.saveBtn, { backgroundColor: colors.secondary, borderColor: colors.border }, pressed && { opacity: 0.8 }, saving && { opacity: 0.7 }]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? <ActivityIndicator size="small" color={colors.primary} /> : <Feather name="save" size={16} color={colors.primary} />}
            <Text style={[styles.saveBtnText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
              {saved ? 'Saved' : 'Save Draft'}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.finalizeBtn, { backgroundColor: colors.primary }, pressed && { opacity: 0.85 }, finalizing && { opacity: 0.7 }]}
            onPress={handleFinalize}
            disabled={finalizing}
          >
            {finalizing ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="check-square" size={16} color="#fff" />}
            <Text style={[styles.finalizeBtnText, { fontFamily: 'Inter_700Bold' }]}>Finalize</Text>
          </Pressable>
        </View>
      )}

      {/* Admin edit bar — finalized sessions, admin only */}
      {adminEditMode && (
        <View style={[styles.bottomBar, { backgroundColor: colors.background, borderTopColor: colors.border, paddingBottom: insets.bottom + 8 }]}>
          <View style={[styles.adminBadge, { backgroundColor: colors.warning + '22', borderColor: colors.warning + '55' }]}>
            <Feather name="edit-2" size={13} color={colors.warning} />
            <Text style={[styles.adminBadgeText, { color: colors.warning, fontFamily: 'Inter_600SemiBold' }]}>Admin Edit</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.finalizeBtn, { backgroundColor: colors.primary }, pressed && { opacity: 0.85 }, adminSaving && { opacity: 0.7 }]}
            onPress={handleAdminSave}
            disabled={adminSaving}
          >
            {adminSaving ? <ActivityIndicator size="small" color="#fff" /> : <Feather name="save" size={16} color="#fff" />}
            <Text style={[styles.finalizeBtnText, { fontFamily: 'Inter_700Bold' }]}>
              {adminSaved ? 'Saved' : 'Save Changes'}
            </Text>
          </Pressable>
        </View>
      )}

      {/* Usage summary for finalized sessions */}
      {isFinalized && session?.usageSummary && session.usageSummary.length > 0 && (() => {
        const nonZero = session.usageSummary.filter((u) => parseFloat(u.usage) > 0);
        const zeroItems = session.usageSummary.filter((u) => parseFloat(u.usage) <= 0);
        const PREVIEW = 5;
        const hasMore = nonZero.length > PREVIEW;
        const visible = showAllUsage ? nonZero : nonZero.slice(0, PREVIEW);
        if (nonZero.length === 0 && zeroItems.length === 0) return null;
        return (
          <View style={[styles.usageSummary, { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: insets.bottom + 8 }]}>
            <View style={styles.usageTitleRow}>
              <Text style={[styles.usageTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                Usage Summary
              </Text>
              <Text style={[styles.usageCount, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {nonZero.length} product{nonZero.length !== 1 ? 's' : ''}
              </Text>
            </View>
            {nonZero.length > 0 ? (
              <ScrollView
                style={showAllUsage ? styles.usageScrollExpanded : undefined}
                showsVerticalScrollIndicator={showAllUsage}
                scrollEnabled={showAllUsage}
                nestedScrollEnabled
              >
                {visible.map((u) => (
                  <View key={u.productId} style={styles.usageRow}>
                    <Text style={[styles.usageName, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]} numberOfLines={1}>
                      {u.productName}
                    </Text>
                    <Text style={[styles.usageQty, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>
                      {parseFloat(u.usage).toFixed(2)}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <Text style={[styles.usageEmptyText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                No products with recorded usage.
              </Text>
            )}
            {hasMore && (
              <Pressable
                onPress={() => setShowAllUsage((v) => !v)}
                style={[styles.showAllBtn, { borderTopColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel={showAllUsage ? 'Show fewer usage items' : `Show all ${nonZero.length} usage items`}
              >
                <Text style={[styles.showAllText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
                  {showAllUsage ? 'Show less' : `Show all ${nonZero.length} products`}
                </Text>
                <Feather name={showAllUsage ? 'chevron-up' : 'chevron-down'} size={14} color={colors.primary} />
              </Pressable>
            )}

            {/* Zero-usage toggle */}
            {zeroItems.length > 0 && (
              <>
                <Pressable
                  onPress={() => setShowZeroUsage((v) => !v)}
                  style={[styles.zeroUsageToggle, { borderTopColor: colors.border }]}
                  accessibilityRole="button"
                  accessibilityLabel={showZeroUsage ? 'Hide zero-usage products' : `Show ${zeroItems.length} zero-usage product${zeroItems.length !== 1 ? 's' : ''}`}
                >
                  <View style={[styles.zeroUsageBadge, { backgroundColor: colors.mutedForeground + '18' }]}>
                    <Feather name="minus-circle" size={12} color={colors.mutedForeground} />
                    <Text style={[styles.zeroUsageBadgeText, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>
                      {zeroItems.length} not consumed
                    </Text>
                  </View>
                  <Feather name={showZeroUsage ? 'chevron-up' : 'chevron-down'} size={14} color={colors.mutedForeground} />
                </Pressable>
                {showZeroUsage && (
                  <View style={[styles.zeroUsageList, { borderTopColor: colors.border }]}>
                    {zeroItems.map((u) => (
                      <View key={u.productId} style={styles.usageRow}>
                        <Text style={[styles.usageName, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]} numberOfLines={1}>
                          {u.productName}
                        </Text>
                        <Text style={[styles.zeroUsageLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                          No usage
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </View>
        );
      })()}

      {/* Undo toast — shown after scans and manual edits */}
      {undoEntry && (
        <Animated.View
          style={[styles.undoToast, { backgroundColor: colors.foreground, opacity: undoOpacity, pointerEvents: 'box-none' as const }]}
        >
          <Text style={[styles.undoToastText, { color: colors.background, fontFamily: 'Inter_400Regular' }]} numberOfLines={1}>
            {undoEntry.toastLabel}{' '}
            <Text style={{ fontFamily: 'Inter_600SemiBold' }}>{undoEntry.productName}</Text>
          </Text>
          <Pressable
            onPress={handleUndo}
            style={[styles.undoBtn, { borderColor: colors.background + '55' }]}
            accessibilityLabel="Undo"
            accessibilityRole="button"
          >
            <Feather name="rotate-ccw" size={13} color={colors.background} />
            <Text style={[styles.undoBtnText, { color: colors.background, fontFamily: 'Inter_700Bold' }]}>Undo</Text>
          </Pressable>
        </Animated.View>
      )}

      {/* Barcode scanner sheet */}
      <BarcodeScannerSheet
        visible={scannerVisible}
        onClose={() => setScannerVisible(false)}
        onScanned={handleBarcodeScan}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  statusBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flex: 1, fontSize: 13 },
  countedText: { fontSize: 12 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  searchInput: { flex: 1, fontSize: 15 },
  scanBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6 },
  quickAddBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6 },
  scanBtnText: { fontSize: 13 },
  list: { padding: 12 },
  productRow: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
  productHeader: { marginBottom: 10 },
  productTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  productName: { flex: 1, fontSize: 15 },
  productMeta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 },
  productUnit: { fontSize: 12 },
  prevCount: { fontSize: 12 },
  scannedBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  scannedBadgeText: { fontSize: 11 },
  countRow: { flexDirection: 'row', gap: 10 },
  countField: { flex: 1, gap: 4 },
  countLabel: { fontSize: 11, textAlign: 'center' },
  countInput: { borderRadius: 8, borderWidth: 1, padding: 10, fontSize: 17, textAlign: 'center' },
  finalText: { fontSize: 13 },
  bottomBar: { flexDirection: 'row', gap: 10, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
  saveBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, padding: 14, borderWidth: 1 },
  saveBtnText: { fontSize: 15 },
  finalizeBtn: { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, padding: 14 },
  finalizeBtnText: { color: '#fff', fontSize: 15 },
  usageSummary: { padding: 16, borderTopWidth: 1 },
  usageTitleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 },
  usageTitle: { fontSize: 16 },
  usageCount: { fontSize: 12 },
  usageScrollExpanded: { maxHeight: 240 },
  usageRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  usageName: { flex: 1, fontSize: 13, marginRight: 8 },
  usageQty: { fontSize: 14 },
  showAllBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingTop: 10, marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth },
  showAllText: { fontSize: 13 },
  usageEmptyText: { fontSize: 13, textAlign: 'center', paddingVertical: 8 },
  zeroUsageToggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  zeroUsageBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  zeroUsageBadgeText: { fontSize: 12 },
  zeroUsageList: { marginTop: 6, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth },
  zeroUsageLabel: { fontSize: 12, fontStyle: 'italic' },
  undoToast: {
    position: 'absolute',
    bottom: 90,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 10,
    boxShadow: '0 4px 10px rgba(0,0,0,0.18)',
    elevation: 8,
  },
  undoToastText: { flex: 1, fontSize: 13 },
  undoBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6 },
  undoBtnText: { fontSize: 13 },
  adminBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  adminBadgeText: { fontSize: 13 },
});
