import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, TextInput,
  Platform, KeyboardAvoidingView, ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Conditionally import camera only on native to avoid web crashes
let CameraView: React.ComponentType<any> | null = null;
let useCameraPermissions: (() => [any, () => Promise<any>]) | null = null;
if (Platform.OS !== 'web') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cam = require('expo-camera');
  CameraView = cam.CameraView;
  useCameraPermissions = cam.useCameraPermissions;
}

interface BarcodeScannerSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Called with the raw barcode data string when a code is scanned */
  onScanned: (code: string) => void;
}

/** Native barcode scanner using CameraView */
function NativeScannerContent({
  onScanned,
  onClose,
  colors,
  insets,
}: {
  onScanned: (code: string) => void;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const [scanned, setScanned] = useState(false);
  const [permission, requestPermission] = useCameraPermissions!();

  if (!permission) {
    return (
      <View style={[styles.center, { backgroundColor: '#000' }]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.center, { backgroundColor: '#000', gap: 16 }]}>
        <Feather name="camera-off" size={40} color="#fff" />
        <Text style={styles.permText}>Camera access is needed to scan barcodes</Text>
        <Pressable style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Allow Camera</Text>
        </Pressable>
        <Pressable style={styles.cancelLink} onPress={onClose}>
          <Text style={styles.cancelLinkText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);
    onScanned(data);
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      {CameraView && (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'code128', 'code39', 'upc_a', 'upc_e', 'qr', 'itf14', 'codabar', 'code93'] }}
          onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        />
      )}

      {/* Dark vignette overlay with scan window */}
      <View style={[styles.overlay, { pointerEvents: 'none' }]}>
        <View style={styles.topMask} />
        <View style={styles.midRow}>
          <View style={styles.sideMask} />
          <View style={styles.scanWindow}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <View style={styles.sideMask} />
        </View>
        <View style={styles.bottomMask} />
      </View>

      {/* Header close button */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.closeBtn} onPress={onClose}>
          <Feather name="x" size={22} color="#fff" />
        </Pressable>
        <Text style={styles.headerTitle}>Scan Barcode</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Hint */}
      <View style={styles.hintRow}>
        <Text style={styles.hint}>Point camera at a product barcode</Text>
        {scanned && (
          <Pressable style={styles.rescanBtn} onPress={() => setScanned(false)}>
            <Text style={styles.rescanText}>Scan Again</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** Web fallback — manual code entry */
function WebFallbackContent({
  onScanned,
  onClose,
  colors,
  insets,
}: {
  onScanned: (code: string) => void;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const [code, setCode] = useState('');

  const handleSubmit = () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    onScanned(trimmed);
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.webContainer, { backgroundColor: colors.background, paddingBottom: insets.bottom + 16 }]}
    >
      <View style={[styles.webHeader, { borderBottomColor: colors.border }]}>
        <Pressable onPress={onClose}>
          <Feather name="x" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.webTitle, { color: colors.foreground, fontFamily: 'Inter_700Bold' }]}>
          Enter Product Code
        </Text>
        <View style={{ width: 22 }} />
      </View>
      <View style={styles.webBody}>
        <Feather name="camera-off" size={36} color={colors.mutedForeground} style={{ marginBottom: 12 }} />
        <Text style={[styles.webHint, { color: colors.mutedForeground, fontFamily: 'Inter_400Regular' }]}>
          Camera scanning is not available on web.{'\n'}Enter the product number manually.
        </Text>
        <TextInput
          style={[styles.webInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, fontFamily: 'Inter_400Regular' }]}
          placeholder="Product number or barcode"
          placeholderTextColor={colors.mutedForeground}
          value={code}
          onChangeText={setCode}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
        <Pressable
          style={[styles.webSubmitBtn, { backgroundColor: colors.primary }, !code.trim() && { opacity: 0.5 }]}
          onPress={handleSubmit}
          disabled={!code.trim()}
        >
          <Feather name="search" size={16} color="#fff" />
          <Text style={[styles.webSubmitText, { fontFamily: 'Inter_600SemiBold' }]}>Find Product</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

export function BarcodeScannerSheet({ visible, onClose, onScanned }: BarcodeScannerSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  // Stable onScanned wrapper: close sheet first, then call back
  const handleScanned = (code: string) => {
    onClose();
    // slight delay so sheet animates out before parent re-renders
    setTimeout(() => onScanned(code), 150);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      {Platform.OS !== 'web' ? (
        <NativeScannerContent
          onScanned={handleScanned}
          onClose={onClose}
          colors={colors}
          insets={insets}
        />
      ) : (
        <WebFallbackContent
          onScanned={handleScanned}
          onClose={onClose}
          colors={colors}
          insets={insets}
        />
      )}
    </Modal>
  );
}

const MASK_COLOR = 'rgba(0,0,0,0.62)';
const CORNER_SIZE = 22;
const CORNER_THICKNESS = 3;
const CORNER_COLOR = '#fff';

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  permText: { color: '#fff', fontSize: 15, textAlign: 'center', paddingHorizontal: 32 },
  permBtn: { backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 },
  permBtnText: { color: '#000', fontSize: 15, fontWeight: '600' },
  cancelLink: { marginTop: 4 },
  cancelLinkText: { color: 'rgba(255,255,255,0.7)', fontSize: 14 },

  overlay: { ...StyleSheet.absoluteFillObject },
  topMask: { flex: 1, backgroundColor: MASK_COLOR },
  midRow: { flexDirection: 'row', height: 220 },
  sideMask: { flex: 1, backgroundColor: MASK_COLOR },
  bottomMask: { flex: 1.2, backgroundColor: MASK_COLOR },
  scanWindow: { width: 280, height: 220, position: 'relative' },
  corner: { position: 'absolute', width: CORNER_SIZE, height: CORNER_SIZE, borderColor: CORNER_COLOR },
  cornerTL: { top: 0, left: 0, borderTopWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS },
  cornerTR: { top: 0, right: 0, borderTopWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS },

  header: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12 },
  closeBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.45)' },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },

  hintRow: { position: 'absolute', bottom: 80, left: 0, right: 0, alignItems: 'center', gap: 12 },
  hint: { color: 'rgba(255,255,255,0.85)', fontSize: 14 },
  rescanBtn: { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 8, paddingHorizontal: 20, paddingVertical: 8 },
  rescanText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  // Web fallback styles
  webContainer: { flex: 1 },
  webHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  webTitle: { fontSize: 17 },
  webBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, gap: 12 },
  webHint: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  webInput: { width: '100%', borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, marginTop: 8 },
  webSubmitBtn: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 12, paddingVertical: 14, marginTop: 4 },
  webSubmitText: { color: '#fff', fontSize: 15 },
});
