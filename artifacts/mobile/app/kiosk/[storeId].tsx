import React, { useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { getBaseUrl } from '@workspace/api-client-react';

const REFRESH_INTERVAL_MS = 60_000;

interface KioskData {
  store: { id: number; name: string; storeNumber: string };
  activeChemicalPulls: number;
  itemsBelowMinimum: number;
  lastReceivingDate: string | null;
  topChemicals: {
    productId: number;
    productName: string;
    categoryName: string | null;
    totalUsage: string;
    unit: string | null;
  }[];
  generatedAt: string;
}

async function fetchKioskData(storeId: string, token: string): Promise<KioskData> {
  const base = getBaseUrl();
  const url = `${base}api/kiosk/${storeId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

function formatDate(iso: string | null): string {
  if (!iso) return 'No deliveries recorded';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatRefresh(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface MetricTileProps {
  value: number;
  label: string;
  accent: string;
  dimColor: string;
  textColor: string;
  subText?: string;
}

function MetricTile({ value, label, accent, dimColor, textColor, subText }: MetricTileProps) {
  return (
    <View style={[styles.tile, { backgroundColor: dimColor }]}>
      <Text style={[styles.tileValue, { color: accent }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: textColor }]}>{label}</Text>
      {subText ? <Text style={[styles.tileSub, { color: textColor + '99' }]}>{subText}</Text> : null}
    </View>
  );
}

export default function KioskScreen() {
  const params = useLocalSearchParams<{ storeId: string; token: string }>();
  const storeId = params.storeId ?? '';
  const token = params.token ?? '';

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery<KioskData, Error>({
    queryKey: ['kiosk', storeId],
    queryFn: () => fetchKioskData(storeId, token),
    enabled: Boolean(storeId && token),
    staleTime: REFRESH_INTERVAL_MS,
    retry: 2,
  });

  const doRefetch = useCallback(() => { void refetch(); }, [refetch]);

  useEffect(() => {
    if (!storeId || !token) return;
    tickRef.current = setInterval(doRefetch, REFRESH_INTERVAL_MS);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [storeId, token, doRefetch]);

  // Dark palette — better for ambient wall display
  const bg = '#0D1526';
  const card = '#131E33';
  const border = '#1E2D45';
  const fg = '#E8EFFF';
  const muted = '#6B7A99';
  const primary = '#3B74FF';
  const success = '#10B981';
  const warning = '#F59E0B';
  const destructive = '#EF4444';
  const accent = '#00C9A7';

  if (!token) {
    return (
      <View style={[styles.centered, { backgroundColor: bg }]}>
        <Text style={[styles.errorTitle, { color: destructive }]}>Missing kiosk token</Text>
        <Text style={[styles.errorSub, { color: muted }]}>
          Open this screen from the admin panel with a valid token.
        </Text>
      </View>
    );
  }

  if (isError) {
    return (
      <View style={[styles.centered, { backgroundColor: bg }]}>
        <Text style={[styles.errorTitle, { color: destructive }]}>Unable to load dashboard</Text>
        <Text style={[styles.errorSub, { color: muted }]}>{error?.message ?? 'Unknown error'}</Text>
      </View>
    );
  }

  if (isLoading || !data) {
    return (
      <View style={[styles.centered, { backgroundColor: bg }]}>
        <ActivityIndicator size="large" color={primary} />
        <Text style={[styles.loadingText, { color: muted }]}>Loading store data…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <StatusBar hidden />

      {/* Header */}
      <View style={[styles.header, { borderBottomColor: border }]}>
        <View>
          <Text style={[styles.storeName, { color: fg }]}>{data.store.name}</Text>
          <Text style={[styles.storeNumber, { color: muted }]}>Store #{data.store.storeNumber}</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.liveDot, { backgroundColor: success }]} />
          <Text style={[styles.liveLabel, { color: success }]}>LIVE</Text>
          <Text style={[styles.refreshedAt, { color: muted }]}>
            Updated {formatRefresh(data.generatedAt)}
          </Text>
        </View>
      </View>

      {/* Metric tiles */}
      <View style={styles.tilesRow}>
        <MetricTile
          value={data.activeChemicalPulls}
          label="Active Pulls"
          accent={primary}
          dimColor={primary + '18'}
          textColor={fg}
          subText="chemicals in use"
        />
        <MetricTile
          value={data.itemsBelowMinimum}
          label="Below Minimum"
          accent={data.itemsBelowMinimum > 0 ? destructive : success}
          dimColor={data.itemsBelowMinimum > 0 ? destructive + '18' : success + '18'}
          textColor={fg}
          subText="items need restocking"
        />
      </View>

      {/* Bottom row: last receiving + top chemicals */}
      <View style={styles.bottomRow}>
        {/* Last Receiving */}
        <View style={[styles.panel, { backgroundColor: card, borderColor: border }]}>
          <Text style={[styles.panelTitle, { color: muted }]}>LAST DELIVERY</Text>
          <Text style={[styles.receivingDate, { color: fg }]}>
            {formatDate(data.lastReceivingDate)}
          </Text>
        </View>

        {/* Top chemicals */}
        <View style={[styles.panel, { backgroundColor: card, borderColor: border, flex: 2 }]}>
          <Text style={[styles.panelTitle, { color: muted }]}>TOP CHEMICALS THIS WEEK</Text>
          {data.topChemicals.length === 0 ? (
            <Text style={[styles.emptyChemicals, { color: muted }]}>No chemical usage recorded this week</Text>
          ) : (
            data.topChemicals.map((c, i) => (
              <View key={c.productId} style={[styles.chemRow, { borderBottomColor: border }]}>
                <View style={[styles.rankBadge, { backgroundColor: accent + '20' }]}>
                  <Text style={[styles.rankText, { color: accent }]}>{i + 1}</Text>
                </View>
                <Text style={[styles.chemName, { color: fg }]} numberOfLines={1}>
                  {c.productName}
                </Text>
                <Text style={[styles.chemUsage, { color: muted }]}>
                  {parseFloat(c.totalUsage).toFixed(1)} {c.unit ?? ''}
                </Text>
              </View>
            ))
          )}
        </View>
      </View>

      {/* Footer */}
      <View style={[styles.footer, { borderTopColor: border }]}>
        <Text style={[styles.footerText, { color: muted }]}>
          Auto-refreshes every 60 seconds · Red Carpet Car Wash
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  loadingText: { marginTop: 12, fontSize: 16 },
  errorTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  errorSub: { fontSize: 15, textAlign: 'center', maxWidth: 400 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  storeName: { fontSize: 28, fontWeight: '700' },
  storeNumber: { fontSize: 15, marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  liveDot: { width: 10, height: 10, borderRadius: 5 },
  liveLabel: { fontSize: 14, fontWeight: '700', letterSpacing: 1.5 },
  refreshedAt: { fontSize: 13, marginLeft: 4 },

  tilesRow: {
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingTop: 24,
    gap: 16,
  },
  tile: {
    flex: 1,
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  tileValue: { fontSize: 64, fontWeight: '800', lineHeight: 72 },
  tileLabel: { fontSize: 18, fontWeight: '600' },
  tileSub: { fontSize: 13 },

  bottomRow: {
    flexDirection: 'row',
    paddingHorizontal: 24,
    paddingTop: 16,
    gap: 16,
    flex: 1,
  },
  panel: {
    flex: 1,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 24,
    gap: 12,
  },
  panelTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  receivingDate: { fontSize: 20, fontWeight: '600', lineHeight: 28 },
  emptyChemicals: { fontSize: 14 },
  chemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rankBadge: {
    width: 30, height: 30, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  rankText: { fontSize: 14, fontWeight: '700' },
  chemName: { flex: 1, fontSize: 16, fontWeight: '500' },
  chemUsage: { fontSize: 14 },

  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14,
    alignItems: 'center',
  },
  footerText: { fontSize: 12 },
});
