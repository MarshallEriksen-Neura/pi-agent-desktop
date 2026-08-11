use std::net::{IpAddr, Ipv4Addr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeTarget {
    pub mac_address: String,
    pub broadcast_address: String,
}

pub fn discover_targets(selected_addresses: &[IpAddr]) -> Vec<WakeTarget> {
    platform::discover(selected_addresses)
}

fn directed_broadcast(address: Ipv4Addr, mask: Ipv4Addr) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(address) | !u32::from(mask))
}

fn format_mac(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 6
        || bytes[0] & 1 != 0
        || bytes.iter().all(|byte| *byte == 0)
        || bytes.iter().all(|byte| *byte == 0xff)
    {
        return None;
    }
    Some(
        bytes
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{directed_broadcast, format_mac, IpAddr, Ipv4Addr, WakeTarget};
    use std::ffi::{c_char, c_ulong};
    use std::net::IpAddr::V4;
    use std::ptr;

    const ERROR_BUFFER_OVERFLOW: c_ulong = 111;
    const NO_ERROR: c_ulong = 0;

    #[repr(C)]
    struct IpAddressString {
        value: [c_char; 16],
    }

    #[repr(C)]
    struct IpAddrString {
        next: *mut IpAddrString,
        ip_address: IpAddressString,
        ip_mask: IpAddressString,
        context: c_ulong,
    }

    #[repr(C)]
    struct IpAdapterInfo {
        next: *mut IpAdapterInfo,
        combo_index: c_ulong,
        adapter_name: [c_char; 260],
        description: [c_char; 132],
        address_length: c_ulong,
        address: [u8; 8],
        index: c_ulong,
        adapter_type: c_ulong,
        dhcp_enabled: c_ulong,
        current_ip_address: *mut IpAddrString,
        ip_address_list: IpAddrString,
    }

    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetAdaptersInfo(
            adapter_info: *mut IpAdapterInfo,
            output_buffer_length: *mut c_ulong,
        ) -> c_ulong;
    }

    pub fn discover(selected_addresses: &[IpAddr]) -> Vec<WakeTarget> {
        let selected = selected_addresses
            .iter()
            .filter_map(|address| match address {
                V4(address) => Some(*address),
                _ => None,
            })
            .collect::<Vec<_>>();
        if selected.is_empty() {
            return Vec::new();
        }

        let mut required = 0;
        // SAFETY: A null first call is the documented size probe for GetAdaptersInfo.
        let probe = unsafe { GetAdaptersInfo(ptr::null_mut(), &mut required) };
        if probe != ERROR_BUFFER_OVERFLOW || required == 0 {
            return Vec::new();
        }
        let mut buffer = vec![0_u8; required as usize];
        let first = buffer.as_mut_ptr().cast::<IpAdapterInfo>();
        // SAFETY: `buffer` has the byte size requested by the API and remains
        // alive for the complete traversal of its linked adapter/IP records.
        if unsafe { GetAdaptersInfo(first, &mut required) } != NO_ERROR {
            return Vec::new();
        }

        let mut targets = Vec::new();
        let mut adapter_ptr = first;
        while !adapter_ptr.is_null() {
            // SAFETY: Adapter pointers are owned by the API-filled buffer above.
            let adapter = unsafe { &*adapter_ptr };
            let mac_len = adapter.address_length as usize;
            let mac = format_mac(&adapter.address[..mac_len.min(adapter.address.len())]);
            if let Some(mac_address) = mac {
                let mut ip_ptr: *const IpAddrString = &adapter.ip_address_list;
                while !ip_ptr.is_null() {
                    // SAFETY: IP nodes are embedded in or linked within the same API buffer.
                    let ip = unsafe { &*ip_ptr };
                    if let (Some(address), Some(mask)) = (
                        parse_ipv4(&ip.ip_address.value),
                        parse_ipv4(&ip.ip_mask.value),
                    ) {
                        if selected.contains(&address) {
                            targets.push(WakeTarget {
                                mac_address: mac_address.clone(),
                                broadcast_address: directed_broadcast(address, mask).to_string(),
                            });
                        }
                    }
                    ip_ptr = ip.next;
                }
            }
            adapter_ptr = adapter.next;
        }
        targets.sort_by(|left, right| {
            (&left.mac_address, &left.broadcast_address)
                .cmp(&(&right.mac_address, &right.broadcast_address))
        });
        targets.dedup();
        targets.truncate(8);
        targets
    }

    fn parse_ipv4(value: &[c_char; 16]) -> Option<Ipv4Addr> {
        let bytes = value
            .iter()
            .take_while(|byte| **byte != 0)
            .map(|byte| *byte as u8)
            .collect::<Vec<_>>();
        std::str::from_utf8(&bytes).ok()?.parse().ok()
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::{IpAddr, WakeTarget};

    pub fn discover(_selected_addresses: &[IpAddr]) -> Vec<WakeTarget> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{directed_broadcast, format_mac};
    use std::net::Ipv4Addr;

    #[test]
    fn computes_directed_broadcast_from_adapter_mask() {
        assert_eq!(
            directed_broadcast(
                Ipv4Addr::new(192, 168, 31, 199),
                Ipv4Addr::new(255, 255, 255, 0)
            ),
            Ipv4Addr::new(192, 168, 31, 255)
        );
        assert_eq!(
            directed_broadcast(Ipv4Addr::new(10, 4, 7, 9), Ipv4Addr::new(255, 255, 252, 0)),
            Ipv4Addr::new(10, 4, 7, 255)
        );
    }

    #[test]
    fn formats_only_real_six_byte_mac_addresses() {
        assert_eq!(
            format_mac(&[0x02, 0x42, 0xac, 0x11, 0x00, 0x02]).as_deref(),
            Some("02:42:AC:11:00:02")
        );
        assert!(format_mac(&[0; 6]).is_none());
        assert!(format_mac(&[0xff; 6]).is_none());
        assert!(format_mac(&[0x01, 0, 0, 0, 0, 1]).is_none());
        assert!(format_mac(&[1, 2, 3]).is_none());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn discovers_metadata_for_the_current_private_windows_adapter() {
        use super::discover_targets;
        use std::net::{IpAddr, SocketAddr, UdpSocket};

        let socket = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0))
            .expect("route probe socket should bind");
        socket
            .connect(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::new(192, 168, 31, 132)),
                9,
            ))
            .expect("current LAN route should be available");
        let selected = socket.local_addr().expect("selected LAN address").ip();
        let targets = discover_targets(&[selected]);

        assert!(!targets.is_empty());
        assert!(targets.iter().all(|target| {
            target.mac_address.len() == 17 && target.broadcast_address.parse::<Ipv4Addr>().is_ok()
        }));
    }
}
