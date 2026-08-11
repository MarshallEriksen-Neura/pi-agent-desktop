import { PRIVATE_RANGES } from "./constants";
import { getPort } from "@/lib/backend/composition/container";

/**
 * Discover candidate private LAN addresses for the network-config picker.
 *
 * The desktop backend derives addresses from the host routing table. WebRTC ICE
 * gathering remains as a browser-compatible supplement. The backend still
 * validates and re-binds to private addresses on `enable`, so these candidates
 * are purely a UX hint — never trusted as authoritative.
 *
 * Returns an empty array when WebRTC is unavailable (e.g. a hardened context),
 * in which case the picker falls back to a manual text input.
 */
export async function detectPrivateAddresses(): Promise<string[]> {
  const seen = new Set<string>();
  try {
    const native = await getPort("remoteControl").privateAddresses();
    for (const ip of native) {
      if (isPrivateIp(ip)) seen.add(ip);
    }
  } catch {
    // Browser previews or older desktop binaries may not expose the command.
    // Continue with WebRTC so the UI remains usable during rolling upgrades.
  }

  if (typeof RTCPeerConnection === "undefined") return [...seen];

  return new Promise<string[]>((resolve) => {
    const collect = () => {
      pc.close();
      resolve([...seen]);
    };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      collect();
    };

    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch {
      resolve([]);
      return;
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        finish();
        return;
      }
      const match = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
      if (match) {
        const ip = match[1];
        if (isPrivateIp(ip)) seen.add(ip);
      }
    };

    // Some WebViews never emit a null candidate; cap at 1.5s.
    const timer = setTimeout(finish, 1500);

    pc.createDataChannel("");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => {
        clearTimeout(timer);
        finish();
      });
  });
}

/** True for RFC 1918 private IPv4 addresses. */
export function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  return PRIVATE_RANGES.some(([lo, midLo, midHi]) => {
    if (lo === 10) return a === 10;
    if (lo === 172) return a === 172 && b >= 16 && b <= 31;
    if (lo === 192) return a === 192 && b === 168;
    return false;
  });
}
