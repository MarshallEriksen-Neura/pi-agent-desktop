package com.pi.remote.securenet

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URI
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.io.encoding.Base64 as KotlinBase64
import kotlin.io.encoding.ExperimentalEncodingApi

/**
 * SecureNet — native Android network plugin with TLS Certificate Pinning.
 *
 * Backed by a host-scoped [SpkiPinTrustManager] for SPKI SHA256 verification
 * and [OkHttpClient.newWebSocket] for the event stream. The pin is provisioned
 * from the pairing QR ([registerCertPin]) **before** any request is made.
 *
 * Security model (P0-secured):
 *  - The desktop gateway uses a self-signed cert on a private LAN. A dedicated
 *    TrustManager verifies the peer certificate's SPKI during the TLS
 *    handshake; the QR pin is the sole trust anchor.
 *  - **Fail closed**: if no pin is registered for a request's host, both
 *    `request` and `openStream` reject with `pin_not_registered`. There is
 *    no fallback to system trust and no empty-pin bypass. A previous version
 *    silently let requests through when no pin was registered — that is gone.
 *  - The pin input MUST be a 64-character lowercase hex SPKI SHA256 digest
 *    (the wire format emitted by `identity.rs`). [PinCodec] validates the hex,
 *    decodes 32 bytes, and compares those bytes in constant time. The
 *    `sha256/<base64>` representation is retained for diagnostics and tests.
 *  - Pin mismatch is surfaced as `pin_mismatch` with expected/peer public pin
 *    diagnostics so the UI can distinguish a stale QR from interception.
 *
 * Installation (after `npx cap sync android`): the plugin is auto-registered
 * via `capacitor.plugins.json` from the local `@pi/secure-net-plugin` package;
 * no manual copy or hand-edit of generated files is required.
 */
@CapacitorPlugin(name = "SecureNet")
class SecureNetPlugin : Plugin() {

    companion object {
        private const val TAG = "SecureNet"
        private const val DEFAULT_TIMEOUT_MS = 10_000L
        private const val MAX_WAKE_TARGETS = 8
        private const val WAKE_PORT = 9
        private const val WAKE_REPEATS = 3
        private const val WAKE_INTERVAL_MS = 100L
    }

    /**
     * Pins keyed by lowercase hostname + port. Each request builds a client
     * whose TrustManager is scoped to that endpoint's expected SPKI, so a
     * certificate registered for one desktop can never authorize another
     * host or service on a different port.
     */
    private val pins = ConcurrentHashMap<EndpointKey, RegisteredPin>()

    /** Active WebSocket streams keyed by streamId. */
    private val streams = ConcurrentHashMap<String, WebSocket>()

    @PluginMethod
    fun registerCertPin(call: PluginCall) {
        val host = call.getString("host") ?: return call.reject("host required")
        val port = call.getInt("port") ?: return call.reject("port required")
        val pinHex = call.getString("pinValue") ?: return call.reject("pinValue required")
        val endpoint = EndpointKey.fromParts(host, port)
            ?: return call.reject("invalid_endpoint", "invalid_endpoint")

        val registeredPin = try {
            RegisteredPin(PinCodec.hexToBytes(pinHex))
        } catch (e: PinCodecError) {
            return call.reject("invalid_pin", "invalid_pin", e)
        }
        pins[endpoint] = registeredPin
        call.resolve()
    }

    @PluginMethod
    fun clearCertPin(call: PluginCall) {
        val host = call.getString("host") ?: return call.reject("host required")
        val port = call.getInt("port") ?: return call.reject("port required")
        val endpoint = EndpointKey.fromParts(host, port)
            ?: return call.reject("invalid_endpoint", "invalid_endpoint")
        pins.remove(endpoint)
        call.resolve()
    }

    @PluginMethod
    fun wakeOnLan(call: PluginCall) {
        val input = call.getArray("targets") ?: return call.reject("targets required")
        if (input.length() == 0 || input.length() > MAX_WAKE_TARGETS) {
            return call.reject("invalid_wake_targets", "invalid_wake_targets")
        }
        val targets = try {
            (0 until input.length()).map { index ->
                val target = input.getJSONObject(index)
                WakeOnLanCodec.parseTarget(
                    target.getString("macAddress"),
                    target.getString("broadcastAddress"),
                )
            }
        } catch (error: Exception) {
            return call.reject("invalid_wake_targets", "invalid_wake_targets", error)
        }

        Thread({
            try {
                var packetsSent = 0
                val globalBroadcast = byteArrayOf(-1, -1, -1, -1)
                DatagramSocket().use { socket ->
                    socket.broadcast = true
                    repeat(WAKE_REPEATS) { repeatIndex ->
                        for (target in targets) {
                            val destinations = if (target.broadcastAddress.contentEquals(globalBroadcast)) {
                                listOf(globalBroadcast)
                            } else {
                                listOf(target.broadcastAddress, globalBroadcast)
                            }
                            for (destination in destinations) {
                                val packet = DatagramPacket(
                                    target.magicPacket,
                                    target.magicPacket.size,
                                    InetAddress.getByAddress(destination),
                                    WAKE_PORT,
                                )
                                socket.send(packet)
                                packetsSent += 1
                            }
                        }
                        if (repeatIndex + 1 < WAKE_REPEATS) {
                            Thread.sleep(WAKE_INTERVAL_MS)
                        }
                    }
                }
                val result = JSObject()
                result.put("packetsSent", packetsSent)
                result.put("targetCount", targets.size)
                call.resolve(result)
            } catch (error: Exception) {
                call.reject("wake_failed", "wake_failed", error)
            }
        }, "pi-wake-on-lan").start()
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url required")
        val method = call.getString("method") ?: "GET"
        val headers = call.getObject("headers") ?: JSObject()
        val body = call.getString("body")
        val timeoutMs = call.getInt("timeoutMs")?.toLong() ?: DEFAULT_TIMEOUT_MS

        // Fail closed: every HTTPS request must go to a host with a registered pin.
        val endpoint = try {
            EndpointKey.fromUrl(url) ?: return call.reject("invalid_url", "invalid_url")
        } catch (e: Exception) {
            return call.reject("invalid_url", "invalid_url", e)
        }
        val registeredPin = pins[endpoint]
        if (registeredPin == null) {
            return call.reject("pin_not_registered", "pin_not_registered")
        }

        try {
            val requestBuilder = Request.Builder().url(url)
            for (key in headers.keys()) {
                val value = headers.getString(key) ?: continue
                requestBuilder.header(key, value)
            }
            when (method.uppercase()) {
                "GET" -> { /* no body */ }
                "POST" -> {
                    val mt = "application/json".toMediaType()
                    requestBuilder.post((body ?: "").toRequestBody(mt))
                }
                else -> return call.reject("unsupported method: $method")
            }

            val reqClient = buildClient(registeredPin).newBuilder()
                .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build()

            val pluginCall = call
            reqClient.newCall(requestBuilder.build()).enqueue(object : Callback {
                override fun onFailure(call: Call, e: java.io.IOException) {
                    rejectRequest(pluginCall, e)
                }

                override fun onResponse(call: Call, response: Response) {
                    try {
                        response.use {
                            val respBody = it.body?.string() ?: ""
                            val respHeaders = JSObject()
                            for (i in 0 until it.headers.size) {
                                respHeaders.put(it.headers.name(i), it.headers.value(i))
                            }
                            val ret = JSObject()
                            ret.put("status", it.code)
                            ret.put("headers", respHeaders)
                            ret.put("body", respBody)
                            pluginCall.resolve(ret)
                        }
                    } catch (error: Exception) {
                        rejectRequest(pluginCall, error)
                    }
                }
            })
        } catch (e: Exception) {
            rejectRequest(call, e)
        }
    }

    @PluginMethod
    fun openStream(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url required")
        val headers = call.getObject("headers") ?: JSObject()

        val endpoint = try {
            EndpointKey.fromUrl(url) ?: return call.reject("invalid_url", "invalid_url")
        } catch (e: Exception) {
            return call.reject("invalid_url", "invalid_url", e)
        }
        val registeredPin = pins[endpoint]
        if (registeredPin == null) {
            return call.reject("pin_not_registered", "pin_not_registered")
        }

        val streamId = "ws-${System.nanoTime()}"

        try {
            val requestBuilder = Request.Builder().url(url)
            for (key in headers.keys()) {
                val value = headers.getString(key) ?: continue
                requestBuilder.header(key, value)
            }

            val ws = buildClient(registeredPin).newWebSocket(requestBuilder.build(), object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    val event = JSObject()
                    event.put("streamId", streamId)
                    event.put("data", text)
                    notifyListeners("streamMessage", event)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    streams.remove(streamId)
                    val event = JSObject()
                    event.put("streamId", streamId)
                    event.put("code", code)
                    event.put("reason", reason)
                    notifyListeners("streamClose", event)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    streams.remove(streamId)
                    val event = JSObject()
                    event.put("streamId", streamId)
                    val pinMismatch = pinMismatchDetail(t)
                    if (pinMismatch != null) {
                        event.put("message", "pin_mismatch")
                        event.put("detail", pinMismatch)
                    } else {
                        event.put("message", t.message ?: "stream_error")
                    }
                    notifyListeners("streamError", event)
                }
            })

            streams[streamId] = ws
            val ret = JSObject()
            ret.put("streamId", streamId)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("open_stream_failed", "open_stream_failed", e)
        }
    }

    @PluginMethod
    fun closeStream(call: PluginCall) {
        val streamId = call.getString("streamId") ?: return call.reject("streamId required")
        val ws = streams.remove(streamId)
        ws?.close(1000, "client closed")
        call.resolve()
    }

    // ------------------------------------------------------------------
    // Lifecycle: release all WebSockets when the activity is destroyed to
    // avoid leaking connections across activity recreation.
    // ------------------------------------------------------------------

    override fun handleOnDestroy() {
        for ((_, ws) in streams) {
            try { ws.close(1000, "activity destroyed") } catch (_: Exception) {}
        }
        streams.clear()
        super.handleOnDestroy()
    }

    private fun rejectRequest(call: PluginCall, error: Exception) {
        val pinMismatch = pinMismatchDetail(error)
        when {
            pinMismatch != null -> call.reject(pinMismatch, "pin_mismatch", error)
            error is java.net.ConnectException -> call.reject("unreachable", "unreachable", error)
            error is java.net.SocketTimeoutException ||
                (error is java.io.InterruptedIOException &&
                    error.message?.contains("timeout", ignoreCase = true) == true) ->
                call.reject("timeout", "timeout", error)
            else -> call.reject(error.message ?: "unknown", "unknown", error)
        }
    }

    // ------------------------------------------------------------------
    // Client construction
    // ------------------------------------------------------------------

    /**
     * Build an OkHttpClient with:
     *  - A TrustManager that validates the peer SPKI against exactly one
     *    host-scoped registered pin during the TLS handshake.
     *  - `hostnameVerifier` returning true is acceptable ONLY because the pin
     *    is enforced for every request via the fail-closed check above; no
     *    request reaches the TLS handshake without a registered pin.
     *
     * OkHttp's CertificatePinner cannot be combined with the old permissive
     * TrustManager here: its chain cleaner produced an empty peer chain for the
     * self-signed gateway certificate, causing every correct pin to mismatch.
     */
    private fun buildClient(pin: RegisteredPin): OkHttpClient {
        val trustManager = SpkiPinTrustManager(pin.digest)
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustManager), null)
        }

        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .hostnameVerifier(HostnameVerifier { _, _ -> true })
            .followRedirects(false)
            .followSslRedirects(false)
            .pingInterval(30, TimeUnit.SECONDS) // WSS keepalive
            .build()
    }
}

internal class RegisteredPin(digest: ByteArray) {
    val digest: ByteArray = digest.copyOf()
}

internal data class EndpointKey(val host: String, val port: Int) {
    companion object {
        fun fromParts(host: String, port: Int): EndpointKey? {
            val normalizedHost = host.trim().removePrefix("[").removeSuffix("]").lowercase()
            if (normalizedHost.isEmpty() || port !in 1..65535) return null
            return EndpointKey(normalizedHost, port)
        }

        fun fromUrl(url: String): EndpointKey? {
            val uri = URI(url)
            val scheme = uri.scheme?.lowercase()
            if (scheme != "https" && scheme != "wss") return null
            val port = if (uri.port >= 0) uri.port else 443
            return fromParts(uri.host ?: return null, port)
        }
    }
}

/**
 * Dynamic QR pin trust manager.
 *
 * Verification runs inside the TLS handshake over the peer chain supplied by
 * the platform. This avoids OkHttp's post-handshake chain cleaner, which drops
 * an intentionally self-signed chain when paired with a permissive manager.
 */
internal class SpkiPinTrustManager(expectedDigest: ByteArray) : X509TrustManager {
    private val expectedDigest = expectedDigest.copyOf()
    private val expectedPin = PinCodec.formatOkHttpPinBytes(this.expectedDigest)

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("client certificate authentication is not supported")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        if (chain.isNullOrEmpty()) {
            throw PinMismatchException(expectedPin, emptyList())
        }
        // TLS proves possession of the leaf certificate's private key only.
        // Never accept the pin from an arbitrary extra certificate supplied in
        // the peer chain.
        val peerDigest = MessageDigest.getInstance("SHA-256")
            .digest(chain[0].publicKey.encoded)
        if (!MessageDigest.isEqual(expectedDigest, peerDigest)) {
            throw PinMismatchException(
                expectedPin,
                listOf(PinCodec.formatOkHttpPinBytes(peerDigest)),
            )
        }
        chain[0].checkValidity()
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

internal class PinMismatchException(
    expectedPin: String,
    peerPins: List<String>,
) : CertificateException(
    "certificate pin mismatch: expected $expectedPin; peer " +
        if (peerPins.isEmpty()) "<empty chain>" else peerPins.joinToString(", "),
)

internal fun pinMismatchDetail(error: Throwable): String? {
    var current: Throwable? = error
    repeat(12) {
        if (current is PinMismatchException) return current?.message ?: "pin_mismatch"
        current = current?.cause
    }
    if (error is SSLPeerUnverifiedException &&
        error.message?.contains("Certificate pinning failure", ignoreCase = true) == true
    ) {
        return error.message
    }
    return null
}

/**
 * PinCodec — the Kotlin-side authoritative hex→OkHttp-pin converter.
 *
 * Mirrors `apps/mobile/src/security/pin-codec.ts`. Kept as a top-level
 * object so it is unit-testable without instantiating the plugin.
 */
object PinCodec {
    private const val PIN_HEX_LENGTH = 64
    private const val PIN_BYTE_LENGTH = 32
    private val HEX_RE = Regex("^[0-9a-fA-F]{1,}$")

    /** Format a 64-char hex digest as OkHttp's `sha256/<base64>` pin. */
    @OptIn(ExperimentalEncodingApi::class)
    fun formatOkHttpPin(hex: String): String {
        return formatOkHttpPinBytes(hexToBytes(hex))
    }

    /** Format a 32-byte digest for diagnostics and OkHttp-compatible fixtures. */
    @OptIn(ExperimentalEncodingApi::class)
    internal fun formatOkHttpPinBytes(bytes: ByteArray): String {
        if (bytes.size != PIN_BYTE_LENGTH) {
            throw PinCodecError("invalid_length", "certificate pin digest must be $PIN_BYTE_LENGTH bytes")
        }
        // Standard padded Base64 with no line breaks.
        return "sha256/${KotlinBase64.encode(bytes)}"
    }

    /** Validate + decode a 64-char hex pin to 32 bytes. */
    fun hexToBytes(hex: String): ByteArray {
        if (hex.isEmpty()) throw PinCodecError("empty", "certificate pin is missing")
        if (hex.length != PIN_HEX_LENGTH) {
            throw PinCodecError("invalid_length", "certificate pin must be $PIN_HEX_LENGTH hex chars, got ${hex.length}")
        }
        if (!HEX_RE.matches(hex)) {
            throw PinCodecError("invalid_chars", "certificate pin contains non-hex characters")
        }
        val out = ByteArray(PIN_BYTE_LENGTH)
        for (i in 0 until PIN_BYTE_LENGTH) {
            out[i] = hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
        return out
    }

    /** True iff `hex` is a valid 64-char hex SPKI digest. */
    fun isValidHexPin(hex: String): Boolean = try {
        hexToBytes(hex); true
    } catch (_: PinCodecError) {
        false
    }
}

/** Error raised when a pin is not a valid 64-char hex SPKI digest. */
class PinCodecError(val code: String, message: String) : Exception(message)

internal data class WakeOnLanTarget(
    val magicPacket: ByteArray,
    val broadcastAddress: ByteArray,
)

internal object WakeOnLanCodec {
    private val macPattern = Regex("^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")

    fun parseTarget(macAddress: String, broadcastAddress: String): WakeOnLanTarget {
        val mac = parseMac(macAddress)
        return WakeOnLanTarget(buildMagicPacket(mac), parsePrivateBroadcast(broadcastAddress))
    }

    fun parseMac(value: String): ByteArray {
        if (!macPattern.matches(value)) throw IllegalArgumentException("invalid MAC address")
        val bytes = value.split(":").map { it.toInt(16).toByte() }.toByteArray()
        if ((bytes[0].toInt() and 1) != 0 || bytes.all { it == 0.toByte() } || bytes.all { it == 0xff.toByte() }) {
            throw IllegalArgumentException("unusable MAC address")
        }
        return bytes
    }

    fun buildMagicPacket(mac: ByteArray): ByteArray {
        require(mac.size == 6) { "MAC address must contain six bytes" }
        val packet = ByteArray(6 + 16 * mac.size)
        for (index in 0 until 6) packet[index] = 0xff.toByte()
        repeat(16) { copy ->
            mac.copyInto(packet, 6 + copy * mac.size)
        }
        return packet
    }

    fun parsePrivateBroadcast(value: String): ByteArray {
        val parts = value.split(".")
        if (parts.size != 4) throw IllegalArgumentException("invalid broadcast address")
        val octets = parts.map { part ->
            if (!part.matches(Regex("^\\d{1,3}$"))) throw IllegalArgumentException("invalid broadcast address")
            part.toInt().also { if (it !in 0..255) throw IllegalArgumentException("invalid broadcast address") }
        }
        val allowed = octets.all { it == 255 } ||
            octets[0] == 10 ||
            (octets[0] == 172 && octets[1] in 16..31) ||
            (octets[0] == 192 && octets[1] == 168)
        if (!allowed) throw IllegalArgumentException("broadcast address must remain on a private LAN")
        return octets.map { it.toByte() }.toByteArray()
    }
}
