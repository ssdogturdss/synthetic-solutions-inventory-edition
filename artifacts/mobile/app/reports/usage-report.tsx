import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Platform, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useGetUsageReport } from '@workspace/api-client-react';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

const PERIODS = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
];

export default function UsageReportScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [selectedPeriod, setSelectedPeriod] = useState(30);
  const [exporting, setExporting] = useState(false);

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - selectedPeriod * 86400000).toISOString().split('T')[0];

  const { data: report, isLoading, refetch } = useGetUsageReport({ startDate, endDate });

  const handleExportPdf = async () => {
    if (!report) return;
    setExporting(true);
    try {
      const lines = (report.lines ?? []).slice().sort(
        (a, b) => parseFloat(b.totalUsage) - parseFloat(a.totalUsage)
      );
      const periodLabel = PERIODS.find((p) => p.days === selectedPeriod)?.label ?? `${selectedPeriod}D`;
      const generatedAt = new Date().toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      const rows = lines.map((item, i) => {
        const avg = (item.sessionCount ?? 0) > 0
          ? `avg ${(parseFloat(item.totalUsage) / item.sessionCount!).toFixed(1)}/session`
          : '';
        const cost = item.totalCost ? `$${parseFloat(item.totalCost).toFixed(2)}` : '—';
        return `
          <tr>
            <td class="rank">${i + 1}</td>
            <td>
              <div class="name">${item.productName}</div>
              ${item.categoryName ? `<div class="cat">${item.categoryName}</div>` : ''}
            </td>
            <td class="num">${parseFloat(item.totalUsage).toFixed(1)} ${item.unit ?? 'units'}</td>
            <td class="num muted">${avg}</td>
            <td class="num green">${cost}</td>
          </tr>`;
      }).join('');

      const totalCost = report.totalCost && parseFloat(report.totalCost) > 0
        ? `<div class="total-row"><span>Total Consumption Cost</span><span class="total-val">$${parseFloat(report.totalCost).toFixed(2)}</span></div>`
        : '';

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1e293b; padding: 32px; }
  h1 { font-size: 22px; font-weight: 700; color: #0f172a; }
  .sub { font-size: 13px; color: #64748b; margin-top: 4px; }
  .logo { font-size: 18px; font-weight: 800; color: #DC2626; letter-spacing: -0.5px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; border-bottom: 2px solid #e2e8f0; padding-bottom: 16px; }
  .total-row { display: flex; justify-content: space-between; align-items: center; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; font-size: 14px; color: #1e40af; font-weight: 600; }
  .total-val { font-size: 20px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f8fafc; text-align: left; padding: 10px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; border-bottom: 1px solid #e2e8f0; }
  td { padding: 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .rank { text-align: center; font-weight: 700; color: #2563eb; width: 40px; }
  .name { font-weight: 600; color: #0f172a; }
  .cat { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #94a3b8; }
  .green { color: #16a34a; font-weight: 600; }
  .footer { margin-top: 32px; font-size: 11px; color: #94a3b8; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="logo">Red Carpet Car Wash</div>
      <h1 style="margin-top:6px">Usage Report — ${periodLabel}</h1>
      <div class="sub">${startDate} to ${endDate}</div>
    </div>
    <div class="sub" style="text-align:right">Generated ${generatedAt}</div>
  </div>
  ${totalCost}
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Product</th>
        <th style="text-align:right">Total Used</th>
        <th style="text-align:right">Avg / Session</th>
        <th style="text-align:right">Cost</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">Red Carpet Car Wash — Inventory Edition · ${generatedAt}</div>
</body>
</html>`;

      const { uri } = await Print.printToFileAsync({ html, base64: false });

      if (Platform.OS === 'web') {
        // On web, open a print dialog in a new tab
        const w = window.open('', '_blank');
        if (w) { w.document.write(html); w.document.close(); w.print(); }
      } else {
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Export Usage Report' });
        } else {
          Alert.alert('Saved', `PDF saved to: ${uri}`);
        }
      }
    } catch (e) {
      Alert.alert('Export failed', 'Could not generate PDF. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  if (isLoading) return <LoadingState message="Calculating usage…" />;

  const lines = report?.lines ?? [];

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Period selector + actions */}
      <View style={[styles.periodRow, { borderBottomColor: colors.border, backgroundColor: colors.background }]}>
        {PERIODS.map((p) => (
          <Pressable
            key={p.days}
            style={[
              styles.periodBtn,
              { borderColor: selectedPeriod === p.days ? colors.primary : colors.border },
              selectedPeriod === p.days && { backgroundColor: colors.primary },
            ]}
            onPress={() => setSelectedPeriod(p.days)}
          >
            <Text style={[
              styles.periodText,
              { color: selectedPeriod === p.days ? '#fff' : colors.mutedForeground,
                fontFamily: selectedPeriod === p.days ? 'Inter_600SemiBold' : 'Inter_400Regular' },
            ]}>
              {p.label}
            </Text>
          </Pressable>
        ))}
        <Pressable style={styles.actionBtn} onPress={() => refetch()}>
          <Feather name="refresh-cw" size={16} color={colors.mutedForeground} />
        </Pressable>
        <Pressable
          style={[styles.actionBtn, styles.pdfBtn, { backgroundColor: colors.primary, opacity: exporting ? 0.6 : 1 }]}
          onPress={handleExportPdf}
          disabled={exporting || lines.length === 0}
        >
          <Feather name="download" size={14} color="#fff" />
          <Text style={[styles.pdfBtnText, { fontFamily: 'Inter_600SemiBold' }]}>
            {exporting ? 'Exporting…' : 'PDF'}
          </Text>
        </Pressable>
      </View>

      {/* Total cost banner */}
      {report?.totalCost && parseFloat(report.totalCost) > 0 && (
        <View style={[styles.totalBanner, { backgroundColor: colors.primary + '12', borderColor: colors.primary + '30' }]}>
          <Text style={[styles.totalLabel, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            Total Consumption Cost
          </Text>
          <Text style={[styles.totalValue, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>
            ${parseFloat(report.totalCost).toFixed(2)}
          </Text>
        </View>
      )}

      <FlatList
        data={lines.slice().sort((a, b) => parseFloat(b.totalUsage) - parseFloat(a.totalUsage))}
        keyExtractor={(l) => String(l.productId)}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 20 }]}
        renderItem={({ item, index }) => (
          <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.rank, { backgroundColor: colors.primary + '18' }]}>
              <Text style={[styles.rankText, { color: colors.primary, fontFamily: 'Inter_700Bold' }]}>{index + 1}</Text>
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.productName, { color: colors.foreground, fontFamily: 'Inter_600SemiBold' }]} numberOfLines={1}>
                {item.productName}
              </Text>
              {item.categoryName && (
                <Text style={[styles.category, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  {item.categoryName}
                </Text>
              )}
            </View>
            <View style={styles.rowRight}>
              <Text style={[styles.usage, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
                {parseFloat(item.totalUsage).toFixed(1)}
              </Text>
              <Text style={[styles.unit, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                {item.unit ?? 'units'}
              </Text>
              {(item.sessionCount ?? 0) > 0 && (
                <Text style={[styles.avg, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
                  avg {(parseFloat(item.totalUsage) / item.sessionCount!).toFixed(1)}/session
                </Text>
              )}
              {item.totalCost && (
                <Text style={[styles.cost, { color: colors.success, fontFamily: 'Inter_500Medium' }]}>
                  ${parseFloat(item.totalCost).toFixed(2)}
                </Text>
              )}
            </View>
          </View>
        )}
        ListEmptyComponent={
          <EmptyState icon="trending-up" title="No usage data" subtitle="Finalize inventory sessions to generate usage reports" />
        }
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  periodRow: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap',
    paddingHorizontal: 16, paddingVertical: 10, gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  periodBtn: { borderRadius: 20, paddingHorizontal: 18, paddingVertical: 8, borderWidth: 1 },
  periodText: { fontSize: 14 },
  actionBtn: { padding: 8 },
  pdfBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, marginLeft: 'auto' as any,
  },
  pdfBtnText: { color: '#fff', fontSize: 13 },
  totalBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    margin: 16, borderRadius: 12, borderWidth: 1, padding: 14,
  },
  totalLabel: { fontSize: 13 },
  totalValue: { fontSize: 22 },
  list: { padding: 16, paddingTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 10 },
  rank: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rankText: { fontSize: 14 },
  rowBody: { flex: 1 },
  productName: { fontSize: 15 },
  category: { fontSize: 12, marginTop: 2 },
  rowRight: { alignItems: 'flex-end', gap: 2 },
  usage: { fontSize: 20 },
  avg: { fontSize: 11 },
  unit: { fontSize: 11 },
  cost: { fontSize: 12 },
});
