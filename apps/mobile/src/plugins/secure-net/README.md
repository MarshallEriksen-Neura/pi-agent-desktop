# SecureNet Plugin

A local Capacitor plugin that routes all HTTP + WebSocket traffic through a
native network stack with TLS Certificate Pinning (SPKI SHA256).

## Architecture

| Platform | Network Stack | Cert Pinning |
|---|---|---|
| Android | OkHttp `CertificatePinner` + `newWebSocket()` | SPKI SHA256 |
| iOS (future) | URLSessionDelegate + `URLSessionWebSocketTask` | SPKI SHA256 |
| Browser (dev) | `fetch` + `WebSocket` | ⚠️ None — dev preview only |

## Android Installation

After running `npx cap add android`:

### 1. Copy the Kotlin source

```bash
cp src/plugins/secure-net/android/SecureNetPlugin.kt \
   android/app/src/main/java/com/pi/remote/securenet/SecureNetPlugin.kt
```

### 2. Register the plugin

Edit `android/app/src/main/assets/capacitor.plugins.json`:

```json
[
  {
    "pkg": "com.pi.remote.securenet.SecureNetPlugin",
    "classpath": "com.pi.remote.securenet.SecureNetPlugin"
  }
]
```

### 3. Build

OkHttp is bundled with Capacitor's Android runtime — no extra Gradle dependency
is needed. Open the project in Android Studio and build:

```bash
npx cap open android
```

## iOS Installation (future)

When a Mac is available:

1. Create `ios/App/App/SecureNet/SecureNetPlugin.swift` + `SecureNetPlugin.m`
2. Implement using `URLSessionDelegate` (pin validation) + `URLSessionWebSocketTask`
3. Register in `ios/App/App/capacitor.config.json`

The logic is identical to Android — pin the SPKI SHA256, reject on mismatch.

## Security Model

- The gateway runs a **self-signed cert** on a private LAN.
- The TrustManager is permissive (trusts all certs for the handshake).
- The **real trust anchor is the pin** — no pin registered = no request.
- Pin mismatch → `SSLPeerUnverifiedException` → surfaced as `pin_mismatch`.
- The pin is provisioned from the pairing QR (scanned locally, never over network).
