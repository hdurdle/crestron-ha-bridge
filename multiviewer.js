// A-NeuVideo ANI-PiP-41UHD 4x1 multiviewer, controlled with its RS-232 ASCII
// protocol through a TCP-to-serial bridge (USR-TCP232-306). Commands end with
// "!", replies are CRLF-terminated lines that arrive within ~50ms.
//
// Exposed to Home Assistant as MQTT `select` entities sharing the proxy's MQTT
// client. "Window n source" entities pick what a window shows by routing the
// Crestron output that feeds the window's HDMI input. State is re-read after every command and on a poll, so changes made
// from the front panel or IR remote show up too.

const net = require("net");
const { logger } = require("./logger.js");

// Every command (set or read) gets a reply within ~60ms; it's complete once
// the line has gone quiet. The bridge copies replies to every connected TCP
// client, so this proxy must be the only client on the bridge.
const REPLY_IDLE_MS = 60;
const REPLY_TIMEOUT_MS = 2000;
const RECONNECT_MS = 5000;

// `s multiview x!` values. Quad (5) is not offered: only 3 sources are wired.
const LAYOUTS = { Single: 1, PiP: 2, "Side by side": 3, Triple: 4 };
const STYLES = ["Style 1", "Style 2"]; // PBP / triple mode 1-2
const PIP_POSITIONS = ["Left top", "Left bottom", "Right top", "Right bottom"];
const PIP_SIZES = ["Small", "Middle", "Large"];
const AUDIO_FOLLOW = "Main window";
const AUDIO_MUTED = "Muted";
const WINDOWS = 3;

function parseLayout(text) {
  if (/single/i.test(text)) return "Single";
  if (/PIP/i.test(text)) return "PiP";
  if (/PBP/i.test(text)) return "Side by side";
  if (/triple/i.test(text)) return "Triple";
  return null; // quad, or something unexpected
}

function createMultiviewer({
  host,
  port,
  pollMs,
  inputNames,
  publish,
  topic,
  discoveryPrefix,
  proxyAvailabilityTopic,
  hdmiOutputs, // { hdmi: crestronOutputId } - which Crestron output feeds each HDMI input
  crestron, // { sources: [{ id, label }], getInput(outputId), setRoute(inputId, outputId) }
}) {
  // Window/audio options: one label per wired HDMI input (1-4)
  const sources = [1, 2, 3, 4]
    .filter((n) => inputNames[n] || n <= 3)
    .map((n) => ({ hdmi: n, label: inputNames[n] || `HDMI ${n}` }));
  const sourceLabel = (hdmi) =>
    (sources.find((s) => s.hdmi === hdmi) || {}).label || `HDMI ${hdmi}`;
  const hdmiByLabel = new Map(sources.map((s) => [s.label, s.hdmi]));

  const availabilityTopic = topic("multiviewer", "availability");
  const state = {};
  const published = {};
  const windowHdmi = {}; // window number -> HDMI input currently shown

  // "Window source" = the Crestron input routed to the output that feeds the
  // HDMI input a window shows: window -> HDMI -> Crestron output -> input.
  const crestronSourceLabel = (inputId) =>
    (crestron.sources.find((s) => s.id === inputId) || {}).label || null;
  const crestronSourceId = new Map(crestron.sources.map((s) => [s.label, s.id]));

  function updateWindowSources() {
    for (let n = 1; n <= WINDOWS; n++) {
      const output = hdmiOutputs[windowHdmi[n]];
      const inputId = output ? crestron.getInput(output) : null;
      state[`window${n}_source`] = inputId == null ? null : crestronSourceLabel(inputId);
    }
  }

  let socket = null;
  let connected = false;
  let queue = Promise.resolve();
  let onData = null;

  //
  // transport

  function connect() {
    socket = net.connect({ host, port });
    socket.setKeepAlive(true, 30000);
    socket
      .on("connect", () => {
        logger.info(`Multiviewer connected at ${host}:${port}`);
        connected = true;
        refresh().catch((err) => logger.error(err, "Multiviewer refresh failed"));
      })
      .on("data", (data) => onData && onData(data.toString("latin1")))
      .on("error", (err) => logger.error(err, "Multiviewer socket error"))
      .on("close", () => {
        if (connected) logger.warn("Multiviewer connection closed");
        connected = false;
        publishAvailability();
        setTimeout(connect, RECONNECT_MS);
      });
  }

  // Send one command and collect its reply. Serialised: the device can only
  // answer one command at a time and replies carry no request id.
  function send(command) {
    const run = queue.then(
      () =>
        new Promise((resolve, reject) => {
          if (!connected) return reject(new Error("Multiviewer not connected"));

          let reply = "";
          let idleTimer = null;
          const finish = (err) => {
            clearTimeout(idleTimer);
            clearTimeout(timeout);
            onData = null;
            if (err) return reject(err);
            if (/please check/i.test(reply)) {
              return reject(new Error(`Multiviewer rejected "${command}"`));
            }
            resolve(reply.trim());
          };
          const timeout = setTimeout(
            () => finish(new Error(`Multiviewer timeout on "${command}"`)),
            REPLY_TIMEOUT_MS,
          );
          onData = (text) => {
            reply += text;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => finish(), REPLY_IDLE_MS);
          };
          logger.debug(`Multiviewer > ${command}`);
          socket.write(command);
        }),
    );
    queue = run.catch(() => {});
    return run;
  }

  //
  // state

  async function refresh() {
    const next = {};
    next.layout = parseLayout(await send("r multiview!"));

    if (next.layout === "Single") {
      const m = (await send("r in source!")).match(/HDMI (\d)/);
      next.window1 = m ? sourceLabel(Number(m[1])) : null;
      windowHdmi[1] = m ? Number(m[1]) : null;
    } else {
      const reply = await send("r window 0 in!");
      for (const m of reply.matchAll(/window (\d) select HDMI (\d)/g)) {
        next[`window${m[1]}`] = sourceLabel(Number(m[2]));
        windowHdmi[m[1]] = Number(m[2]);
      }
    }

    if (next.layout === "PiP") {
      const pos = await send("r PIP position!");
      next.pip_position =
        PIP_POSITIONS.find((p) => pos.toLowerCase().includes(p.toLowerCase())) || null;
      const size = await send("r PIP size!");
      next.pip_size =
        PIP_SIZES.find((s) => size.toLowerCase().includes(s.toLowerCase())) || null;
    }
    if (next.layout === "Side by side" || next.layout === "Triple") {
      const cmd = next.layout === "Triple" ? "r triple mode!" : "r PBP mode!";
      const m = (await send(cmd)).match(/mode (\d)/);
      next.style = m ? STYLES[Number(m[1]) - 1] : null;
    }

    const muted = /mute: on/i.test(await send("r output audio mute!"));
    const audio = (await send("r output audio!")).match(/HDMI (\d)/);
    next.audio = muted
      ? AUDIO_MUTED
      : audio
        ? sourceLabel(Number(audio[1]))
        : AUDIO_FOLLOW;

    // Keep last known values for settings the current layout doesn't report
    Object.assign(state, next);
    updateWindowSources();
    publishState();
    publishAvailability();
  }

  // Called by the proxy whenever the Crestron route map changes
  function onRoutesChanged() {
    updateWindowSources();
    publishState();
  }

  //
  // MQTT

  const entities = [
    { key: "layout", name: "Layout", icon: "mdi:view-dashboard", options: Object.keys(LAYOUTS) },
    { key: "style", name: "Layout style", icon: "mdi:view-split-vertical", options: STYLES },
    ...Array.from({ length: WINDOWS }, (_, i) => ({
      key: `window${i + 1}`,
      name: `Window ${i + 1} input`,
      icon: "mdi:hdmi-port",
      options: sources.map((s) => s.label),
    })),
    ...Array.from({ length: WINDOWS }, (_, i) => ({
      key: `window${i + 1}_source`,
      name: `Window ${i + 1} source`,
      icon: "mdi:television-play",
      options: crestron.sources.map((s) => s.label),
    })),
    { key: "pip_position", name: "PiP position", icon: "mdi:picture-in-picture-top-right", options: PIP_POSITIONS },
    { key: "pip_size", name: "PiP size", icon: "mdi:resize", options: PIP_SIZES },
    {
      key: "audio",
      name: "Audio",
      icon: "mdi:volume-high",
      options: [AUDIO_FOLLOW, ...sources.map((s) => s.label), AUDIO_MUTED],
    },
  ];

  let publishedAvailability = null;

  function publishAvailability(force = false) {
    const value = connected && state.layout !== undefined ? "online" : "offline";
    if (!force && value === publishedAvailability) return;
    publishedAvailability = value;
    publish(availabilityTopic, value);
  }

  // Publish only values that changed (`force` on MQTT reconnect)
  function publishState(force = false) {
    for (const { key } of entities) {
      const value = state[key];
      if (value === undefined) continue;
      if (!force && published[key] === value) continue;
      published[key] = value;
      // HA's MQTT select treats "None" as unknown, used when not applicable
      publish(topic("multiviewer", key, "state"), value === null ? "None" : value);
    }
  }

  function publishDiscovery() {
    for (const { key, name, icon, options } of entities) {
      const config = {
        name,
        unique_id: `ani_pip_41uhd_${key}`,
        default_entity_id: `select.multiviewer_${key}`,
        icon,
        state_topic: topic("multiviewer", key, "state"),
        command_topic: topic("multiviewer", key, "set"),
        availability: [
          { topic: proxyAvailabilityTopic },
          { topic: availabilityTopic },
        ],
        availability_mode: "all",
        options,
        qos: 1,
        device: {
          identifiers: ["ani_pip_41uhd"],
          name: "Multiviewer",
          manufacturer: "A-NeuVideo",
          model: "ANI-PiP-41UHD",
        },
        origin: { name: "crestronproxy" },
      };
      publish(`${discoveryPrefix}/select/multiviewer_${key}/config`, JSON.stringify(config));
    }
  }

  function onMqttConnect() {
    publishDiscovery();
    publishState(true);
    publishAvailability(true);
  }

  // Map an HA option to device commands for the current layout
  function commandsFor(key, value) {
    if (key === "layout" && LAYOUTS[value]) return [`s multiview ${LAYOUTS[value]}!`];

    if (key === "style" && STYLES.includes(value)) {
      const mode = STYLES.indexOf(value) + 1;
      if (state.layout === "Side by side") return [`s PBP mode ${mode}!`];
      if (state.layout === "Triple") return [`s triple mode ${mode}!`];
      return null;
    }

    const win = key.match(/^window(\d)$/);
    if (win && hdmiByLabel.has(value)) {
      const hdmi = hdmiByLabel.get(value);
      if (state.layout === "Single") {
        return win[1] === "1" ? [`s in source ${hdmi}!`] : null;
      }
      return [`s window ${win[1]} in ${hdmi}!`];
    }

    if (key === "pip_position" && PIP_POSITIONS.includes(value)) {
      return state.layout === "PiP" ? [`s PIP position ${PIP_POSITIONS.indexOf(value) + 1}!`] : null;
    }
    if (key === "pip_size" && PIP_SIZES.includes(value)) {
      return state.layout === "PiP" ? [`s PIP size ${PIP_SIZES.indexOf(value) + 1}!`] : null;
    }

    if (key === "audio") {
      if (value === AUDIO_MUTED) return ["s output audio mute 1!"];
      if (value === AUDIO_FOLLOW) return ["s output audio 0!", "s output audio mute 0!"];
      if (hdmiByLabel.has(value)) {
        return [`s output audio ${hdmiByLabel.get(value)}!`, "s output audio mute 0!"];
      }
    }
    return null;
  }

  // A window source is changed on the Crestron, not the multiviewer: route
  // the chosen input to the output feeding the window's current HDMI input.
  async function setWindowSource(window, value) {
    const output = hdmiOutputs[windowHdmi[window]];
    const inputId = crestronSourceId.get(value);
    if (!output || inputId === undefined) {
      logger.warn(`Ignoring window ${window} source "${value}" (HDMI ${windowHdmi[window]})`);
      publishState(true);
      return;
    }
    try {
      await crestron.setRoute(inputId, output);
    } catch (err) {
      logger.error(err, `Window ${window} source change failed`);
      publishState(true);
    }
  }

  async function handleCommand(key, payload) {
    const value = payload.toString();
    logger.info(`MQTT multiviewer/${key}: ${value}`);

    const sourceKey = key.match(/^window(\d)_source$/);
    if (sourceKey) return setWindowSource(Number(sourceKey[1]), value);

    const commands = commandsFor(key, value);

    if (!commands) {
      logger.warn(`Ignoring multiviewer ${key}="${value}" in layout ${state.layout}`);
      publishState(true); // put HA back to the real state
      return;
    }

    try {
      for (const command of commands) {
        logger.info(`Multiviewer ${command}`);
        await send(command);
      }
    } catch (err) {
      logger.error(err, "Multiviewer command failed");
    }
    await refresh().catch((err) => logger.error(err, "Multiviewer refresh failed"));
  }

  function start() {
    connect();
    let polling = false;
    setInterval(async () => {
      if (!connected || polling) return;
      polling = true;
      await refresh().catch((err) => logger.error(err, "Multiviewer poll failed"));
      polling = false;
    }, pollMs);
  }

  return {
    start,
    onMqttConnect,
    onRoutesChanged,
    handleCommand,
    commandTopic: topic("multiviewer", "+", "set"),
    isConnected: () => connected,
    getState: () => ({ connected, ...state, windowHdmi }),
  };
}

module.exports = { createMultiviewer };
