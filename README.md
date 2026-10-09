# crestron-ha-bridge

A small proxy in front of a Crestron **DM-MD8X8-CPU3** DigitalMedia matrix switcher. The Crestron is controlled via its SSH console; this service keeps a persistent SSH session, polls the current route map, and exposes it two ways:

- **MQTT** (optional): one Home Assistant `select` entity per output, set up via MQTT discovery. Route changes are pushed to HA as soon as they happen, and HA sends commands back over MQTT.
- **REST**: simple JSON endpoints for reading and changing routes without speaking Crestron console syntax.

Runs as a Docker container (`crestron-ha-bridge`) built with Docker Compose.

> **Security:** there is no authentication on any endpoint, and `POST /command` runs arbitrary console commands on the Crestron. Only run this on a network segment that untrusted clients can't reach, and restrict who can publish to the MQTT `.../set` topics with broker ACLs.

## What it does

1. Opens an SSH connection to the Crestron (`SSH_HOST:SSH_PORT`) using a private key bind-mounted into the container at runtime (`SSH_PRIVATE_KEY_PATH`).
2. Runs `DUMPDMROUTEINFO` on connect and every `POLL_INTERVAL_MS` (about 0.5s per run), parses the response, and maintains an in-memory route map.
3. Publishes changed outputs to MQTT, and only when something actually changed.
4. Runs route changes (`SETAVROUTE`) from MQTT or REST, updates the map straight away, then re-polls 1.5s later to confirm.
5. Exposes JSON endpoints to read the route map, change routes, send arbitrary console commands, and check status.
6. Reconnects automatically (up to `MAX_RETRIES` times) if the SSH session drops. MQTT reconnects on its own every 5s.

Audio and video are always routed together with `SETAVROUTE`. If a poll finds an output whose audio and video come from different inputs, the proxy re-applies the full AV route from the video input. It tries once per split state and logs an error if the split persists.

Console commands are serialised, so a poll and a route change never overlap, and each one times out after `COMMAND_TIMEOUT_MS`.

## MQTT / Home Assistant

Set `MQTT_URL` to enable it. The proxy then uses these topics:

| Topic | Direction | Payload |
|---|---|---|
| `homeassistant/select/crestron_o<101-108>/config` | proxy → HA, retained | HA discovery config, one per output |
| `crestron/output/<101-108>/state` | proxy → HA, retained | Current input label, e.g. `Apple TV` or `Off` |
| `crestron/output/<101-108>/set` | HA → proxy | Input label to route to that output |
| `crestron/availability` | proxy → HA, retained, LWT | `online` when MQTT and SSH are both up and routes are known, otherwise `offline` |

The entities are `select.crestron_o101` … `select.crestron_o108`, grouped under one "Crestron DM-MD8x8" device. Use `select.select_option` in scripts and automations. Labels come from `INPUT_NAMES` / `OUTPUT_NAMES`. Without them, the labels are `Input N` / `Output N`, and input 0 is `Off`. Never label an input `None`: HA's MQTT select reads that payload as "unknown".

Feedback timing: changes made from HA show up immediately. Changes made elsewhere (front panel, another controller) show up within one poll interval.

## Multiviewer

If `MV_HOST` is set, the proxy also controls an A-NeuVideo ANI-PiP-41UHD 4x1 multiviewer. It reaches the multiviewer's RS-232 port through a TCP-to-serial bridge, and the HA entities appear under a "Multiviewer" device:

| Entity | Options | Device command |
|---|---|---|
| `select.multiviewer_layout` | Single, PiP, Side by side, Triple | `s multiview x!` |
| `select.multiviewer_style` | Style 1, Style 2 (side by side and triple only) | `s PBP mode x!` / `s triple mode x!` |
| `select.multiviewer_window1_source` … `window3_source` | What the window shows: named Crestron inputs, excluding Off and `MV_CRESTRON_INPUT` | `SETAVROUTE` on the Crestron output feeding the window's HDMI input |
| `select.multiviewer_window1` … `window3` ("Window n input") | Which HDMI input the window shows, labelled by `MV_INPUT_NAMES` | `s window n in x!` (`s in source x!` in Single) |
| `select.multiviewer_pip_position` | Left top, Left bottom, Right top, Right bottom (PiP only) | `s PIP position x!` |
| `select.multiviewer_pip_size` | Small, Middle, Large (PiP only) | `s PIP size x!` |
| `select.multiviewer_audio` | Main window, each source, Muted | `s output audio x!` + `s output audio mute 0/1!` |

In PiP, window 1 is the large picture and window 2 is the inset. A window source command follows window → HDMI input (`MV_INPUT_NAMES`) → Crestron output (`MV_HDMI_OUTPUTS`), and routes the chosen input to that output with a full AV route. The window source states update when either the multiviewer's window assignment or the Crestron route changes. The proxy re-reads the device's state after every command (HA updates in under 1s) and every `MV_POLL_INTERVAL_MS`, so front-panel and IR changes show up too. A command that doesn't apply to the current layout, such as a PiP size while in side by side, is ignored and logged.

The bridge copies replies to every connected TCP client, so the proxy must be its only client. Close the vendor's Windows app before relying on HA. `GET /multiviewer` returns the current state.

## TV

If `TV_HOST` is set, the proxy also controls a ProofVision bathroom TV (non-WebOS range) through a TCP-to-serial bridge on its RS-232 port (115200 8N1; ProofVision's code sheet says 38400, which is wrong). The HA entities appear under a device named `TV_NAME`. Entity IDs below assume `TV_NAME=Bath TV`:

| Entity | Options | Key code |
|---|---|---|
| `switch.bath_tv_power` | On / off | `a8` / `a9` |
| `select.bath_tv_input` | HDMI 1, HDMI 2, AV, PC, Component, DTV, ATV, USB | `a1`, `ab`, `a0`, `a3`, `a6`, `a4`, `a5`, `aa` |
| `button.bath_tv_vol_up`, `vol_down`, `mute` | Press | `83`, `86`, `df` (mute toggles) |

Each command is the remote's NEC key code framed as `A0 F0 55 FF <key> <key ^ 0xFF>`. The TV can't be queried. It ACKs every frame within about 30ms, but the ACK depends only on the key, not on whether the TV is on. So power and input are **assumed state**: what the proxy last sent successfully. Changes from the TV's own remote aren't seen. The assumed state is restored from the retained MQTT topics after a restart.

Every `TV_POLL_INTERVAL_MS` the proxy sends key `00`, which the TV ACKs without doing anything. The TV entities are available only while that ACK keeps arriving, so a TV without power or a loose serial cable shows as unavailable. A command that isn't ACKed within 500ms is logged as failed, and HA is set back to the assumed state. Changing `TV_NAME` changes the entity IDs, which creates new entities. `GET /tv` returns the assumed state.

## API

Default listen port: `8022` (`PORT` env).

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET`  | `/status` | — | `{ connected: bool, mqtt: "connected" \| "disconnected" \| "disabled", multiviewer: same, tv: same }` |
| `GET`  | `/multiviewer` | — | Multiviewer state: layout, style, windows, PiP, audio |
| `GET`  | `/tv` | — | TV assumed state: `{ connected, answering, power, input }` |
| `POST` | `/tv/:key` | `{ value: string }` | TV command: `power` (`ON`/`OFF`), `input` (option label), or `vol_up` / `vol_down` / `mute` (no value). 500 if the TV doesn't ACK. |
| `GET`  | `/routes` | — | Full route map: `{ outputs: { o101: { input: "<n>" }, ... } }` |
| `GET`  | `/input/:id` | — | Outputs currently fed by input `:id` (0–8). 404 if none. |
| `GET`  | `/output/:id` | — | Input feeding output `:id` (101–108). |
| `POST` | `/setavroute` | `{ inputId: number, outputId: number }` | Sends `SETAVROUTE` to the Crestron and updates the local map. |
| `POST` | `/command` | `{ command: string }` | Runs an arbitrary command over the SSH session. Returns `{ stdout, stderr, code, signal }`. |
| `GET`  | `/last-output` | — | The most recent poll output: `{ stdout, stderr, timestamp }`. |
| `POST` | `/shutdown` | — | Closes SSH and exits the process. |

### ID conventions (DM-MD8x8)

- **Inputs** are numbered `1`–`8`. `0` means "no source routed".
- **Outputs** are addressed externally as `101`–`108`. Internally the Crestron reports them as output cards in slots `33`–`40`; the proxy translates `slot − 33 + 101` for the API and `outputId − 101` for the internal array index.
- The internal `avRouteMap` is an 8-element array indexed `0`–`7` (corresponding to outputs `101`–`108`); each value is the input number (`0`–`8`) currently routed to that output.

### Example

```bash
# Read full route map
curl http://crestron-ha-bridge:8022/routes

# Route input 3 to output 105
curl -X POST http://crestron-ha-bridge:8022/setavroute \
  -H "Content-Type: application/json" \
  -d '{"inputId": 3, "outputId": 105}'

# Which outputs are showing input 2?
curl http://crestron-ha-bridge:8022/input/2
```

## Configuration

All configuration is via environment variables. The variables in the first table are required; the process exits at startup if any are missing.

| Variable | Example | Purpose |
|---|---|---|
| `PORT` | `8022` | HTTP listen port |
| `SSH_HOST` | `192.168.1.50` | Crestron management IP |
| `SSH_PORT` | `22` | Crestron SSH port |
| `SSH_USERNAME` | `admin` | Crestron SSH user |
| `SSH_PRIVATE_KEY_PATH` | `id_rsa` | Path inside the container to the SSH private key |
| `POLL_COMMAND` | `DUMPDMROUTEINFO` | Console command run on poll |
| `POLL_INTERVAL_MS` | `5000` | Poll cadence in milliseconds |
| `MAX_RETRIES` | `5` | SSH reconnect attempt cap |

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `COMMAND_TIMEOUT_MS` | `10000` | Per-command SSH timeout |
| `MQTT_URL` | unset (MQTT off) | e.g. `mqtt://broker:1883` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | unset | Broker credentials. In production, keep them in `.env` on the docker host |
| `MQTT_BASE_TOPIC` | `crestron` | Topic prefix |
| `HA_DISCOVERY_PREFIX` | `homeassistant` | HA MQTT discovery prefix |
| `INPUT_NAMES` | — | JSON map, e.g. `{"0":"Off","1":"Apple TV"}`. Labels must be unique |
| `OUTPUT_NAMES` | — | JSON map, e.g. `{"101":"Multi 1"}` |
| `OFF_INPUT` | unset | An input with nothing connected, e.g. `7`. "Off" routes this input instead of breaking the route, and it's reported as `Off`. Needed on firmware where a break leaves video routed |
| `MV_HOST` | unset (multiviewer off) | TCP-to-serial bridge address, e.g. `192.168.1.60` |
| `MV_PORT` | `8234` | Bridge TCP port |
| `MV_POLL_INTERVAL_MS` | `5000` | Multiviewer state poll cadence |
| `MV_INPUT_NAMES` | `HDMI 1`…`HDMI 3` | JSON map, e.g. `{"1":"Multi 1","2":"Multi 2","3":"Spare HDMI"}` |
| `MV_HDMI_OUTPUTS` | `{"1":101,"2":102,"3":104}` | Crestron output feeding each multiviewer HDMI input |
| `MV_CRESTRON_INPUT` | `2` | Crestron input carrying the multiviewer's output; never offered as a window source |
| `TV_HOST` | unset (TV off) | TCP-to-serial bridge on the TV's RS-232 port, e.g. `192.168.1.61` |
| `TV_PORT` | `8899` | Bridge TCP port |
| `TV_POLL_INTERVAL_MS` | `30000` | Heartbeat cadence (key `00`), which drives the TV entities' availability |
| `TV_NAME` | `TV` | HA device name; also sets the entity IDs (`Bath TV` gives `switch.bath_tv_power`) |

### Provisioning the SSH key

`id_rsa` is **not** tracked by git and **not** baked into the Docker image. The operator places the key on the docker host alongside `crestron-ha-bridge-compose.yaml`; compose then bind-mounts it read-only at `/app/id_rsa`, which is where `SSH_PRIVATE_KEY_PATH=id_rsa` resolves inside the running container.

```bash
# On the docker host, alongside crestron-ha-bridge-compose.yaml
ls -l id_rsa            # expect 0600 perms, owned by the deploy user
chmod 0600 id_rsa
```

Use a key dedicated to the Crestron and don't reuse it elsewhere. Keep the Crestron and this container on an isolated network.

### `.env` on the docker host

All configuration, including the MQTT, multiviewer and TV settings, lives in a `.env` file on the docker host, next to `crestron-ha-bridge-compose.yaml`. Start from [.env.example](.env.example). Compose loads it via `env_file` (needs Compose v2.24+). Like `id_rsa`, it's gitignored and excluded from the image. Run `chmod 0600 .env`.

## Run

### Docker compose (production)

The compose file is `crestron-ha-bridge-compose.yaml`. It builds from the repo (build context is `.`, relative to the compose file) and publishes port `8022` on the docker host. Run on the docker host:

```bash
docker compose -f crestron-ha-bridge-compose.yaml up -d --build
docker compose -f crestron-ha-bridge-compose.yaml ps         # expect "healthy"
docker compose -f crestron-ha-bridge-compose.yaml logs -f
```

The container has a healthcheck that polls its own `/status` every 30 seconds.

### Local dev

```bash
npm install
# Set the env vars above (e.g. via a .env loaded by your shell), then:
npm run dev   # nodemon
# or
npm start
```

## Logs

Structured JSON logs via [pino](https://getpino.io). Log level is `info` in production (`NODE_ENV=production`) and `debug` otherwise. Pipe through `pino-pretty` locally for readability:

```bash
npm start | npx pino-pretty
```

## Licence

[MIT](LICENSE)
