package com.pi.remote.securenet

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class WakeOnLanCodecTest {
    @Test
    fun `magic packet contains six ff bytes and sixteen MAC copies`() {
        val mac = WakeOnLanCodec.parseMac("02:42:AC:11:00:02")
        val packet = WakeOnLanCodec.buildMagicPacket(mac)

        assertEquals(102, packet.size)
        assertArrayEquals(ByteArray(6) { 0xff.toByte() }, packet.copyOfRange(0, 6))
        repeat(16) { copy ->
            assertArrayEquals(mac, packet.copyOfRange(6 + copy * 6, 12 + copy * 6))
        }
    }

    @Test
    fun `target parser accepts private broadcasts`() {
        val target = WakeOnLanCodec.parseTarget("02:42:AC:11:00:02", "192.168.31.255")
        assertArrayEquals(
            byteArrayOf(192.toByte(), 168.toByte(), 31, 255.toByte()),
            target.broadcastAddress,
        )
    }

    @Test
    fun `target parser rejects public destinations and unusable MACs`() {
        assertThrows(IllegalArgumentException::class.java) {
            WakeOnLanCodec.parseTarget("02:42:AC:11:00:02", "8.8.8.8")
        }
        assertThrows(IllegalArgumentException::class.java) {
            WakeOnLanCodec.parseTarget("01:00:5E:00:00:01", "192.168.31.255")
        }
    }
}
