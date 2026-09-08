# Troubleshooting

- **ID-only pairing cannot find the endpoint:** enable Internet address lookup on both instances, or paste a ticket. A bare public key is not an IP address.
- **No nearby candidates:** mDNS defaults off. Enable it explicitly, check the interface and multicast network, or use manual pairing. VPNs/VLANs/containers may block multicast.
- **Prebuilt package unavailable:** install the exact Iroh native dependency for the supported platform; no source build is attempted. Intel macOS is not among the 1.1.0 published targets.
- **Pair request remains pending:** the recipient must accept. Failed matching requests can be retried. To change the pairing attempt, cancel and explicitly remove the revoked record first.
- **No chat directory entry:** pairing is incomplete, the peer is unreachable, or its receiver-owned policy does not expose the destination.
- **Files fail:** enable file permission at the receiver and respect four files, 16 MiB each, 32 MiB total. Hash/size mismatches are rejected.
- **Interrupted/unknown delivery:** retry the same stored outbound ID. If the receiver reports an ambiguous outcome, inspect the destination timeline before proceeding.
- **Old peer URLs/settings rejected:** intentional clean break. Configure and pair the new clients; no old state is imported.

Never disable certificate/identity checks or turn on discovery as a workaround for a permission failure.
