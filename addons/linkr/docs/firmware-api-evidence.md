# Firmware 1.4.2 API evidence

Recorded 12 September 2026 from an independently inspected Linkr UI and its shipped JavaScript. This is implementation evidence for future adapters, not a supported API contract or proof of successful device actions. No reboot, reset, upload, media mount or Wake-on-LAN request was executed during this inspection.

## References and authentication boundary

- [Radxa Link Skills guide](https://docs.radxa.com/en/linkr/linkr/advanced-usage/link-skills)
- [Upstream skill](https://github.com/radxa-linkr/linkr-skills)
- [Linkr firmware releases](https://github.com/radxa-linkr/linkr/releases)

The inspected UI reported firmware **1.4.2**. Its bundles were `/assets/index-DPBMPC_H.js` and lazily loaded `/assets/index-DS7XeP6g.js`; hashed asset names are version-specific.

The documented public API authenticates snapshot/control with `Authorization: token …`. The web UI uses **Bearer session authentication** and a token field in WebSocket envelopes. Acceptance of a public API token by UI endpoints has not been established. The add-on must not send its public token to these routes on that assumption, silently create a web login session, or replace another administrator's session.

## Observed UI implementation

| Feature | Evidence in firmware UI code | Qualification still required |
|---|---|---|
| Appliance reboot | Protobuf over `/ws`: `MessageType.Reboot`, `RebootReq: {}`. Enum Reboot=999; envelope RebootReq field=999, RebootReply field=1000, Token field=2. | Auth/session lifecycle, framing/schema compatibility, acknowledgement and disconnect/reconnect behaviour. This restarts the **Linkr appliance**, not the attached computer. |
| Device reset | `POST /api/device/reset` wrapper | Meaning and payload not traced. Do not describe this as reboot; it may have destructive configuration effects. |
| Media inventory | `GET /api/storage/list`, `GET /api/storage/space` | Session authentication, response schema, errors and storage limits. |
| Media mounting | `POST /api/storage/mount` with `{filename: K.name}`; `POST /api/storage/unmount` wrapper without payload | Host-visible device semantics, mount-state detection, busy/flush handling and read/write safety. |
| Media deletion | `DELETE /api/storage/file` with `{filename, md5?}` | Destructive operation; separate authorisation and mounted-file handling. Not implied by eject. |
| Image upload | UI accepts `.iso` and `.img`. WebSocket protobuf InitUpload/ChunkUpload/CancelUpload; FileUploadType VirtualDisk=0, OTA=1. | Complete protocol, checksums, chunk/size limits, cancellation and recovery. Keep virtual-disk and firmware/OTA paths strictly separate. |
| Wake-on-LAN | `POST /api/wol/wake`, `GET /api/wol/list`, `/scan`, POST `/add` and `/update`, DELETE `/api/wol` wrappers | Exact payloads, authorised target MAC/interface and response semantics. Wake is not reset, power-off or guaranteed power-on. |
| Display transport | UI shows negotiated resolution/FPS/bitrate and codec; `/ws/media` handles `ws_h264` and `ws_mjpeg` | No verified signal-present API boolean or frame-freshness guarantee. Snapshot reachability alone does not establish display signal or computer power. |

No target ATX power/reset controls were found among the eleven inspected sidebar sections. This is absence of evidence in that firmware UI, not proof that every Linkr product lacks ATX capability. Only firmware 1.4.2 was observed; no firmware-version comparison was performed.

## Adapter requirements

1. Obtain a documented or version-pinned protocol and permitted session-authentication method; use a distinct keychain reference from the public token.
2. Avoid automatic session replacement: the UI can warn that a new login ends an existing session.
3. Read-only qualification precedes any mutations. Do not probe unsupported endpoints with trial power/reset/upload requests.
4. Add mocked protocol/auth/error tests, capability gates, per-device version evidence and explicit operator-approved hardware qualification.
5. Keep appliance reboot, attached-machine reboot, Wake-on-LAN, virtual-media eject, image deletion and firmware OTA as separate actions with separate risk handling.

Until these requirements are met, v0.1 continues to return `unsupported` for power, media and appliance-reboot actions. Installation skills can request operator-supplied media or a separately authorised, verified management path.

No private device addresses, session values, raw bundles or UI screenshots are included in this evidence note.
