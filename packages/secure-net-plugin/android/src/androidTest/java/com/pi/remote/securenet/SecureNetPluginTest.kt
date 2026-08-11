package com.pi.remote.securenet

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * SecureNetPlugin — instrumented tests that run on an Android device/emulator.
 *
 * These tests verify the plugin's integration with the Capacitor runtime:
 *  - The plugin is registered in capacitor.plugins.json (auto-discovery)
 *  - The PinCodec class is loadable and produces correct pins
 *  - Fail-closed: no pin registered ⇒ no request can be made
 *
 * Full HTTPS/WSS integration tests require a mock TLS server on the LAN and
 * are covered by the TS-side e2e flow (pairing → connect → event stream).
 * These Kotlin tests focus on the native-layer contracts that can't be
 * tested from TypeScript.
 */
@RunWith(AndroidJUnit4::class)
class SecureNetPluginTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    // ------------------------------------------------------------------
    // Plugin registration — auto-discovered via capacitor.plugins.json
    // ------------------------------------------------------------------

    @Test
    fun `SecureNetPlugin is registered in capacitor plugins json`() {
        val asset = context.assets.open("capacitor.plugins.json").bufferedReader().use { it.readText() }
        val plugins = JSONArray(asset)
        var found = false
        for (i in 0 until plugins.length()) {
            val entry = plugins.getJSONObject(i)
            if (entry.optString("classpath") == "com.pi.remote.securenet.SecureNetPlugin") {
                found = true
                assertEquals("@pi/secure-net-plugin", entry.optString("pkg"))
            }
        }
        assertTrue("SecureNetPlugin must be registered in capacitor.plugins.json", found)
    }

    @Test
    fun `SecureNetPlugin class is loadable on the Android runtime`() {
        val clazz = Class.forName("com.pi.remote.securenet.SecureNetPlugin")
        assertEquals("com.pi.remote.securenet.SecureNetPlugin", clazz.name)
    }

    // ------------------------------------------------------------------
    // PinCodec — native-layer conversion matches the TS contract
    // ------------------------------------------------------------------

    @Test
    fun `PinCodec formats all-zeros hex as sha256-slash-base64`() {
        val zeroHex = "0".repeat(64)
        val pin = PinCodec.formatOkHttpPin(zeroHex)
        assertTrue("pin must start with sha256/", pin.startsWith("sha256/"))
        // 32 zero bytes → 43 'A's + '=' padding
        assertEquals("sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", pin)
    }

    @Test
    fun `PinCodec rejects empty pin with fail-closed`() {
        try {
            PinCodec.hexToBytes("")
            error("should have thrown PinCodecError")
        } catch (e: PinCodecError) {
            assertEquals("empty", e.code)
        }
    }

    @Test
    fun `PinCodec rejects non-hex pin with fail-closed`() {
        try {
            PinCodec.hexToBytes("g".repeat(64))
            error("should have thrown PinCodecError")
        } catch (e: PinCodecError) {
            assertEquals("invalid_chars", e.code)
        }
    }

    @Test
    fun `PinCodec rejects wrong-length pin with fail-closed`() {
        try {
            PinCodec.hexToBytes("abc123")
            error("should have thrown PinCodecError")
        } catch (e: PinCodecError) {
            assertEquals("invalid_length", e.code)
        }
    }

    @Test
    fun `PinCodec isValidHexPin returns false for invalid without throwing`() {
        assertEquals(false, PinCodec.isValidHexPin(""))
        assertEquals(false, PinCodec.isValidHexPin("abc"))
        assertEquals(false, PinCodec.isValidHexPin("g".repeat(64)))
        assertEquals(true, PinCodec.isValidHexPin("0".repeat(64)))
    }

    // ------------------------------------------------------------------
    // Fail-closed contract: no pin registered ⇒ request is rejected before
    // reaching the TLS handshake. This is enforced by the plugin's
    // `request` and `openStream` methods checking the `pins` map.
    // A full integration test (register pin → HTTPS request → success)
    // requires a mock TLS server and is deferred to LAN device testing.
    // ------------------------------------------------------------------

    @Test
    fun `fail-closed: SecureNetPlugin class exists and has the expected methods`() {
        // Verify the plugin exposes the fail-closed contract methods.
        // The actual pin_not_registered rejection is tested via the
        // Capacitor bridge in an e2e flow; here we verify the API surface.
        val clazz = Class.forName("com.pi.remote.securenet.SecureNetPlugin")
        val methods = clazz.declaredMethods.map { it.name }.toSet()
        assertTrue("must have registerCertPin", methods.contains("registerCertPin"))
        assertTrue("must have clearCertPin", methods.contains("clearCertPin"))
        assertTrue("must have request", methods.contains("request"))
        assertTrue("must have openStream", methods.contains("openStream"))
        assertTrue("must have closeStream", methods.contains("closeStream"))
    }
}
