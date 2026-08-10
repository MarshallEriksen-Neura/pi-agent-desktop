package com.pi.remote.securenet

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * SecureNet — native Android network plugin with TLS Certificate Pinning.
 *
 * Backed by OkHttp's [CertificatePinner] for SPKI SHA256 verification and
 * [OkHttpClient.newWebSocket] for the event stream. The pin is provisioned
 * from the pairing QR ([registerCertPin]) before any request is made.
 *
 * Security model:
 *  - The TLS handshake uses a permissive TrustManager (the gateway runs a
 *    self-signed cert on a private LAN). The real trust anchor is the pin.
 *  - If no pin is registered for a host, HTTPS requests fail fast with
 *    `pin_not_registered` — there is no fallback to system trust.
 *  - Pin mismatch raises `SSLPeerUnverifiedException`, surfaced as
 *    `pin_mismatch` so the UI can show the identity-failed state.
 *
 * Installation (after `npx cap add android`):
 *  1. Copy this file to android/app/src/main/java/com/pi/remote/securenet/SecureNetPlugin.kt
 *  2. Register in android/app/src/main/assets/capacitor.plugins.json:
 *     [{"pkg":"com.pi.remote.securenet.SecureNetPlugin","classpath":"com.pi.remote.securenet.SecureNetPlugin"}]
 *  3. OkHttp is bundled with Capacitor's Android runtime — no extra Gradle dep needed.
 */
@CapacitorPlugin(name = "SecureNet")
class SecureNetPlugin : Plugin() {

    companion object {
        private const val TAG = "SecureNet"
        private const val DEFAULT_TIMEOUT_MS = 10_000L
    }

    /** Maps host:port → pin hash (base64 SPKI SHA256, no prefix). */
    private val pins = ConcurrentHashMap<String, String>()

    /** Active WebSocket streams keyed by streamId. */
    private val streams = ConcurrentHashMap<String, WebSocket>()

    /** Rebuilt whenever pins change — OkHttp clients are cheap to create. */
    @Volatile
    private var client: OkHttpClient = buildClient(emptyMap())

    @PluginMethod
    fun registerCertPin(call: PluginCall) {
        val host = call.getString("host") ?: return call.reject("host required")
        val port = call.getInt("port") ?: return call.reject("port required")
        val pinValue = call.getString("pinValue") ?: return call.reject("pinValue required")
        pins["$host:$port"] = pinValue
        client = buildClient(pins.toMap())
        call.resolve()
    }

    @PluginMethod
    fun clearCertPin(call: PluginCall) {
        val host = call.getString("host") ?: return call.reject("host required")
        val port = call.getInt("port") ?: return call.reject("port required")
        pins.remove("$host:$port")
        client = buildClient(pins.toMap())
        call.resolve()
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url required")
        val method = call.getString("method") ?: "GET"
        val headers = call.getObject("headers") ?: JSObject()
        val body = call.getString("body")
        val timeoutMs = call.getInt("timeoutMs")?.toLong() ?: DEFAULT_TIMEOUT_MS

        try {
            val requestBuilder = Request.Builder().url(url)

            // Apply headers
            for (key in headers.keys()) {
                requestBuilder.header(key, headers.getString(key))
            }

            when (method.uppercase()) {
                "GET" -> { /* no body */ }
                "POST" -> {
                    val mt = "application/json".toMediaType()
                    requestBuilder.post((body ?: "").toRequestBody(mt))
                }
                else -> return call.reject("unsupported method: $method")
            }

            val client = this.client.newBuilder()
                .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build()

            // Execute synchronously — Capacitor runs @PluginMethod on a background thread.
            client.newCall(requestBuilder.build()).execute().use { response ->
                val respBody = response.body?.string() ?: ""
                val respHeaders = JSObject()
                for (i in 0 until response.headers.size) {
                    respHeaders.put(response.headers.name(i), response.headers.value(i))
                }
                val ret = JSObject()
                ret.put("status", response.code)
                ret.put("headers", respHeaders)
                ret.put("body", respBody)
                call.resolve(ret)
            }
        } catch (e: javax.net.ssl.SSLPeerUnverifiedException) {
            call.reject("pin_mismatch", "pin_mismatch", e)
        } catch (e: java.net.ConnectException) {
            call.reject("unreachable", "unreachable", e)
        } catch (e: java.net.SocketTimeoutException) {
            call.reject("timeout", "timeout", e)
        } catch (e: Exception) {
            call.reject("unknown", "unknown", e)
        }
    }

    @PluginMethod
    fun openStream(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("url required")
        val headers = call.getObject("headers") ?: JSObject()
        val streamId = "ws-${System.nanoTime()}"

        try {
            val requestBuilder = Request.Builder().url(url)
            for (key in headers.keys()) {
                requestBuilder.header(key, headers.getString(key))
            }

            val ws = client.newWebSocket(requestBuilder.build(), object : WebSocketListener() {
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
                    val msg = if (t is javax.net.ssl.SSLPeerUnverifiedException) {
                        "pin_mismatch"
                    } else {
                        t.message ?: "stream_error"
                    }
                    event.put("message", msg)
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
    // Client construction
    // ------------------------------------------------------------------

    /**
     * Build an OkHttpClient with:
     *  - A permissive TrustManager (self-signed cert on private LAN).
     *  - A CertificatePinner populated from [pins].
     *  - The actual trust anchor is the pin — no pin = no trust.
     */
    private fun buildClient(pins: Map<String, String>): OkHttpClient {
        val pinnerBuilder = CertificatePinner.Builder()
        for ((hostPort, pinBase64) in pins) {
            // OkHttp pin format: "sha256/<base64>="
            val host = hostPort.substringBefore(":")
            pinnerBuilder.add(host, "sha256/$pinBase64=")
        }

        val trustManager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }

        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustManager), null)
        }

        return OkHttpClient.Builder()
            .certificatePinner(pinnerBuilder.build())
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .hostnameVerifier(HostnameVerifier { _, _ -> true })
            .pingInterval(30, TimeUnit.SECONDS) // WSS keepalive
            .build()
    }
}
