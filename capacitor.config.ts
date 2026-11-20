import type { CapacitorConfig } from '@capacitor/cli';

// The Android app bundles the built web app (dist). Not used by the Windows exe.
const config: CapacitorConfig = {
  appId: 'com.jthunderbird.promptpad',
  appName: 'promptpad',
  webDir: 'dist',
  backgroundColor: '#ffffff',
  android: { allowMixedContent: false },
};

export default config;
