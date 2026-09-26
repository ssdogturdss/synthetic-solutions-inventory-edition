import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput, ScrollView,
  Platform, Alert, ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useGenerateAiReport } from '@workspace/api-client-react';
import type { AiReportResponse } from '@workspace/api-client-react';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

const PRESETS = [
  { label: 'Executive Summary', icon: 'bar-chart-2' as const, query: 'Generate a comprehensive executive summary of inventory health, highlighting top issues and key trends.' },
  { label: 'Usage Analysis', icon: 'trending-up' as const, query: 'Analyze product consumption trends. Identify top consumers, unusual usage patterns, and any anomalies.' },
  { label: 'Stock Alerts', icon: 'alert-triangle' as const, query: 'Review all items below minimum stock levels. Prioritize by urgency and recommend reorder quantities.' },
  { label: 'Store Comparison', icon: 'map-pin' as const, query: 'Compare inventory reporting activity across all stores. Flag any stores with missing or inconsistent reports.' },
  { label: 'Anomaly Detection', icon: 'zap' as const, query: 'Identify any unusual inventory spikes, unexpected consumption, possible shrinkage or waste, and reporting inconsistencies.' },
  { label: 'Reorder Plan', icon: 'shopping-cart' as const, query: 'Based on current levels and consumption rates, recommend which products need to be reordered and in what quantities.' },
];

const PERIODS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

interface Section { title: string; icon: string; color: string; items: string[]; }

interface Props {
  bottomPadding?: number;
}

export default function AiReportView({ bottomPadding = 32 }: Props) {
  const colors = useColors();
  const { mutateAsync: generate, isPending } = useGenerateAiReport();

  const [customQuery, setCustomQuery] = useState('');
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<AiReportResponse | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleGenerate = async (overrideQuery?: string) => {
    const q = overrideQuery ?? customQuery.trim();
    if (!q) { Alert.alert('Enter a query', 'Choose a preset or type a custom question.'); return; }
    setReport(null);
    try {
      const result = await generate({ data: { query: q, days } });
      setReport(result);
    } catch (e: any) {
      const msg = e?.data?.error ?? e?.message ?? 'Failed to generate report.';
      Alert.alert('Report error', msg);
    }
  };

  const handlePreset = (idx: number) => {
    setSelectedPreset(idx);
    setCustomQuery('');
    handleGenerate(PRESETS[idx]!.query);
  };

  const handleExportPdf = async () => {
    if (!report) return;
    setExporting(true);
    try {
      const generatedAt = new Date(report.generatedAt).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const renderList = (items: string[]) =>
        items.map((i) => `<li style="margin-bottom:6px;color:#1e293b">${i}</li>`).join('');
      const confidence = Math.round(report.confidence * 100);
      const dqColor = report.dataQuality === 'complete' ? '#16a34a' : report.dataQuality === 'partial' ? '#d97706' : '#dc2626';
      const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1e293b; padding: 36px; }
  .logo { font-size: 18px; font-weight: 800; color: #DC2626; }
  h1 { font-size: 22px; font-weight: 700; margin: 8px 0 4px; color: #0f172a; }
  .meta { font-size: 12px; color: #64748b; margin-bottom: 24px; }
  .badges { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
  .badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 20px; }
  .overview { background: #f8fafc; border-left: 4px solid #2563eb; padding: 16px; border-radius: 0 8px 8px 0; margin-bottom: 24px; line-height: 1.6; font-size: 14px; }
  .section { margin-bottom: 20px; }
  .section h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #475569; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid #e2e8f0; }
  ul { padding-left: 20px; }
  li { font-size: 13px; line-height: 1.5; }
  .footer { margin-top: 36px; font-size: 11px; color: #94a3b8; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 16px; }
</style>
</head><body>
  <div class="logo">Red Carpet Car Wash</div>
  <h1>${report.title}</h1>
  <div class="meta">Generated ${generatedAt} · Period: ${report.periodDays} days · ${report.storeCount} stores · ${report.sessionCount} sessions</div>
  <div class="badges">
    <span class="badge" style="background:#dbeafe;color:#1d4ed8">Confidence: ${confidence}%</span>
    <span class="badge" style="background:${dqColor}22;color:${dqColor}">Data: ${report.dataQuality}</span>
    ${report.alertCount > 0 ? `<span class="badge" style="background:#fee2e2;color:#dc2626">${report.alertCount} stock alerts</span>` : ''}
  </div>
  <div class="overview">${report.overview}</div>
  ${report.keyFindings.length > 0 ? `<div class="section"><h2>Key Findings</h2><ul>${renderList(report.keyFindings)}</ul></div>` : ''}
  ${report.anomalies.length > 0 ? `<div class="section"><h2>Anomalies</h2><ul>${renderList(report.anomalies)}</ul></div>` : ''}
  ${report.recommendations.length > 0 ? `<div class="section"><h2>Recommendations</h2><ul>${renderList(report.recommendations)}</ul></div>` : ''}
  ${report.risks.length > 0 ? `<div class="section"><h2>Business Risks</h2><ul>${renderList(report.risks)}</ul></div>` : ''}
  ${report.dataQualityNote ? `<div class="overview" style="border-color:#94a3b8;margin-top:20px;font-size:12px;color:#64748b">${report.dataQualityNote}</div>` : ''}
  <div class="footer">Red Carpet Car Wash — Inventory Edition · AI Report · ${generatedAt}</div>
</body></html>`;
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (Platform.OS === 'web') {
        const w = window.open('', '_blank');
        if (w) { w.document.write(html); w.document.close(); w.print(); }
      } else {
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Export AI Report' });
        else Alert.alert('Saved', `PDF saved to: ${uri}`);
      }
    } catch { Alert.alert('Export failed', 'Could not generate PDF.'); }
    finally { setExporting(false); }
  };

  const confidencePct = report ? Math.round(report.confidence * 100) : 0;
  const dqColor = !report ? colors.mutedForeground
    : report.dataQuality === 'complete' ? colors.success
    : report.dataQuality === 'partial' ? '#F59E0B'
    : colors.destructive;

  const sections: Section[] = report ? [
    { title: 'Key Findings', icon: 'list', color: colors.primary, items: report.keyFindings },
    { title: 'Anomalies Detected', icon: 'alert-circle', color: '#F59E0B', items: report.anomalies },
    { title: 'Recommendations', icon: 'check-circle', color: colors.success, items: report.recommendations },
    { title: 'Business Risks', icon: 'shield', color: colors.destructive, items: report.risks },
  ].filter((s) => s.items.length > 0) : [];

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingBottom: bottomPadding }]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {/* Period selector */}
      <View style={styles.periodRow}>
        {PERIODS.map((p) => (
          <Pressable
            key={p.days}
            style={[styles.periodBtn, { borderColor: days === p.days ? colors.primary : colors.border },
              days === p.days && { backgroundColor: colors.primary }]}
            onPress={() => setDays(p.days)}
          >
            <Text style={[styles.periodText, { color: days === p.days ? '#fff' : colors.mutedForeground,
              fontFamily: days === p.days ? 'Inter_600SemiBold' : 'Inter_400Regular' }]}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Preset buttons */}
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold' }]}>QUICK REPORTS</Text>
      <View style={styles.presetGrid}>
        {PRESETS.map((p, i) => (
          <Pressable
            key={i}
            style={[styles.presetCard, { backgroundColor: colors.card, borderColor: selectedPreset === i && !isPending ? colors.primary : colors.border },
              selectedPreset === i && !isPending && { borderWidth: 2 }]}
            onPress={() => handlePreset(i)}
            disabled={isPending}
          >
            <Feather name={p.icon} size={20} color={selectedPreset === i ? colors.primary : colors.mutedForeground} />
            <Text style={[styles.presetLabel, { color: colors.foreground, fontFamily: 'Inter_500Medium' }]}>{p.label}</Text>
          </Pressable>
        ))}
      </View>

      {/* Custom query */}
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground, fontFamily: 'Inter_600SemiBold', marginTop: 20 }]}>CUSTOM QUERY</Text>
      <View style={[styles.queryBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <TextInput
          style={[styles.queryInput, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
          value={customQuery}
          onChangeText={(v) => { setCustomQuery(v); setSelectedPreset(null); }}
          placeholder="Ask anything — e.g. 'Compare Store 1 vs Store 2 usage last month'"
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={500}
          editable={!isPending}
        />
        <Pressable
          style={[styles.sendBtn, { backgroundColor: colors.primary, opacity: customQuery.trim() && !isPending ? 1 : 0.4 }]}
          onPress={() => handleGenerate()}
          disabled={!customQuery.trim() || isPending}
        >
          <Feather name="send" size={16} color="#fff" />
        </Pressable>
      </View>

      {/* Loading */}
      {isPending && (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={[styles.loadingText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            Analyzing inventory data…
          </Text>
          <Text style={[styles.loadingSubtext, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
            This may take 10–30 seconds
          </Text>
        </View>
      )}

      {/* Report */}
      {report && !isPending && (
        <View style={styles.reportContainer}>
          {/* Header card */}
          <View style={[styles.reportHeader, { backgroundColor: colors.primary }]}>
            <View style={styles.reportHeaderTop}>
              <Text style={[styles.reportTitle, { fontFamily: 'Inter_700Bold' }]} numberOfLines={2}>{report.title}</Text>
              <Pressable
                style={[styles.pdfBtn, { opacity: exporting ? 0.5 : 1 }]}
                onPress={handleExportPdf}
                disabled={exporting}
              >
                <Feather name="download" size={14} color={colors.primary} />
                <Text style={[styles.pdfBtnText, { color: colors.primary, fontFamily: 'Inter_600SemiBold' }]}>
                  {exporting ? '…' : 'PDF'}
                </Text>
              </Pressable>
            </View>
            <Text style={[styles.reportMeta, { fontFamily: 'Inter_400Regular' }]}>
              {new Date(report.generatedAt).toLocaleString()} · {report.periodDays} days · {report.storeCount} stores · {report.sessionCount} sessions
            </Text>
            <View style={styles.badges}>
              <View style={styles.badge}>
                <Feather name="award" size={11} color="rgba(255,255,255,0.8)" />
                <Text style={[styles.badgeText, { fontFamily: 'Inter_500Medium' }]}>Confidence {confidencePct}%</Text>
              </View>
              <View style={[styles.badge, { backgroundColor: dqColor + '30' }]}>
                <Text style={[styles.badgeText, { color: dqColor === colors.success ? '#6EE7B7' : dqColor === '#F59E0B' ? '#FCD34D' : '#FCA5A5', fontFamily: 'Inter_500Medium' }]}>
                  Data: {report.dataQuality}
                </Text>
              </View>
              {report.alertCount > 0 && (
                <View style={[styles.badge, { backgroundColor: '#EF444430' }]}>
                  <Feather name="alert-triangle" size={11} color="#FCA5A5" />
                  <Text style={[styles.badgeText, { color: '#FCA5A5', fontFamily: 'Inter_500Medium' }]}>{report.alertCount} alerts</Text>
                </View>
              )}
            </View>
          </View>

          {/* Overview */}
          <View style={[styles.overviewBox, { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: colors.primary }]}>
            <Text style={[styles.overviewText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>{report.overview}</Text>
          </View>

          {/* Sections */}
          {sections.map((section) => (
            <View key={section.title} style={[styles.sectionBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.sectionHeaderRow}>
                <View style={[styles.sectionIconBox, { backgroundColor: section.color + '18' }]}>
                  <Feather name={section.icon as any} size={16} color={section.color} />
                </View>
                <Text style={[styles.sectionTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>{section.title}</Text>
                <View style={[styles.countBadge, { backgroundColor: section.color + '18' }]}>
                  <Text style={[styles.countText, { color: section.color, fontFamily: 'Inter_600SemiBold' }]}>{section.items.length}</Text>
                </View>
              </View>
              {section.items.map((item, i) => (
                <View key={i} style={[styles.listItem, { borderTopColor: colors.border }]}>
                  <View style={[styles.dot, { backgroundColor: section.color }]} />
                  <Text style={[styles.listText, { color: colors.foreground, fontFamily: 'Inter_400Regular' }]}>{item}</Text>
                </View>
              ))}
            </View>
          ))}

          {/* Data quality note */}
          {report.dataQualityNote && (
            <View style={[styles.dqNote, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <Feather name="info" size={13} color={colors.mutedForeground} />
              <Text style={[styles.dqText, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>{report.dataQualityNote}</Text>
            </View>
          )}

          {/* Regenerate */}
          <Pressable
            style={[styles.regenBtn, { borderColor: colors.border }]}
            onPress={() => handleGenerate(selectedPreset !== null ? PRESETS[selectedPreset]?.query : customQuery)}
          >
            <Feather name="refresh-cw" size={14} color={colors.mutedForeground} />
            <Text style={[styles.regenText, { color: colors.mutedForeground, fontFamily: 'Inter_500Medium' }]}>Regenerate</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16 },
  sectionLabel: { fontSize: 12, letterSpacing: 0.6, marginBottom: 10 },
  periodRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  periodBtn: { borderRadius: 20, paddingHorizontal: 16, paddingVertical: 7, borderWidth: 1 },
  periodText: { fontSize: 13 },
  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  presetCard: { width: '47%', borderRadius: 14, borderWidth: 1, padding: 14, gap: 8, alignItems: 'flex-start' },
  presetLabel: { fontSize: 13, lineHeight: 18 },
  queryBox: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, borderRadius: 14, borderWidth: 1, padding: 12 },
  queryInput: { flex: 1, fontSize: 14, lineHeight: 20, maxHeight: 100, minHeight: 40 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  loadingBox: { alignItems: 'center', paddingVertical: 48, gap: 12 },
  loadingText: { fontSize: 15 },
  loadingSubtext: { fontSize: 13 },
  reportContainer: { marginTop: 20, gap: 12 },
  reportHeader: { borderRadius: 16, padding: 18, gap: 8 },
  reportHeaderTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  reportTitle: { flex: 1, fontSize: 18, color: '#fff' },
  pdfBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#fff', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  pdfBtnText: { fontSize: 13 },
  reportMeta: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  badges: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 11, color: 'rgba(255,255,255,0.9)' },
  overviewBox: { borderRadius: 14, borderWidth: 1, borderLeftWidth: 4, padding: 16 },
  overviewText: { fontSize: 14, lineHeight: 22 },
  sectionBox: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 },
  sectionIconBox: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { flex: 1, fontSize: 15 },
  countBadge: { borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2 },
  countText: { fontSize: 13 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth },
  dot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  listText: { flex: 1, fontSize: 13, lineHeight: 20 },
  dqNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 10, borderWidth: 1, padding: 12 },
  dqText: { flex: 1, fontSize: 12, lineHeight: 18 },
  regenBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, borderWidth: 1, padding: 12 },
  regenText: { fontSize: 14 },
});
