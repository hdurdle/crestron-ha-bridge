# CLAUDE.md

Guidance for Claude Code sessions in this repo. Read this first.

## What this is

A Node.js / Express proxy that wraps SSH access to a Crestron **DM-MD8X8-CPU3** DigitalMedia matrix switcher (firmware 1.8001, confirmed via `VERSION` on 2026-10-02). It pushes route state to Home Assistant over MQTT and also serves a REST API. See [README.md](README.md) for the user-facing description and API.

It also controls an A-NeuVideo **ANI-PiP-41UHD** 4x1 multiviewer (MCU FW 1.10.03) fed by Crestron outputs 101/102/104 on its HDMI 1/2/3. Its output goes back into Crestron input 2 ("Multi").

- [app.js](app.js) — Express app, SSH client, polling loop, route-map parser, MQTT/HA discovery, all endpoints. ~700 lines.
- [multiviewer.js](multiviewer.js) — multiviewer client: TCP-to-serial transport, state refresh, HA `select` entities. Its own file because it's a second device with its own protocol.
- The multiviewer's RS-232 command set is in the vendor's ANI-PiP-41UHD user guide (a-neuvideo.com/pdf/UG-ANI-PIP-41UHD.pdf).
- [logger.js](logger.js) — Pino instance.
- [Dockerfile](Dockerfile) — Multi-stage Node 20 alpine build. Runs as the `node` user.
- [crestronproxy-compose.yaml](crestronproxy-compose.yaml) — Compose file. All settings come from `.env` on the docker host (see [.env.example](.env.example)); the compose file has no `environment:` block. Bind-mounts `./id_rsa` into the container at `/app/id_rsa`, publishes port `8022` on the host, and has a `/status`-based healthcheck. Uses Docker's default bridge network; isolation is provided by the docker host's own network position, not by a Docker-level network.

There are no tests. `npm test` exits non-zero on purpose.

## Runtime context (non-obvious, important)

- **Deployment**: Docker Compose on a Linux docker host. The compose `build.context` is `.` (relative to the compose file). Port `8022` is published on the docker host; isolation from other networks is provided by the host's own network placement, not by a custom Docker network.
- **Auth model**: there is none. All endpoints are unauthenticated. That is acceptable *only* because of the network isolation above — do not propose exposing the service more broadly without adding auth.
- **`id_rsa`** is a runtime secret, **never** tracked in git and **never** baked into the image. The operator places it on the docker host next to `crestronproxy-compose.yaml`; compose bind-mounts it read-only at `/app/id_rsa`. The key is scoped to the Crestron device only. Do not reuse it elsewhere. (Earlier versions of this file claimed the key was intentionally committed — that's obsolete; if you see that framing anywhere else, fix it.)
- **Polling**: every `POLL_INTERVAL_MS` (5s in production) the proxy runs `DUMPDMROUTEINFO` over the persistent SSH session and re-parses it. Each run takes about 0.5s. Polling only matters for changes made outside HA; route changes through the proxy (MQTT or `/setavroute`) update the map and MQTT straight away, then a confirmation poll runs 1.5s later. SSH commands are serialised through a promise queue.
- **MQTT**: the docker host must be able to reach HA's MQTT broker (credentials in `.env` on the docker host, never committed). HA sees `select.crestron_o101`…`o108` through MQTT discovery. MQTT is optional: without `MQTT_URL` the proxy is REST-only. If the parser matches no output slots, it keeps the previous map instead of zeroing it, so a bad poll can't push `Off` to every output. Never label input 0 `None`: HA's MQTT select reads that payload as "unknown".
- **Multiviewer**: reached through a USR-TCP232-306 bridge at `MV_HOST:MV_PORT` (default port `8234`; 115200 8N1 on the serial side). ASCII commands end with `!`; every command, set or read, replies with CRLF lines in about 60ms. Read commands are layout-specific: in the wrong layout the device answers `please check your Multiview Mode and command is right?`. The bridge copies replies to every connected TCP client, so the proxy must be its only client; close the vendor's PC app first. The device's Quad layout isn't offered because only 3 sources are wired. The "Window n source" entities chain window → HDMI (`windowHdmi`, read from the device) → Crestron output (`MV_HDMI_OUTPUTS`) → input (`avRouteMap`), and route changes go through the same `setRoute()` as everything else. `applyRouteMap()` calls `multiviewer.onRoutesChanged()` so they stay current. HA templates and automations may compare against the `INPUT_NAMES` labels, so changing a label can break them. Its entities report available only when both the proxy and the multiviewer are online (`availability_mode: all`), because MQTT allows one last-will message per client.
- **Transport choice**: the SSH console is the only Crestron-supported third-party path without a control processor. CTP telnet (41795) is the same console, just unencrypted. CIP (41794) would mean emulating a processor. Neither one makes the UI more responsive; that comes from the MQTT push.

## Key invariants

These are encoded across the parser, the API, and the array layout. Touch one, touch all three.

- **Inputs**: `0`–`8`. `0` means "no source routed". (DM-MD8x8 has 8 physical inputs.)
- **Outputs (API)**: `101`–`108`. MQTT topics and HA unique IDs use the same numbers (`crestron/output/101/...`, `crestron_dm_md8x8_o101`). Don't renumber them, or HA entities will be orphaned.
- **Full AV routes only**: routes are always set with `SETAVROUTE`, so audio and video move together. Never use `SETVIDEOROUTE` / `SETAUDIOROUTE`. The parser reads both video and audio. If a poll finds an output split, the proxy re-applies `SETAVROUTE <video input> <output>` once per split state. On this firmware, `SETAVROUTE 0 <output>` (break) clears audio but can leave video routed, at least when the display's hot plug is low. The enforcement then restores the full route, so "Off" may not stick.
- **Inputs (MQTT)**: labels from `INPUT_NAMES`; the select option index is the input number.
- **Outputs (Crestron internal)**: output cards in slots `33`–`40`. The parser only records slots `33`–`40` and ignores everything else.
- **Slot ↔ API translation**: `apiOutputId = slot − 33 + 101`, `arrayIndex = apiOutputId − 101`. The internal `avRouteMap` is `Array(8)`, index `0`–`7`.
- **Parser format**: matches `Routing Information for Output Card at Slot N` then the next `Video Routed From Input Card at slot M`. If the Crestron firmware ever changes that wording, parsing silently produces a map of zeros.

## Commands

```bash
# Dev
npm install
npm run dev          # nodemon
npm start

# Build & deploy on the docker host
docker compose -f crestronproxy-compose.yaml up -d --build
docker compose -f crestronproxy-compose.yaml ps          # expect "healthy"
docker compose -f crestronproxy-compose.yaml logs -f
docker compose -f crestronproxy-compose.yaml down
```

## Known issues / improvement opportunities

### Security & ops — accepted (out of scope)

Accepted under the network-isolation assumption (port `8022` is only reachable from the docker host's controlled network). Revisit only if exposure widens.

- No auth, no rate limiting on any endpoint.
- `POST /command` is arbitrary command execution over the SSH session.
- `POST /shutdown` is unauthenticated.
- MQTT `.../set` topics accept route changes from any client the broker lets publish there. Broker ACLs are the control.

## Conventions for changes in this repo

- `app.js` holds the Crestron service; `multiviewer.js` holds the second device. Resist the urge to split into `routes/`, `services/`, `parsers/` etc. unless adding real complexity — there isn't enough surface area to justify it.
- Pino is the logger. Don't reach for `console.log`.
- The route map is intentionally global state in `app.js`. Don't introduce a class wrapper for it without a reason.
- When changing the parser, the API, or the slot-mapping arithmetic, change all three together and re-check the invariants in this file.
