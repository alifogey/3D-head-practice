// let the editor know that `Chart` is defined by some code
// included in another file (in this case, `index.html`)
// Note: the code will still work without this line, but without it you
// will see an error in the editor
/* global THREE */
/* global TransformStream */
/* global TextEncoderStream */
/* global TextDecoderStream */
'use strict';

import * as THREE from 'three';
import {OBJLoader} from 'objloader';

let port;
let reader;
let inputDone;
let outputDone;
let inputStream;
let outputStream;
let showCalibration = false;

let orientation = [0, 0, 0];
let quaternion = [1, 0, 0, 0];
let calibration = [0, 0, 0, 0];

// ===============================
// CSV RECORDING VARIABLES
// ===============================
let recordedData = [];
let latestOrientation = [0, 0, 0];
let latestQuaternion = [1, 0, 0, 0];
let latestCalibration = [0, 0, 0, 0];
let recordingEnabled = true;

const maxLogLength = 100;
const baudRates = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000, 1000000, 2000000];
const log = document.getElementById('log');
const butConnect = document.getElementById('butConnect');
const butClear = document.getElementById('butClear');
const baudRate = document.getElementById('baudRate');
const autoscroll = document.getElementById('autoscroll');
const showTimestamp = document.getElementById('showTimestamp');
const angleType = document.getElementById('angle_type');
const lightSS = document.getElementById('light');
const darkSS = document.getElementById('dark');
const darkMode = document.getElementById('darkmode');
const canvas = document.querySelector('#canvas');
const calContainer = document.getElementById('calibration');
const logContainer = document.getElementById("log-container");

fitToContainer(canvas);

function fitToContainer(canvas) {
  // Make it visually fill the positioned parent
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  // ...then set the internal size to match
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
}

document.addEventListener('DOMContentLoaded', async () => {
  butConnect.addEventListener('click', clickConnect);
  butClear.addEventListener('click', clickClear);
  autoscroll.addEventListener('click', clickAutoscroll);
  showTimestamp.addEventListener('click', clickTimestamp);
  baudRate.addEventListener('change', changeBaudRate);
  angleType.addEventListener('change', changeAngleType);
  darkMode.addEventListener('click', clickDarkMode);

  // Add CSV buttons automatically so you do NOT need to edit index.html
  addCSVButtons();

  if ('serial' in navigator) {
    const notSupported = document.getElementById('notSupported');
    notSupported.classList.add('hidden');
  }

  if (isWebGLAvailable()) {
    const webGLnotSupported = document.getElementById('webGLnotSupported');
    webGLnotSupported.classList.add('hidden');
  }

  initBaudRate();
  loadAllSettings();
  updateTheme();
  await finishDrawing();
  await render();
});

/**
 * Adds Download CSV and Clear Recorded Data buttons to the top controls.
 */
function addCSVButtons() {
  const downloadButton = document.createElement('button');
  downloadButton.id = 'downloadCSV';
  downloadButton.textContent = 'Download CSV';
  downloadButton.style.marginLeft = '10px';
  downloadButton.addEventListener('click', downloadCSV);

  const clearRecordedButton = document.createElement('button');
  clearRecordedButton.id = 'clearRecordedData';
  clearRecordedButton.textContent = 'Clear Recorded Data';
  clearRecordedButton.style.marginLeft = '5px';
  clearRecordedButton.addEventListener('click', clearRecordedData);

  // Put buttons after the connect button
  butConnect.insertAdjacentElement('afterend', clearRecordedButton);
  butConnect.insertAdjacentElement('afterend', downloadButton);
}

/**
 * @name connect
 * Opens a Web Serial connection and sets up the input stream.
 */
async function connect() {
  // Request a port and open a connection.
  port = await navigator.serial.requestPort();

  // Wait for the port to open.
  await port.open({ baudRate: Number(baudRate.value) });

  let decoder = new TextDecoderStream();
  inputDone = port.readable.pipeTo(decoder.writable);
  inputStream = decoder.readable
    .pipeThrough(new TransformStream(new LineBreakTransformer()));

  reader = inputStream.getReader();

  readLoop().catch(async function(error) {
    console.error(error);
    toggleUIConnected(false);
    await disconnect();
  });
}

/**
 * @name disconnect
 * Closes the Web Serial connection.
 */
async function disconnect() {
  if (reader) {
    await reader.cancel();
    await inputDone.catch(() => {});
    reader = null;
    inputDone = null;
  }

  if (outputStream) {
    await outputStream.getWriter().close();
    await outputDone;
    outputStream = null;
    outputDone = null;
  }

  await port.close();
  port = null;
  showCalibration = false;
}

/**
 * @name readLoop
 * Reads data from the input stream, parses it, and records it.
 */
async function readLoop() {
  while (true) {
    const {value, done} = await reader.read();

    if (value) {
      parseSerialLine(value);
    }

    if (done) {
      console.log('[readLoop] DONE', done);
      reader.releaseLock();
      break;
    }
  }
}

/**
 * Parses serial data lines.
 *
 * Expected input examples:
 * Orientation: 357.19, 0.94, 1.62
 * Quaternion: 0.9996, -0.0146, -0.0079, -0.0249
 * Calibration: 0, 3, 3, 0
 */
function parseSerialLine(value) {
  value = value.trim();

  if (value.substr(0, 12) == "Orientation:") {
    orientation = value.substr(12).trim().split(",").map(x => +x);
    latestOrientation = orientation;
  }

  if (value.substr(0, 11) == "Quaternion:") {
    quaternion = value.substr(11).trim().split(",").map(x => +x);
    latestQuaternion = quaternion;

    // Record one row every time a quaternion line arrives.
    // This records continuously, even if calibration is not complete.
    recordCurrentReading();
  }

  if (value.substr(0, 12) == "Calibration:") {
    calibration = value.substr(12).trim().split(",").map(x => +x);
    latestCalibration = calibration;

    if (!showCalibration) {
      showCalibration = true;
      updateTheme();
    }
  }
}

/**
 * Saves the latest complete reading into recordedData.
 */
function recordCurrentReading() {
  if (!recordingEnabled) {
    return;
  }

  recordedData.push({
    timestamp: new Date().toISOString(),

    heading: latestOrientation[0],
    roll: latestOrientation[1],
    pitch: latestOrientation[2],

    qw: latestQuaternion[0],
    qx: latestQuaternion[1],
    qy: latestQuaternion[2],
    qz: latestQuaternion[3],

    systemCal: latestCalibration[0],
    gyroCal: latestCalibration[1],
    accelCal: latestCalibration[2],
    magCal: latestCalibration[3]
  });
}

/**
 * Downloads recorded IMU data as a CSV file.
 */
function downloadCSV() {
  if (recordedData.length === 0) {
    alert("No data recorded yet. Connect your IMU and wait for readings first.");
    return;
  }

  const headers = [
    "timestamp",
    "heading",
    "roll",
    "pitch",
    "qw",
    "qx",
    "qy",
    "qz",
    "systemCal",
    "gyroCal",
    "accelCal",
    "magCal"
  ];

  const csvRows = [];
  csvRows.push(headers.join(","));

  recordedData.forEach(row => {
    const values = headers.map(header => {
      const value = row[header];

      // Keep blank if value is undefined/null
      if (value === undefined || value === null) {
        return "";
      }

      return value;
    });

    csvRows.push(values.join(","));
  });

  const csvContent = csvRows.join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;

  const now = new Date();
  const filename =
    "imu_data_" +
    now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0") + "_" +
    String(now.getHours()).padStart(2, "0") + "-" +
    String(now.getMinutes()).padStart(2, "0") + "-" +
    String(now.getSeconds()).padStart(2, "0") +
    ".csv";

  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

/**
 * Clears only the recorded CSV data.
 */
function clearRecordedData() {
  recordedData = [];
  alert("Recorded IMU data cleared.");
}

function logData(line) {
  // Update the Log
  if (showTimestamp.checked) {
    let d = new Date();
    let timestamp = d.getHours() + ":" + `${d.getMinutes()}`.padStart(2, 0) + ":" +
        `${d.getSeconds()}`.padStart(2, 0) + "." + `${d.getMilliseconds()}`.padStart(3, 0);
    log.innerHTML += '<span class="timestamp">' + timestamp + ' -> </span>';
    d = null;
  }

  log.innerHTML += line + "<br>";

  // Remove old log content
  if (log.textContent.split("\n").length > maxLogLength + 1) {
    let logLines = log.innerHTML.replace(/(\n)/gm, "").split("<br>");
    log.innerHTML = logLines.splice(-maxLogLength).join("<br>\n");
  }

  if (autoscroll.checked) {
    log.scrollTop = log.scrollHeight;
  }
}

/**
 * @name updateTheme
 * Sets the theme.
 */
function updateTheme() {
  // Disable all themes
  document
    .querySelectorAll('link[rel=stylesheet].alternate')
    .forEach((styleSheet) => {
      enableStyleSheet(styleSheet, false);
    });

  if (darkMode.checked) {
    enableStyleSheet(darkSS, true);
  } else {
    enableStyleSheet(lightSS, true);
  }

  if (showCalibration && !logContainer.classList.contains('show-calibration')) {
    logContainer.classList.add('show-calibration');
  } else if (!showCalibration && logContainer.classList.contains('show-calibration')) {
    logContainer.classList.remove('show-calibration');
  }
}

function enableStyleSheet(node, enabled) {
  node.disabled = !enabled;
}

/**
 * @name reset
 * Reset the Log.
 */
async function reset() {
  log.innerHTML = "";
}

/**
 * @name clickConnect
 * Click handler for the connect/disconnect button.
 */
async function clickConnect() {
  if (port) {
    await disconnect();
    toggleUIConnected(false);
    return;
  }

  await connect();

  reset();

  toggleUIConnected(true);
}

/**
 * @name clickAutoscroll
 * Change handler for the Autoscroll checkbox.
 */
async function clickAutoscroll() {
  saveSetting('autoscroll', autoscroll.checked);
}

/**
 * @name clickTimestamp
 * Change handler for the Show Timestamp checkbox.
 */
async function clickTimestamp() {
  saveSetting('timestamp', showTimestamp.checked);
}

/**
 * @name changeBaudRate
 * Change handler for the Baud Rate selector.
 */
async function changeBaudRate() {
  saveSetting('baudrate', baudRate.value);
}

/**
 * @name changeAngleType
 * Change handler for the angle type selector.
 */
async function changeAngleType() {
  saveSetting('angletype', angleType.value);
}

/**
 * @name clickDarkMode
 * Change handler for the Dark Mode checkbox.
 */
async function clickDarkMode() {
  updateTheme();
  saveSetting('darkmode', darkMode.checked);
}

/**
 * @name clickClear
 * Click handler for the clear button.
 */
async function clickClear() {
  reset();
}

async function finishDrawing() {
  return new Promise(requestAnimationFrame);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @name LineBreakTransformer
 * TransformStream to parse the stream into lines.
 */
class LineBreakTransformer {
  constructor() {
    // A container for holding stream data until a new line.
    this.container = '';
  }

  transform(chunk, controller) {
    this.container += chunk;
    const lines = this.container.split('\n');
    this.container = lines.pop();

    lines.forEach(line => {
      controller.enqueue(line);
      logData(line);
    });
  }

  flush(controller) {
    controller.enqueue(this.container);
  }
}

function convertJSON(chunk) {
  try {
    let jsonObj = JSON.parse(chunk);
    jsonObj._raw = chunk;
    return jsonObj;
  } catch (e) {
    return chunk;
  }
}

function toggleUIConnected(connected) {
  let lbl = 'Connect';

  if (connected) {
    lbl = 'Disconnect';
  }

  butConnect.textContent = lbl;
  updateTheme();
}

function initBaudRate() {
  for (let rate of baudRates) {
    var option = document.createElement("option");
    option.text = rate + " Baud";
    option.value = rate;
    baudRate.add(option);
  }
}

function loadAllSettings() {
  // Load all saved settings or defaults
  autoscroll.checked = loadSetting('autoscroll', true);
  showTimestamp.checked = loadSetting('timestamp', false);
  baudRate.value = loadSetting('baudrate', 9600);
  angleType.value = loadSetting('angletype', 'quaternion');
  darkMode.checked = loadSetting('darkmode', false);
}

function loadSetting(setting, defaultValue) {
  let value = JSON.parse(window.localStorage.getItem(setting));

  if (value == null) {
    return defaultValue;
  }

  return value;
}

let isWebGLAvailable = function() {
  try {
    var canvas = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
  } catch (e) {
    return false;
  }
};

function updateCalibration() {
  // Update the Calibration Container with the values from calibration
  const calMap = [
    {caption: "Uncalibrated",         color: "#CC0000"},
    {caption: "Partially Calibrated", color: "#FF6600"},
    {caption: "Mostly Calibrated",    color: "#FFCC00"},
    {caption: "Fully Calibrated",     color: "#009900"},
  ];

  const calLabels = [
    "System", "Gyro", "Accelerometer", "Magnetometer"
  ];

  calContainer.innerHTML = "";

  for (var i = 0; i < calibration.length; i++) {
    let calInfo = calMap[calibration[i]];

    if (!calInfo) {
      calInfo = {caption: "Unknown", color: "#999999"};
    }

    let element = document.createElement("div");
    element.innerHTML = calLabels[i] + ": " + calInfo.caption;
    element.style = "color: " + calInfo.color;
    calContainer.appendChild(element);
  }
}

function saveSetting(setting, value) {
  window.localStorage.setItem(setting, JSON.stringify(value));
}

let head;

const renderer = new THREE.WebGLRenderer({canvas});

const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 100);
camera.position.set(0, 0, 30);

const scene = new THREE.Scene();
scene.background = new THREE.Color('black');

{
  const skyColor = 0xB1E1FF;     // light blue
  const groundColor = 0x666666;  // gray
  const intensity = 0.5;
  const light = new THREE.HemisphereLight(skyColor, groundColor, intensity);
  scene.add(light);
}

{
  const color = 0xFFFFFF;
  const intensity = 1;
  const light = new THREE.DirectionalLight(color, intensity);
  light.position.set(0, 10, 0);
  light.target.position.set(-5, 0, 0);
  scene.add(light);
  scene.add(light.target);
}

{
  const objLoader = new OBJLoader();

  objLoader.load('assets/head.obj', (root) => {
    head = root;

    // Adjust this if the head appears too large/small.
    head.scale.set(1, 1, 1);

    scene.add(root);
  });
}

function resizeRendererToDisplaySize(renderer) {
  const canvas = renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const needResize = canvas.width !== width || canvas.height !== height;

  if (needResize) {
    renderer.setSize(width, height, false);
  }

  return needResize;
}

async function render() {
  if (resizeRendererToDisplaySize(renderer)) {
    const canvas = renderer.domElement;
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }

  if (head != undefined) {
    if (angleType.value == "euler") {
      if (showCalibration) {
        // BNO055 Euler rotation
        let rotationEuler = new THREE.Euler(
          THREE.MathUtils.degToRad(360 - orientation[2]),
          THREE.MathUtils.degToRad(orientation[0]),
          THREE.MathUtils.degToRad(orientation[1]),
          'YZX'
        );

        head.setRotationFromEuler(rotationEuler);
      } else {
        let rotationEuler = new THREE.Euler(
          THREE.MathUtils.degToRad(orientation[2]),
          THREE.MathUtils.degToRad(orientation[0] - 180),
          THREE.MathUtils.degToRad(-orientation[1]),
          'YZX'
        );

        head.setRotationFromEuler(rotationEuler);
      }
    } else {
      let rotationQuaternion = new THREE.Quaternion(
        quaternion[1],
        quaternion[3],
        -quaternion[2],
        quaternion[0]
      );

      head.setRotationFromQuaternion(rotationQuaternion);
    }
  }

  renderer.render(scene, camera);
  updateCalibration();

  await sleep(10); // Allow 10ms for UI updates
  await finishDrawing();
  await render();
}