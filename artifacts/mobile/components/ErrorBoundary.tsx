import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Feather } from '@expo/vector-icons';

interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <View style={styles.root}>
        <Feather name="alert-triangle" size={40} color="#EF4444" />
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.message} numberOfLines={4}>{this.state.error?.message ?? 'Unknown error'}</Text>
        <Pressable style={styles.btn} onPress={() => this.setState({ hasError: false, error: null })}>
          <Text style={styles.btnText}>Try Again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#0D1526', gap: 14 },
  title: { color: '#E8EFFF', fontSize: 20, fontWeight: '700' },
  message: { color: '#6B7A99', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  btn: { backgroundColor: '#1A5CFF', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
