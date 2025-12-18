// ==========================
// DOM & AUDIO CONTEXT
// ==========================
const audioCtx = new AudioContext();

const fileInput = document.getElementById("fileInput");
const processBtn = document.getElementById("processBtn");
const canvas = document.getElementById("waveform");
const zoomSlider = document.getElementById("zoom");
const output = document.getElementById("output");

if (!fileInput || !processBtn || !canvas || !output || !zoomSlider) {
  throw new Error("Missing required DOM elements");
}

const ctx = canvas.getContext("2d");

// ==========================
// STATE
// ==========================
let samples = null;
let sampleRate = 44100;
let clicks = [];
let events = [];
let zoom = 1;

// ==========================
// UI EVENTS
// ==========================
zoomSlider.addEventListener("input", () => {
  zoom = Number(zoomSlider.value);
  redraw();
});

processBtn.addEventListener("click", async () => {
  if (!fileInput.files.length) return;

  await audioCtx.resume();

  const buffer = await decode(fileInput.files[0]);
  samples = buffer.getChannelData(0);
  sampleRate = buffer.sampleRate;

  clicks = detectClicks(samples, sampleRate);
  events = await analyzeClicks(samples, sampleRate, clicks);

  classifyDownbeats(events);
  detectBeatsPerBar(events);
  detectTempoChanges(events);

  resizeCanvas();
  redraw();

  output.textContent = JSON.stringify(events, null, 2);
});

// ==========================
// AUDIO DECODE
// ==========================
async function decode(file) {
  const data = await file.arrayBuffer();
  return audioCtx.decodeAudioData(data);
}

// ==========================
// CLICK DETECTION
// ==========================
function detectClicks(samples, sr) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }

  const threshold = peak * 0.35;
  const minGap = 0.08;

  const clicks = [];
  let last = -Infinity;

  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    const t = i / sr;

    if (v > threshold && t - last > minGap) {
      clicks.push(t);
      last = t;
    }
  }

  return clicks;
}

// ==========================
// FFT + CENTROID (FIXED)
// ==========================
async function analyzeClicks(samples, sr, times) {
  const size = 2048;
  const results = [];

  for (const time of times) {
    const start = Math.floor(time * sr);
    if (start + size >= samples.length) continue;

    const offline = new OfflineAudioContext(1, size, sr);
    const buffer = offline.createBuffer(1, size, sr);
    buffer.copyToChannel(samples.slice(start, start + size), 0);

    const src = offline.createBufferSource();
    const analyser = offline.createAnalyser();
    analyser.fftSize = size;

    src.buffer = buffer;
    src.connect(analyser);
    analyser.connect(offline.destination);
    src.start();

    await offline.startRendering();

    const freqData = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqData);

    const centroid = spectralCentroid(freqData, sr, size);

    results.push({ time, centroid });
  }

  return results;
}

function spectralCentroid(freqData, sr, fftSize) {
  let weighted = 0;
  let total = 0;

  for (let i = 0; i < freqData.length; i++) {
    const mag = Math.max(0, 1 + freqData[i] / 60); // 🔑 FIXED SCALING
    const freq = (i * sr) / fftSize;

    weighted += freq * mag;
    total += mag;
  }

  return total ? weighted / total : 0;
}

// ==========================
// DOWNBEAT CLASSIFICATION
// ==========================
function classifyDownbeats(events) {
  const centroids = events.map(e => e.centroid);

  const mean =
    centroids.reduce((a, b) => a + b, 0) / centroids.length;

  let low = [];
  let high = [];

  events.forEach(e => {
    (e.centroid < mean ? low : high).push(e);
  });

  const downbeats = low.length < high.length ? low : high;

  events.forEach(e => {
    e.isDownbeat = downbeats.includes(e);
  });
}

// ==========================
// BEATS PER BAR DETECTION
// ==========================
function detectBeatsPerBar(events) {
  let count = 0;
  for (const e of events) {
    if (e.isDownbeat) count++;
  }

  const avg = events.length / count;
  events.forEach(e => (e.beatsPerBar = Math.round(avg)));
}

// ==========================
// TEMPO CHANGE SEGMENTATION
// ==========================
function detectTempoChanges(events) {
  let lastBpm = null;

  for (let i = 1; i < events.length; i++) {
    const dt = events[i].time - events[i - 1].time;
    const bpm = 60 / dt;

    if (!lastBpm || Math.abs(bpm - lastBpm) > 1) {
      events[i].bpm = Math.round(bpm * 100) / 100;
      lastBpm = bpm;
    } else {
      events[i].bpm = lastBpm;
    }
  }
}

// ==========================
// WAVEFORM + OVERLAY
// ==========================
function resizeCanvas() {
  canvas.width = samples.length / zoom / 10;
}

function redraw() {
  drawWaveform();
  drawBeats();
}

function drawWaveform() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#38bdf8";
  ctx.beginPath();

  const step = Math.floor(samples.length / canvas.width);
  const mid = canvas.height / 2;

  for (let x = 0; x < canvas.width; x++) {
    const s = samples[x * step] || 0;
    const y = mid + s * mid;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }

  ctx.stroke();
}

function drawBeats() {
  for (const e of events) {
    const x = (e.time * sampleRate) / (samples.length / canvas.width);

    ctx.strokeStyle = e.isDownbeat ? "#f87171" : "#22c55e";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
}
