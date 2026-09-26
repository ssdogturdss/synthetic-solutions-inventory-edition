import React from 'react';
import { Platform, ScrollView, ScrollViewProps } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

interface Props extends ScrollViewProps {
  children: React.ReactNode;
  bottomOffset?: number;
}

// Use native keyboard-aware scroll view on native, fallback to plain ScrollView on web
export function KeyboardAwareScrollViewCompat({ children, bottomOffset = 20, ...props }: Props) {
  if (Platform.OS === 'web') {
    return <ScrollView {...props}>{children}</ScrollView>;
  }
  return (
    <KeyboardAwareScrollView bottomOffset={bottomOffset} {...props}>
      {children}
    </KeyboardAwareScrollView>
  );
}
