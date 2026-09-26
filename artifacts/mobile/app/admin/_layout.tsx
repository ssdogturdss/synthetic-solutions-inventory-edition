import { Redirect, Stack } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/contexts/AuthContext';

export default function AdminLayout() {
  const colors = useColors();
  const { user } = useAuth();

  // Hard guard: non-admins are redirected away even if they navigate directly
  if (user && user.role !== 'admin') {
    return <Redirect href="/(tabs)" />;
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.primary,
        headerTitleStyle: { fontFamily: 'Inter_600SemiBold', color: colors.foreground },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Admin Panel' }} />
      <Stack.Screen name="stores" options={{ title: 'Stores' }} />
      <Stack.Screen name="warehouses" options={{ title: 'Warehouses' }} />
      <Stack.Screen name="users" options={{ title: 'Users' }} />
      <Stack.Screen name="products" options={{ title: 'Products' }} />
      <Stack.Screen name="categories" options={{ title: 'Categories' }} />
      <Stack.Screen name="ai-settings" options={{ title: 'AI Settings' }} />
      <Stack.Screen name="backup-health" options={{ title: 'Backup Health' }} />
    </Stack>
  );
}
