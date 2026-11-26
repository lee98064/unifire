# UniFi wire shapes (Network 11.0.99, UDM Pro) — keys/types only, values removed

Captured from the real controller; use these field names for the mock controller & parsers.

## GET /proxy/network/api/s/default/stat/sysinfo → {meta:{rc}, data:[…]}

```
{anonymous_controller_id:string, autobackup:bool, build:string, console_display_version:string, data_retention_days:number, data_retention_time_in_hours_for_5minutes_scale:number, data_retention_time_in_hours_for_daily_scale:number, data_retention_time_in_hours_for_hourly_scale:number, data_retention_time_in_hours_for_monthly_scale:number, data_retention_time_in_hours_for_others:number, debug_device:string, debug_mgmt:string, debug_sdn:string, debug_setting_preference:string, debug_system:string, has_webrtc_support:bool, hostname:string, https_port:number, image_maps_use_google_engine:bool, inform_port:number, ip_addrs:array<string>, is_cloud_console:bool, live_chat:string, name:string, override_inform_host:bool, portal_http_port:number, previous_version:string, radius_disconnect_running:bool, sso_app_id:string, store_enabled:string, timezone:string, ubnt_device_type:string, udm_version:string, unsupported_device_count:number, unsupported_device_list:array<?>, update_available:bool, update_downloaded:bool, uptime:number, version:string}
```

Example values: version "11.0.99", console_display_version "6.0.17", name "Dream Machine Pro", ubnt_device_type "UDMPRO", timezone "Asia/Taipei"

## GET /proxy/network/api/s/default/rest/networkconf → {meta, data:[…]} (field union per purpose; x_* are secrets)

### purpose=corporate vpn_type=None
```
_id:string, attr_hidden_id:string, attr_no_delete:bool, auto_scale_enabled:bool, dhcp_relay_enabled:bool, dhcp_relay_servers:array<?>, dhcpd_boot_enabled:bool, dhcpd_conflict_checking:bool, dhcpd_dns_1:string, dhcpd_dns_2:string, dhcpd_dns_3:string, dhcpd_dns_4:string, dhcpd_dns_enabled:bool, dhcpd_enabled:bool, dhcpd_gateway_enabled:bool, dhcpd_ip_1:string, dhcpd_leasetime:number, dhcpd_ntp_enabled:bool, dhcpd_start:string, dhcpd_stop:string, dhcpd_tftp_server:string, dhcpd_time_offset_enabled:bool, dhcpd_unifi_controller:string, dhcpd_wins_1:string, dhcpd_wins_2:string, dhcpd_wins_enabled:bool, dhcpd_wpad_url:string, dhcpdv6_allow_slaac:bool, dhcpdv6_dns_auto:bool, dhcpdv6_enabled:bool, dhcpdv6_leasetime:number, dhcpdv6_start:string, dhcpdv6_stop:string, dhcpguard_enabled:bool, domain_name:string, dpi_enabled:bool, enabled:bool, external_id:string, firewall_zone_id:string, gateway_type:string, igmp_snooping:bool, internet_access_enabled:bool, ip_aliases:array<?>, ip_subnet:string, ipv6_aliases:array<?>, ipv6_client_address_assignment:string, ipv6_interface_type:string, ipv6_pd_auto_prefixid_enabled:bool, ipv6_pd_start:string, ipv6_pd_stop:string, ipv6_ra_enabled:bool, ipv6_ra_preferred_lifetime:number, ipv6_ra_priority:string, ipv6_setting_preference:string, ipv6_subnet:string, is_nat:bool, legacy_id:string, lte_lan_enabled:bool, mdns_enabled:bool, name:string, nat_outbound_ip_addresses:array<?>, network_isolation_enabled:bool, networkgroup:string, purpose:string, setting_preference:string, site_id:string, upnp_lan_enabled:bool, vlan:number, vlan_enabled:bool, wan_dhcpv6_pd_size_auto:bool
```

### purpose=guest vpn_type=None
```
_id:string, auto_scale_enabled:bool, dhcp_relay_enabled:bool, dhcpd_boot_enabled:bool, dhcpd_conflict_checking:bool, dhcpd_dns_enabled:bool, dhcpd_enabled:bool, dhcpd_gateway_enabled:bool, dhcpd_leasetime:number, dhcpd_ntp_enabled:bool, dhcpd_start:string, dhcpd_stop:string, dhcpd_tftp_server:string, dhcpd_time_offset_enabled:bool, dhcpd_unifi_controller:string, dhcpd_wins_enabled:bool, dhcpd_wpad_url:string, dhcpdv6_allow_slaac:bool, dhcpdv6_dns_auto:bool, dhcpdv6_enabled:bool, dhcpdv6_leasetime:number, dhcpdv6_start:string, dhcpdv6_stop:string, dhcpguard_enabled:bool, domain_name:string, dpi_enabled:bool, enabled:bool, external_id:string, firewall_zone_id:string, gateway_type:string, igmp_snooping:bool, internet_access_enabled:bool, ip_subnet:string, ipv6_client_address_assignment:string, ipv6_interface_type:string, ipv6_pd_auto_prefixid_enabled:bool, ipv6_pd_start:string, ipv6_pd_stop:string, ipv6_ra_enabled:bool, ipv6_ra_preferred_lifetime:number, ipv6_ra_priority:string, ipv6_setting_preference:string, legacy_id:string, lte_lan_enabled:bool, mdns_enabled:bool, name:string, nat_outbound_ip_addresses:array<?>, networkgroup:string, purpose:string, setting_preference:string, site_id:string, upnp_lan_enabled:bool, vlan:number, vlan_enabled:bool, wan_dhcpv6_pd_size_auto:bool
```

### purpose=remote-user-vpn vpn_type=wireguard-server
```
_id:string, dhcpd_dns_1:string, dhcpd_dns_2:string, dhcpd_dns_enabled:bool, dhcpd_start:string, dhcpd_stop:string, dhcpd_wins_enabled:bool, dpi_enabled:bool, enabled:bool, external_id:string, firewall_zone_id:string, igmp_snooping:bool, interface_mtu_enabled:bool, ip_subnet:string, ipv6_subnet:string, legacy_id:string, local_port:number, mdns_enabled:bool, mss_clamp:string, mss_clamp_ipv6:string, mss_clamp_mss_ipv6:number, name:string, purpose:string, setting_preference:string, site_id:string, vlan_enabled:bool, vpn_binding_mode:string, vpn_client_configuration_remote_ip_override:string, vpn_client_configuration_remote_ip_override_enabled:bool, vpn_type:string, wan_dhcpv6_pd_size_auto:bool, wireguard_id:number, wireguard_interface:string, wireguard_interface_binding_mode_ip_version:string, wireguard_local_wan_ip:string, wireguard_public_key:string
```

### purpose=vpn-client vpn_type=wireguard-client
```
_id:string, dhcpd_dns_1:string, dhcpd_dns_2:string, dhcpd_dns_enabled:bool, dpi_enabled:bool, enabled:bool, external_id:string, firewall_zone_id:string, igmp_snooping:bool, interface_mtu:number, interface_mtu_enabled:bool, ip_subnet:string, legacy_id:string, mdns_enabled:bool, mss_clamp:string, mss_clamp_ipv6:string, mss_clamp_mss:number, name:string, purpose:string, routing_table_id:number, site_id:string, vlan_enabled:bool, vpn_type:string, wan_dhcpv6_pd_size_auto:bool, wireguard_client_configuration_filename:string, wireguard_client_mode:string, wireguard_client_peer_ip:string, wireguard_client_peer_port:number, wireguard_client_peer_public_key:string, wireguard_client_preshared_key_enabled:bool, wireguard_id:number, wireguard_public_key:string
```

### purpose=vpn-client vpn_type=openvpn-client
```
_id:string, dhcpd_dns_enabled:bool, dpi_enabled:bool, enabled:bool, external_id:string, firewall_zone_id:string, igmp_snooping:bool, interface_mtu_enabled:bool, ip_subnet:string, legacy_id:string, mdns_enabled:bool, mss_clamp:string, mss_clamp_mss:number, name:string, openvpn_configuration_filename:string, openvpn_configuration_status:string, openvpn_id:number, openvpn_username:string, purpose:string, site_id:string, vlan_enabled:bool, vpn_type:string, wan_dhcpv6_pd_size_auto:bool
```

### purpose=wan vpn_type=None
```
_id:string, attr_hidden_id:string, attr_no_delete:bool, dhcpd_dns_enabled:bool, dpi_enabled:bool, enabled:bool, external_id:string, firewall_zone_id:string, igmp_proxy_for:string, igmp_proxy_upstream:bool, igmp_snooping:bool, ipv6_setting_preference:string, ipv6_wan_delegation_type:string, legacy_id:string, mac_override:string, mac_override_enabled:bool, mdns_enabled:bool, name:string, purpose:string, report_wan_event:bool, routing_table_id:number, setting_preference:string, single_network_lan:string, site_id:string, vlan_enabled:bool, wan_dhcp_options:array<?>, wan_dhcpv6_pd_size_auto:bool, wan_dns1:string, wan_dns2:string, wan_dns_preference:string, wan_failover_priority:number, wan_ip_aliases:array<?>, wan_ipv6_dns1:string, wan_ipv6_dns2:string, wan_ipv6_dns_preference:string, wan_load_balance_type:string, wan_load_balance_weight:number, wan_networkgroup:string, wan_pppoe_password_enabled:bool, wan_pppoe_username_enabled:bool, wan_provider_capabilities:{download_kilobits_per_second:number, upload_kilobits_per_second:number}, wan_smartq_enabled:bool, wan_type:string, wan_type_v6:string, wan_username:string, wan_vlan_enabled:bool
```

## GET /proxy/network/v2/api/site/default/trafficroutes → bare array

```
_id: string
description: string
domains: array<{domain:string, port_ranges:array<?>, ports:array<?>}>
enabled: bool
ip_addresses: array<{ip_or_subnet:string, ip_version:string, port_ranges:array<?>, ports:array<?>}>
ip_ranges: array<{ip_start:string, ip_stop:string, ip_version:string}>
kill_switch_enabled: bool
matching_target: string
network_id: string
next_hop: string
origin_id: string
origin_type: string
predefined: bool
regions: array<string>
target_devices: array<{client_mac:string, type:string}>
```

Notes: origin_type is "object_pbr" for routes generated by Object Manager objects (origin_id = object id); absent for plain routes. network_id = egress networkconf _id. next_hop "" for interface routes.

## GET /proxy/network/v2/api/site/default/object-oriented-network-configs → bare array (PUT singular …/object-oriented-network-config/{id})

```
{enabled:bool, id:string, name:string, qos:{all_traffic:bool, apps:{enabled:bool, values:array<?>}, domains:{enabled:bool, values:array<?>}, download_limit:{burst:string, enabled:bool, limit:number}, enabled:bool, ip_addresses:{enabled:bool, values:array<?>}, mode:string, regions:{enabled:bool, values:array<?>}, upload_limit:{burst:string, enabled:bool, limit:number}}, route:{all_traffic:bool, apps:{enabled:bool, values:array<?>}, domains:{enabled:bool, values:array<?>}, enabled:bool, ip_addresses:{enabled:bool, values:array<?>}, kill_switch:bool, network_id:string, regions:{enabled:bool, values:array<?>}}, secure:{enabled:bool, internet:{apps:{enabled:bool, values:array<?>}, domains:{enabled:bool, values:array<?>}, everything:bool, ip_addresses:{enabled:bool, values:array<?>}, mode:string, regions:{enabled:bool, values:array<?>}, schedule:{mode:string, time_range_end:string, time_range_start:string}}}, target_type:string, targets:array<{type:string, value:string}>}
```

## GET /proxy/network/v2/api/site/default/firewall/zone → bare array

```
{_id:string, attr_no_edit:bool, cloud_template:null, default_zone:bool, external_id:string, name:string, network_ids:array<string>, zone_key:string}
```

