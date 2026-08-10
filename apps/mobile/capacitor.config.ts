import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.pi.remote",
  appName: "Pi Remote",
  webDir: "dist",
  server: {
    // Allow cleartext for development only; production uses HTTPS with cert pinning.
    cleartext: false,
  },
  android: {
    // Allow mixed content in dev only — the gateway always serves HTTPS.
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
    },
  },
};

export default config;
