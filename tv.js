// ProofVision bathroom TV (non-WebOS "Professional" range), controlled over
// RS-232 through a USR-W610 TCP-to-serial bridge (115200 8N1; the vendor code
// sheet's 38400 is wrong). Each frame is the remote's NEC key code:
// A0 F0 55 FF <key> <key ^ 0xFF>.
//
// The protocol has no queries. The TV ACKs every frame within ~30ms with a few
// bytes that depend only on the key group (e.g. 00 00 00 c0 for power on), the
// same whether it's on or in standby. So power and input are assumed state,
// and the ACK only proves the serial path to the TV is alive. Key 0x00 has no
// function but is still ACKed, which makes it a side-effect-free heartbeat.

const net = require("net");
const { logger } = require("./logger.js");

const ACK_IDLE_MS = 50;
const ACK_TIMEOUT_MS = 500;
const RECONNECT_MS = 5000;
const HEARTBEAT_KEY = 0x00;

const POWER = { ON: 0xa8, OFF: 0xa9 };
const INPUTS = {
  "HDMI 1": 0xa1,
  "HDMI 2": 0xab,
  AV: 0xa0,
  PC: 0xa3,
  Component: 0xa6,
  DTV: 0xa4,
  ATV: 0xa5,
  USB: 0xaa,
};
const BUTTONS = { vol_up: 0x83, vol_down: 0x86, mute: 0xdf };

const frame = (key) => Buffer.from([0xa0, 0xf0, 0x55, 0xff, key, key ^ 0xff]);

function createTv({
  host,
  port,
  pollMs,
  name,
  publish,
  topic,
  discoveryPrefix,
  proxyAvailabilityTopic,
}) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const availabilityTopic = topic("tv", "availability");
  const state = {}; // assumed: power ("ON"/"OFF"), input (label)
  const published = {};

  let socket = null;
  let connected = false;
  let acked = false; // did the TV answer the most recent frame?
  let queue = Promise.resolve();
  let onData = null;

  //
  // transport

  function connect() {
    socket = net.connect({ host, port });
    socket.setKeepAlive(true, 30000);
    socket
      .on("connect", () => {
        logger.info(`TV bridge connected at ${host}:${port}`);
        connected = true;
        heartbeat();
      })
      .on("data", (data) => onData && onData(data))
      .on("error", (err) => logger.error(err, "TV socket error"))
      .on("close", () => {
        if (connected) logger.warn("TV connection closed");
        connected = false;
        acked = false;
        publishAvailability();
        setTimeout(connect, RECONNECT_MS);
      });
  }

  // Send one key and wait for the TV's ACK. Serialised: ACKs carry no id.
  function send(key) {
    const run = queue.then(
      () =>
        new Promise((resolve, reject) => {
          if (!connected) return reject(new Error("TV bridge not connected"));

          let reply = Buffer.alloc(0);
          let idleTimer = null;
          const finish = (err) => {
            clearTimeout(idleTimer);
            clearTimeout(timeout);
            onData = null;
            acked = !err;
            publishAvailability();
            if (err) return reject(err);
            logger.debug(`TV < ${reply.toString("hex")}`);
            resolve();
          };
          const hex = key.toString(16).padStart(2, "0");
          const timeout = setTimeout(
            () => finish(new Error(`TV did not ACK key 0x${hex}`)),
            ACK_TIMEOUT_MS,
          );
          onData = (data) => {
            reply = Buffer.concat([reply, data]);
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => finish(), ACK_IDLE_MS);
          };
          logger.debug(`TV > 0x${hex}`);
          socket.write(frame(key));
        }),
    );
    queue = run.catch(() => {});
    return run;
  }

  async function heartbeat() {
    const wasAcked = acked;
    try {
      await send(HEARTBEAT_KEY);
      if (!wasAcked) logger.info("TV is answering");
    } catch (err) {
      if (wasAcked) logger.warn(err, "TV stopped answering");
    }
  }

  //
  // MQTT

  const device = {
    identifiers: [`proofvision_tv_${slug}`],
    name,
    manufacturer: "ProofVision",
    model: "Bathroom TV (RS-232)",
  };

  const entities = [
    { component: "switch", key: "power", name: "Power", icon: "mdi:television" },
    {
      component: "select",
      key: "input",
      name: "Input",
      icon: "mdi:video-input-hdmi",
      options: Object.keys(INPUTS),
    },
    { component: "button", key: "vol_up", name: "Volume up", icon: "mdi:volume-plus" },
    { component: "button", key: "vol_down", name: "Volume down", icon: "mdi:volume-minus" },
    { component: "button", key: "mute", name: "Mute", icon: "mdi:volume-mute" },
  ];
  const stateKeys = ["power", "input"];

  let publishedAvailability = null;

  function publishAvailability(force = false) {
    const value = connected && acked ? "online" : "offline";
    if (!force && value === publishedAvailability) return;
    publishedAvailability = value;
    publish(availabilityTopic, value);
  }

  // Publish only values that changed (`force` on MQTT reconnect or to revert HA)
  function publishState(force = false) {
    for (const key of stateKeys) {
      const value = state[key];
      if (value === undefined) continue;
      if (!force && published[key] === value) continue;
      published[key] = value;
      publish(topic("tv", key, "state"), value);
    }
  }

  function publishDiscovery() {
    for (const { component, key, name: entityName, icon, options } of entities) {
      const config = {
        name: entityName,
        unique_id: `proofvision_tv_${slug}_${key}`,
        default_entity_id: `${component}.${slug}_${key}`,
        icon,
        command_topic: topic("tv", key, "set"),
        availability: [{ topic: proxyAvailabilityTopic }, { topic: availabilityTopic }],
        availability_mode: "all",
        qos: 1,
        device,
        origin: { name: "crestron-ha-bridge" },
      };
      if (component !== "button") config.state_topic = topic("tv", key, "state");
      if (options) config.options = options;
      publish(`${discoveryPrefix}/${component}/${slug}_${key}/config`, JSON.stringify(config));
    }
  }

  function onMqttConnect() {
    publishDiscovery();
    publishState(true);
    publishAvailability(true);
  }

  // Our own retained state, read back once after a restart. Live state wins.
  function seedState(key, payload) {
    if (!stateKeys.includes(key) || state[key] !== undefined) return;
    const value = payload.toString();
    if (key === "power" && !(value in POWER)) return;
    if (key === "input" && !(value in INPUTS)) return;
    state[key] = value;
    published[key] = value;
    logger.info(`TV ${key} restored as "${value}"`);
  }

  //
  // commands

  // Apply one HA/REST command. Throws on an unknown key/value or a missing ACK.
  async function perform(key, value) {
    if (key === "power" && value in POWER) {
      await send(POWER[value]);
      state.power = value;
    } else if (key === "input" && value in INPUTS) {
      await send(INPUTS[value]);
      state.input = value;
    } else if (key in BUTTONS) {
      await send(BUTTONS[key]);
    } else {
      throw new Error(`Unknown TV command ${key}="${value}"`);
    }
    logger.info(`TV ${key}${key in BUTTONS ? "" : ` ${value}`}`);
    publishState();
  }

  async function handleCommand(key, payload) {
    const value = payload.toString();
    logger.info(`MQTT tv/${key}: ${value}`);
    try {
      await perform(key, value);
    } catch (err) {
      logger.error(err, "TV command failed");
      publishState(true); // put HA back to the assumed state
    }
  }

  function start() {
    connect();
    setInterval(() => connected && heartbeat(), pollMs);
  }

  return {
    start,
    onMqttConnect,
    handleCommand,
    seedState,
    perform,
    commandTopic: topic("tv", "+", "set"),
    stateTopic: topic("tv", "+", "state"),
    isConnected: () => connected,
    getState: () => ({ connected, answering: acked, ...state }),
  };
}

module.exports = { createTv };
