import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Platform, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useGetInventoryValuation } from '@workspace/api-client-react';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

export default function ValuationScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [exporting, setExporting] = useState(false);
  const { data: report, isLoading } = useGetInventoryValuation();

  if (isLoading) return <LoadingState message="Calculating valuation…" />;

  const lines = report?.lines ?? [];
  const grandTotal = parseFloat(report?.grandTotal ?? '0');

  const byStore: Record<string, typeof lines> = {};
  for (const l of lines) {
    const key = l.warehouseName
      ? `Warehouse · ${l.warehouseName}`
      : l.storeName ?? 'Unknown';
    (byStore[key] ??= []).push(l);
  }

  type Section = { title: string; data: typeof lines; total: number };
  const sections: Section[] = Object.entries(byStore).map(([title, data]) => ({
    title,
    data,
    total: data.reduce((acc, l) => acc + parseFloat(l.totalValue), 0),
  })).sort((a, b) => b.total - a.total);

  const handleExportPdf = async () => {
    setExporting(true);
    try {
      const generatedAt = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      const storeSections = sections.map((section) => {
        const rows = section.data.map((l) => `
          <tr>
            <td class="name">${l.productName}</td>
            <td class="num muted">${parseFloat(l.currentQuantity).toFixed(1)} ${l.unit ?? ''}</td>
            <td class="num bold">$${parseFloat(l.totalValue).toFixed(2)}</td>
          </tr>`).join('');

        return `
          <div class="store-block">
            <div class="store-header">
              <span class="store-name">${section.title}</span>
              <span class="store-total">$${section.total.toFixed(2)}</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th style="text-align:right">Qty</th>
                  <th style="text-align:right">Value</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }).join('');

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1e293b; padding: 32px; }
  .logo { font-size: 18px; font-weight: 800; color: #DC2626; letter-spacing: -0.5px; }
  h1 { font-size: 22px; font-weight: 700; margin-top: 6px; }
  .sub { font-size: 13px; color: #64748b; margin-top: 4px; }
  .page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; border-bottom: 2px solid #e2e8f0; padding-bottom: 16px; }
  .grand-card { background: #1d4ed8; color: #fff; border-radius: 12px; padding: 20px 24px; margin-bottom: 28px; display: flex; justify-content: space-between; align-items: center; }
  .grand-label { font-size: 13px; opacity: 0.8; }
  .grand-value { font-size: 32px; font-weight: 700; }
  .grand-sub { font-size: 12px; opacity: 0.7; margin-top: 4px; }
  .store-block { margin-bottom: 28px; }
  .store-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; }
  .store-name { font-size: 16px; font-weight: 700; color: #0f172a; }
  .store-total { font-size: 17px; font-weight: 700; color: #2563eb; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f8fafc; text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; border-bottom: 1px solid #e2e8f0; }
  td { padding: 10px; border-bottom: 1px solid #f1f5f9; }
  tr:last-child td { border-bottom: none; }
  .name { font-weight: 500; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #94a3b8; }
  .bold { font-weight: 600; }
  .footer { margin-top: 32px; font-size: 11px; color: #94a3b8; text-align: center; }
</style>
</head>
<body>
  <div class="page-header">
    <div>
      <div class="logo">Red Carpet Car Wash</div>
      <h1>Inventory Valuation</h1>
      <div class="sub">As of ${generatedAt}</div>
    </div>
    <div class="sub" style="text-align:right">Generated ${generatedAt}</div>
  </div>

  <div class="grand-card">
    <div>
      <div class="grand-label">Total Inventory Value</div>
      <div class="grand-sub">${lines.length} products · ${sections.length} stores</div>
    </div>
    <div class="grand-value">$${grandTotal.toFixed(2)}</div>
  </div>

  ${storeSections}

  <div class="footer">Red Carpet Car Wash — Inventory Edition · ${generatedAt}</div>
</body>
</html>`;

      const { uri } = await Print.printToFileAsync({ html, base64: false });

      if (Platform.OS === 'web') {
        const w = window.open('', '_blank');
        if (w) { w.document.write(html); w.document.close(); w.print(); }
      } else {
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Export Valuation Report' });
        } else {
          Alert.alert('Saved', `PDF saved to: ${uri}`);
        }
      }
    } catch {
      Alert.alert('Export failed', 'Could not generate PDF. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Grand total */}
      <View style={[styles.grandCard, { backgroundColor: colors.primary, marginHorizontal: 16, marginTop: 16 }]}>
        <View>
          <Text style={[styles.grandLabel, { fontFamily: 'Inter_400Regular' }]}>Total Inventory Value</Text>
          <Text style={[styles.grandSub, { fontFamily: 'Inter_400Regular' }]}>
            {lines.length} products · {sections.length} stores
          </Text>
        </View>
        <View style={styles.grandRight}>
          <Text style={[styles.grandValue, { fontFamily: 'Inter_700Bold' }]}>${grandTotal.toFixed(2)}</Text>
          <Pressable
            style={[styles.pdfBtn, { opacity: exporting || lines.length === 0 ? 0.5 : 1 }]}
            onPress={handleExportPdf}
            disabled={exporting || lines.length === 0}
          >
            <Feather name="download" size={14} color={colors.primary} />
            <Text style={[styles.pdfBtnText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
              {exporting ? 'Exporting…' : 'PDF'}
            </Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={sections}
        keyExtractor={(s) => s.title}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
        renderItem={({ item: section }) => (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                {section.title}
              </Text>
              <Text style={[styles.sectionTotal, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>
                ${section.total.toFixed(2)}
              </Text>
            </View>
            {section.data.map((l) => (
              <View key={l.productId} style={[styles.line, { borderBottomColor: colors.border }]}>
                <Text style={[styles.lineName, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]} numberOfLines={1}>
                  {l.productName}
                </Text>
                <View style={styles.lineRight}>
                  <Text style={[styles.lineQty, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                    {parseFloat(l.currentQuantity).toFixed(1)} {l.unit ?? ''}
                  </Text>
                  <Text style={[styles.lineValue, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]}>
                    ${parseFloat(l.totalValue).toFixed(2)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
        ListEmptyComponent={
          <EmptyState icon="dollar-sign" title="No valuation data" subtitle="Complete and finalize inventory sessions to see valuation" />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  grandCard: { borderRadius: 16, padding: 20, marginBottom: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  grandLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 14 },
  grandSub: { color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 },
  grandRight: { alignItems: 'flex-end', gap: 8 },
  grandValue: { color: '#fff', fontSize: 32 },
  pdfBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: '#fff', borderRadius: 16,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  pdfBtnText: { fontSize: 13 },
  list: { paddingHorizontal: 16 },
  section: { marginBottom: 20 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle: { fontSize: 17 },
  sectionTotal: { fontSize: 18 },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  lineName: { flex: 1, fontSize: 14 },
  lineRight: { alignItems: 'flex-end', gap: 2 },
  lineQty: { fontSize: 12 },
  lineValue: { fontSize: 15 },
});
