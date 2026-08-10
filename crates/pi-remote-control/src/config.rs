use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub const MAX_SELECTED_BIND_ADDRESSES: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteControlConfig {
    enabled: bool,
    selected_addresses: Vec<IpAddr>,
    port: u16,
}

impl Default for RemoteControlConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            selected_addresses: Vec::new(),
            port: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindPolicyError {
    Disabled,
    NoSelectedAddress,
    TooManyAddresses,
    DuplicateAddress,
    InvalidPort,
    WildcardAddress,
    LoopbackAddress,
    LinkLocalAddress,
    MulticastAddress,
    GlobalAddress,
}

impl fmt::Display for BindPolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("remote control bind policy rejected the selected address")
    }
}

impl std::error::Error for BindPolicyError {}

impl RemoteControlConfig {
    pub fn disabled() -> Self {
        Self::default()
    }

    pub fn try_new(
        enabled: bool,
        selected_addresses: Vec<IpAddr>,
        port: u16,
    ) -> Result<Self, BindPolicyError> {
        if enabled && port == 0 {
            return Err(BindPolicyError::InvalidPort);
        }
        if enabled {
            validate_selected_addresses(&selected_addresses)?;
        }
        Ok(Self {
            enabled,
            selected_addresses,
            port,
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn selected_addresses(&self) -> &[IpAddr] {
        &self.selected_addresses
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn selected_socket_addresses(&self) -> Result<Vec<SocketAddr>, BindPolicyError> {
        if !self.enabled {
            return Err(BindPolicyError::Disabled);
        }
        let addresses = validate_selected_addresses(&self.selected_addresses)?;
        Ok(addresses
            .into_iter()
            .map(|address| SocketAddr::new(address, self.port))
            .collect())
    }
}

pub fn validate_selected_addresses(addresses: &[IpAddr]) -> Result<Vec<IpAddr>, BindPolicyError> {
    if addresses.is_empty() {
        return Err(BindPolicyError::NoSelectedAddress);
    }
    if addresses.len() > MAX_SELECTED_BIND_ADDRESSES {
        return Err(BindPolicyError::TooManyAddresses);
    }
    let mut validated = Vec::with_capacity(addresses.len());
    for address in addresses {
        if validated.contains(address) {
            return Err(BindPolicyError::DuplicateAddress);
        }
        if address.is_unspecified() {
            return Err(BindPolicyError::WildcardAddress);
        }
        if address.is_loopback() {
            return Err(BindPolicyError::LoopbackAddress);
        }
        if address.is_multicast() {
            return Err(BindPolicyError::MulticastAddress);
        }
        match address {
            IpAddr::V4(value) if is_rfc1918(*value) => validated.push(*address),
            IpAddr::V6(value) if is_ula(*value) => validated.push(*address),
            IpAddr::V4(value) if value.is_link_local() => {
                return Err(BindPolicyError::LinkLocalAddress)
            }
            IpAddr::V6(value) if is_ipv6_link_local(*value) => {
                return Err(BindPolicyError::LinkLocalAddress)
            }
            _ => return Err(BindPolicyError::GlobalAddress),
        }
    }
    Ok(validated)
}

fn is_rfc1918(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

fn is_ula(address: Ipv6Addr) -> bool {
    (address.segments()[0] & 0xfe00) == 0xfc00
}

fn is_ipv6_link_local(address: Ipv6Addr) -> bool {
    (address.segments()[0] & 0xffc0) == 0xfe80
}
