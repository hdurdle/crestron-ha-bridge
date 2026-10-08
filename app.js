const { Client } = require("ssh2");
const mqtt = require("mqtt");
const { logger } = require("./logger.js");
const { createMultiviewer } = require("./multiviewer.js");
const express = require("express");
const { readFileSync } = require("fs");

const app = express();

// Config defaults

const PORT = process.env.PORT || 8022;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 5;
const POLL_COMMAND = process.env.POLL_COMMAND;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10);
const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = process.env.SSH_PORT;
const SSH_USERNAME = process.env.SSH_USERNAME;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS, 10) || 10000;
const CONFIRM_POLL_DELAY_MS = 1500;

// Optional: MQTT push to Home Assistant. Disabled when MQTT_URL is unset.
const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_BASE_TOPIC = process.env.MQTT_BASE_TOPIC || "crestron";
const HA_DISCOVERY_PREFIX = process.env.HA_DISCOVERY_PREFIX || "homeassistant";

// Optional: ANI-PiP-41UHD multiviewer via TCP-to-serial bridge. Needs MQTT.
const MV_HOST = process.env.MV_HOST;
const MV_PORT = parseInt(process.env.MV_PORT, 10) || 8234;
const MV_POLL_INTERVAL_MS = parseInt(process.env.MV_POLL_INTERVAL_MS, 10) || 5000;
// Crestron input carrying the multiviewer's own output (never a window source)
const MV_CRESTRON_INPUT = parseInt(process.env.MV_CRESTRON_INPUT, 10) || 2;

const vars = {
  PORT,
  MAX_RETRIES,
  POLL_COMMAND,
  POLL_INTERVAL_MS,
  SSH_HOST,
  SSH_PORT,
  SSH_USERNAME,
  SSH_PRIVATE_KEY_PATH,
};

for (const [key, value] of Object.entries(vars)) {
  if (!value) {
    logger.error(`FATAL: ${key} environment variable is not defined. Exiting.`);
    process.exit(1);
  }
}

function parseNames(key) {
  if (!process.env[key]) return {};
  try {
    return JSON.parse(process.env[key]);
  } catch (err) {
    logger.error(`FATAL: ${key} is not valid JSON. Exiting.`);
    process.exit(1);
  }
}

const INPUT_NAMES = parseNames("INPUT_NAMES");
const OUTPUT_NAMES = parseNames("OUTPUT_NAMES");

const inputLabel = (inputId) =>
  INPUT_NAMES[inputId] || (inputId === 0 ? "Off" : `Input ${inputId}`);
const outputLabel = (outputId) =>
  OUTPUT_NAMES[outputId] || `Output ${outputId}`;

// HA select options, index = input number 0-8
const inputOptions = Array.from({ length: 9 }, (_, i) => inputLabel(i));
const inputIdByLabel = new Map(inputOptions.map((label, i) => [label, i]));
if (inputIdByLabel.size !== inputOptions.length) {
  logger.error("FATAL: INPUT_NAMES labels must be unique. Exiting.");
  process.exit(1);
}

//

const sshConfig = {
  host: SSH_HOST,
  port: SSH_PORT,
  username: SSH_USERNAME,
  privateKey: readFileSync(SSH_PRIVATE_KEY_PATH),
};

const pollConfig = {
  command: POLL_COMMAND,
  interval: POLL_INTERVAL_MS,
};

//

app.use(express.json());

let avRouteMap = Array(8).fill(0);
let routesKnown = false; // false until the first successful parse

let latestOutput = {
  stdout: "",
  stderr: "",
  timestamp: null,
};

// ssh stuff

let ssh = null;
let isConnected = false;
let reconnecting = false;

function connectSSH() {
  return new Promise((resolve, reject) => {
    ssh = new Client();

    ssh
      .on("ready", async () => {
        logger.info("SSH connected");
        isConnected = true;

        // Run polling once when connected (e.g., on reconnect)
        try {
          await pollRoutes();
          logger.info("Initial poll on SSH connect completed");
        } catch (err) {
          logger.error(err, "Initial poll after SSH connect failed:");
        }

        publishAvailability();
        resolve();
      })
      .on("error", (err) => {
        logger.error(err, "SSH connection error:");
        isConnected = false;
        reject(err);
      })
      .on("end", () => {
        logger.warn("SSH connection ended");
        isConnected = false;
      })
      .on("close", () => {
        logger.warn("SSH connection closed");
        isConnected = false;
        publishAvailability();
        attemptReconnect();
      });

    ssh.connect(sshConfig);
  });
}

async function attemptReconnect() {
  if (reconnecting) return;
  reconnecting = true;

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));
  let retries = 0;

  try {
    while (!isConnected && retries < MAX_RETRIES) {
      try {
        logger.info(`Reconnecting... (${retries + 1})`);
        await delay(2000);
        await connectSSH();
        logger.info("Reconnected to SSH");
        return;
      } catch (err) {
        retries++;
        logger.error(`Reconnect attempt ${retries} failed`);
      }
    }

    if (!isConnected) {
      logger.error("Failed to reconnect after multiple attempts.");
    }
  } finally {
    // Clear the flag whether we succeeded or exhausted retries, so a future
    // `close` event after recovery can start a fresh reconnect loop.
    reconnecting = false;
  }
}

// Commands are serialised so a poll and a route change never overlap on the
// Crestron console.
let sshQueue = Promise.resolve();

function execCommand(command) {
  const run = sshQueue.then(() => runSshCommand(command));
  sshQueue = run.catch(() => {});
  return run;
}

function runSshCommand(command) {
  return new Promise((resolve, reject) => {
    if (!isConnected) {
      return reject(new Error("SSH not connected"));
    }

    let stream = null;
    const timer = setTimeout(() => {
      if (stream) stream.close();
      reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    ssh.exec(command, (err, execStream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }

      stream = execStream;
      let stdout = "";
      let stderr = "";

      stream
        .on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code, signal });
        })
        .on("data", (data) => {
          stdout += data.toString();
        })
        .stderr.on("data", (data) => {
          stderr += data.toString();
        });
    });
  });
}

async function pollRoutes() {
  const started = Date.now();
  const result = await execCommand(POLL_COMMAND);
  latestOutput = {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    timestamp: new Date().toISOString(),
  };
  logger.debug(`Poll took ${Date.now() - started}ms`);
  updateAvRouteMapFromText(latestOutput.stdout);
}

let pollInFlight = false;

function startPollingCommand() {
  const runPollCommand = async () => {
    if (!isConnected) {
      logger.warn("Polling skipped: SSH not connected");
      return;
    }
    if (pollInFlight) return; // previous poll still queued or running

    pollInFlight = true;
    try {
      await pollRoutes();
    } catch (err) {
      logger.error(err, "Error running poll command");
    } finally {
      pollInFlight = false;
    }
  };

  // Run immediately once on startup
  runPollCommand();

  // Continue polling on interval
  setInterval(runPollCommand, POLL_INTERVAL_MS);
}

// end ssh

// route map update
function updateAvRouteMapFromText(text) {
  const lines = text.split("\n").map((line) => line.trim());
  let currentOutputSlot = null;
  let matchedOutputSlots = 0;
  const nextMap = Array(8).fill(0);
  const audioMap = Array(8).fill(0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const outputMatch = line.match(
      /^Routing Information for Output Card at Slot (\d+)/
    );
    if (outputMatch) {
      const slot = parseInt(outputMatch[1], 10);
      if (slot >= 33 && slot <= 40) {
        currentOutputSlot = slot;
        matchedOutputSlots++;
      } else {
        currentOutputSlot = null;
      }
      continue;
    }

    const videoRouteMatch = line.match(
      /^Video Routed From Input Card at slot (\d+)/
    );
    if (currentOutputSlot && videoRouteMatch) {
      const inputSlot = parseInt(videoRouteMatch[1], 10);
      const outputIndex = currentOutputSlot - 33; // index 0–7
      const inputIndex = inputSlot;
      if (
        outputIndex >= 0 &&
        outputIndex < 8 &&
        inputIndex >= 0 &&
        inputIndex <= 8
      ) {
        nextMap[outputIndex] = inputIndex;
      }
    }

    const audioRouteMatch = line.match(
      /^Audio Routed From Input Card at slot (\d+)/
    );
    if (currentOutputSlot && audioRouteMatch) {
      const inputSlot = parseInt(audioRouteMatch[1], 10);
      const outputIndex = currentOutputSlot - 33;
      if (inputSlot >= 0 && inputSlot <= 8) {
        audioMap[outputIndex] = inputSlot;
      }
    }
  }

  if (matchedOutputSlots === 0) {
    // No output-card headers in slots 33-40 found at all. Most likely the
    // Crestron output format changed (firmware update?) or the poll command
    // returned something unexpected. Keep the previous map rather than
    // pushing a map of zeros to Home Assistant.
    logger.warn(
      { stdoutSnippet: text.slice(0, 200) },
      "Parser found no output-card slots in 33-40; route map left unchanged",
    );
    return;
  }

  applyRouteMap(nextMap);
  enforceFullAvRoutes(nextMap, audioMap);
}

// Every output must carry audio and video from the same input. If a poll
// finds them split (e.g. a break that cleared audio but left video), re-apply
// the full AV route from the video input. Only one attempt per split state,
// so a route the Crestron refuses can't cause a command loop.
const realignAttempts = Array(8).fill(null);

function enforceFullAvRoutes(videoMap, audioMap) {
  videoMap.forEach((video, index) => {
    const audio = audioMap[index];
    const outputId = 101 + index;

    if (audio === video) {
      realignAttempts[index] = null;
      return;
    }

    const split = `${video}/${audio}`;
    const attempt = realignAttempts[index];
    if (attempt && attempt.split === split) {
      if (!attempt.reported) {
        logger.error(
          `Output ${outputId} still split after re-applying AV route (video ${video}, audio ${audio})`,
        );
        attempt.reported = true;
      }
      return;
    }

    realignAttempts[index] = { split, reported: false };
    logger.warn(
      `Output ${outputId} split (video ${video}, audio ${audio}); re-applying SETAVROUTE ${video} ${outputId}`,
    );
    execCommand(`SETAVROUTE ${video} ${outputId}`)
      .then(scheduleConfirmPoll)
      .catch((err) => logger.error(err, `Re-applying AV route on ${outputId} failed`));
  });
}

// Swap in a new route map and push any changed outputs over MQTT.
function applyRouteMap(nextMap) {
  const prevMap = avRouteMap;
  const firstMap = !routesKnown;
  avRouteMap = nextMap;
  routesKnown = true;

  const changed = nextMap.some((input, i) => input !== prevMap[i]);
  if (changed || firstMap) {
    logger.info(`Updated avRouteMap: ${avRouteMap}`);
  } else {
    logger.debug(`avRouteMap unchanged: ${avRouteMap}`);
  }

  nextMap.forEach((input, i) => {
    if (firstMap || input !== prevMap[i]) publishOutputState(i);
  });
  if (firstMap) publishAvailability();
  if (multiviewer && (changed || firstMap)) multiviewer.onRoutesChanged();
}

//
// route changes (shared by HTTP and MQTT)

const isValidRoute = (inputId, outputId) =>
  Number.isInteger(inputId) &&
  inputId >= 0 &&
  inputId <= 8 &&
  Number.isInteger(outputId) &&
  outputId >= 101 &&
  outputId <= 108;

let confirmPollTimer = null;

// Re-read the real state shortly after a route change so a rejected route is
// corrected. Debounced so a burst of changes triggers one poll.
function scheduleConfirmPoll() {
  clearTimeout(confirmPollTimer);
  confirmPollTimer = setTimeout(() => {
    pollRoutes().catch((err) => logger.error(err, "Confirmation poll failed"));
  }, CONFIRM_POLL_DELAY_MS);
}

// Always SETAVROUTE: audio and video are never routed separately.
async function setRoute(inputId, outputId) {
  const command = `SETAVROUTE ${inputId} ${outputId}`;
  logger.info(command);

  if (!isConnected) await connectSSH();
  await execCommand(command);

  const nextMap = [...avRouteMap];
  nextMap[outputId - 101] = inputId;
  applyRouteMap(nextMap);
  scheduleConfirmPoll();
}

//
// MQTT / Home Assistant

let mqttClient = null;

const topic = (...parts) => [MQTT_BASE_TOPIC, ...parts].join("/");
const availabilityTopic = topic("availability");

function mqttPublish(topicName, payload) {
  if (!mqttClient || !mqttClient.connected) return;
  mqttClient.publish(topicName, payload, { qos: 1, retain: true }, (err) => {
    if (err) logger.error(err, `MQTT publish to ${topicName} failed`);
  });
}

function publishAvailability() {
  mqttPublish(
    availabilityTopic,
    isConnected && routesKnown ? "online" : "offline",
  );
}

function publishOutputState(index) {
  if (!routesKnown) return;
  mqttPublish(
    topic("output", 101 + index, "state"),
    inputLabel(avRouteMap[index]),
  );
}

// One HA `select` entity per output; the options are the input names.
function publishDiscovery() {
  for (let index = 0; index < 8; index++) {
    const outputId = 101 + index;
    const config = {
      name: outputLabel(outputId),
      unique_id: `crestron_dm_md8x8_o${outputId}`,
      default_entity_id: `select.crestron_o${outputId}`,
      icon: "mdi:video-input-hdmi",
      state_topic: topic("output", outputId, "state"),
      command_topic: topic("output", outputId, "set"),
      availability_topic: availabilityTopic,
      options: inputOptions,
      qos: 1,
      device: {
        identifiers: ["crestron_dm_md8x8"],
        name: "Crestron DM-MD8x8",
        manufacturer: "Crestron",
        model: "DM-MD8X8-CPU3",
      },
      origin: { name: "crestronproxy" },
    };
    mqttPublish(
      `${HA_DISCOVERY_PREFIX}/select/crestron_o${outputId}/config`,
      JSON.stringify(config),
    );
  }
}

// Window sources: named Crestron inputs, minus "Off" (a break doesn't stick on
// this firmware) and the multiviewer's own output looping back in.
const mvSources = Object.keys(INPUT_NAMES)
  .map(Number)
  .filter((id) => id > 0 && id <= 8 && id !== MV_CRESTRON_INPUT)
  .sort((a, b) => a - b)
  .map((id) => ({ id, label: inputLabel(id) }));

const multiviewer = MV_HOST
  ? createMultiviewer({
      host: MV_HOST,
      port: MV_PORT,
      pollMs: MV_POLL_INTERVAL_MS,
      inputNames: parseNames("MV_INPUT_NAMES"),
      publish: mqttPublish,
      topic,
      discoveryPrefix: HA_DISCOVERY_PREFIX,
      proxyAvailabilityTopic: availabilityTopic,
      hdmiOutputs: process.env.MV_HDMI_OUTPUTS
        ? parseNames("MV_HDMI_OUTPUTS")
        : { 1: 101, 2: 102, 3: 104 },
      crestron: {
        sources: mvSources,
        getInput: (outputId) => (routesKnown ? avRouteMap[outputId - 101] : null),
        setRoute,
      },
    })
  : null;

async function handleMqttCommand(topicName, payload) {
  const mvMatch = topicName.match(/\/multiviewer\/(\w+)\/set$/);
  if (mvMatch && multiviewer) {
    return multiviewer.handleCommand(mvMatch[1], payload);
  }

  const match = topicName.match(/\/output\/(\d+)\/set$/);
  if (!match) return;

  const outputId = parseInt(match[1], 10);
  const label = payload.toString();
  const inputId = inputIdByLabel.get(label);

  logger.info(`MQTT ${topicName}: ${label}`);

  if (!isValidRoute(inputId, outputId)) {
    logger.warn(`Ignoring MQTT command: output ${outputId}, option "${label}"`);
    return;
  }

  try {
    await setRoute(inputId, outputId);
  } catch (err) {
    logger.error(err, "MQTT route change failed");
    publishOutputState(outputId - 101); // revert HA to the known state
  }
}

function startMqtt() {
  if (!MQTT_URL) {
    logger.info("MQTT_URL not set; MQTT push disabled");
    return;
  }

  mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    reconnectPeriod: 5000,
    will: { topic: availabilityTopic, payload: "offline", qos: 1, retain: true },
  });

  mqttClient
    .on("connect", () => {
      logger.info(`MQTT connected to ${MQTT_URL}`);
      publishDiscovery();
      avRouteMap.forEach((_, index) => publishOutputState(index));
      publishAvailability();
      const subscriptions = [topic("output", "+", "set")];
      if (multiviewer) {
        multiviewer.onMqttConnect();
        subscriptions.push(multiviewer.commandTopic);
      }
      mqttClient.subscribe(subscriptions, { qos: 1 }, (err) => {
        if (err) logger.error(err, "MQTT subscribe failed");
      });
    })
    .on("message", handleMqttCommand)
    .on("offline", () => logger.warn("MQTT offline"))
    .on("error", (err) => logger.error(err, "MQTT error"));
}

//
//
// API routes

// find outputs mapped to a given input id
app.get("/input/:id", (req, res) => {
  const inputId = parseInt(req.params.id, 10);

  logger.info(`/input/${inputId}`);

  if (isNaN(inputId) || inputId < 0 || inputId > 8) {
    return res
      .status(400)
      .json({ error: "Input ID must be an integer from 0 to 8" });
  }

  const routedOutputs = avRouteMap
    .map((input, index) => ({ input, output: index + 101 }))
    .filter((route) => route.input === inputId)
    .map((route) => route.output);

  if (routedOutputs.length === 0) {
    return res
      .status(404)
      .json({ error: `No outputs mapped to input ${inputId}` });
  }

  res.json({ input: inputId, outputs: routedOutputs });
});

// find input mapped to a given output
app.get("/output/:id", (req, res) => {
  const outputId = parseInt(req.params.id, 10);

  logger.info(`/output/${outputId}`);

  if (isNaN(outputId) || outputId < 101 || outputId > 108) {
    return res
      .status(400)
      .json({ error: "Output ID must be an integer from 101 to 108" });
  }

  const index = outputId - 101;
  const mappedInput = avRouteMap[index];

  if (mappedInput === 0) {
    return res
      .status(404)
      .json({ error: `No input mapped to output ${outputId}` });
  }

  res.json({ output: outputId, input: mappedInput });
});

// report the route map
app.get("/routes", (req, res) => {
  logger.info("/routes");

  const outputs = {};

  avRouteMap.forEach((value, index) => {
    const outputKey = "o" + (101 + index).toString();
    outputs[outputKey] = { input: value.toString() };
  });

  const result = {
    outputs: outputs,
  };

  res.json(result);
});

// set an avroute from inputId to the outputId
// curl -X POST http://localhost:8022/setavroute \
//   -H "Content-Type: application/json" \
//   -d '{"inputId": 3, "outputId": 105}'
app.post("/setavroute", async (req, res) => {
  const { inputId, outputId } = req.body;

  logger.info("/setavroute");

  if (!isValidRoute(inputId, outputId)) {
    return res.status(400).json({
      error: "inputId must be an integer 0–8 and outputId an integer 101–108",
    });
  }

  try {
    await setRoute(inputId, outputId);
    res.json({ output: outputId, input: inputId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// get the output of the last command
app.get("/last-output", (req, res) => {
  logger.info("/last-output");
  res.json(latestOutput);
});

// is the ssh server connected?
app.get("/status", (req, res) => {
  logger.info("/status");
  let mqttState = "disabled";
  if (mqttClient) mqttState = mqttClient.connected ? "connected" : "disconnected";
  let mvState = "disabled";
  if (multiviewer) mvState = multiviewer.isConnected() ? "connected" : "disconnected";
  res.json({ connected: isConnected, mqtt: mqttState, multiviewer: mvState });
});

// current multiviewer state (layout, windows, audio)
app.get("/multiviewer", (req, res) => {
  logger.info("/multiviewer");
  if (!multiviewer) return res.status(404).json({ error: "Multiviewer not configured" });
  res.json(multiviewer.getState());
});

// send an arbitrary command
app.post("/command", async (req, res) => {
  const { command } = req.body;
  logger.info(`/command/${command}`);
  if (!command) return res.status(400).json({ error: "Command is required" });

  try {
    if (!isConnected) await connectSSH();
    const result = await execCommand(command);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// disconnect and shutdown
app.post("/shutdown", async (req, res) => {
  try {
    if (mqttClient) {
      mqttClient.publish(availabilityTopic, "offline", { qos: 1, retain: true });
      mqttClient.end();
    }

    if (isConnected && ssh) {
      ssh.end();
      isConnected = false;
      logger.info("SSH connection closed");
    }

    res.json({ message: "Server is shutting down" });

    // Give time to send response before shutting down
    setTimeout(() => {
      logger.info("Exiting process...");
      process.exit(0);
    }, 1000);
  } catch (err) {
    res.status(500).json({ error: "Failed to shutdown: " + err.message });
  }
});

//
//
// Start server
app.listen(PORT, async () => {
  logger.info(`API server running at http://localhost:${PORT}`);
  logger.info({ ...sshConfig, privateKey: "<redacted>" });
  logger.info(pollConfig);
  logger.info("---");

  startMqtt();
  if (multiviewer) multiviewer.start();

  try {
    await connectSSH();
    startPollingCommand(); // Start command polling
  } catch (err) {
    logger.error(err, "Initial SSH connection failed:");
  }
});
