// ========================
// DOM + AUDIO SETUP
// ========================
const fileInput = document.getElementById("fileInput");
const processBtn = document.getElementById("processBtn");
const canvas = document.getElementById("waveform");
const output = document.getElementById("output");

if (!fileInput || !processBtn || !canvas || !output) {
  throw new Error("Missing required DOM elements: fileInput, processBtn, waveform, output");
}

const ctx = canvas.getContext("2d");
const audioCtx = new AudioContext();

// ========================
// STATE
// ========================
let audioBuffer = null;
let samples = null;
let sampleRate = 44100;

let clicks = [];
let beatData = [];

let zoom = 1;
let scrollX = 0;

// ========================
// EVENT HANDLERS
// ========================
processBtn.addEventListener("click", async () => {
  if (!fileInput.files.length) return;

  await audioCtx.resume();

  audioBuffer = await decodeAudio(fileInput.files[0]);
  samples = audioBuffer.getChannelData(0);
  sampleRate = audioBuffer.sampleRate;

  resizeCanvas();

  clicks = detectClicks(samples, sampleRate);
  beatData = await analyzeBeats(samples, sampleRate, clicks);

  const bars = detectBeatsPerBar(beatData);
  const tempoChanges = detectTempoChanges(beatData);

  draw();

  output.textContent = JSON.stringify(
    {
      beatsPerBar: bars,
      tempoChanges,
      beats: beatData
    },
    null,
    2
  );
});

// Zoom & scroll
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  zoom *= e.deltaY < 0 ? 1.1 : 0.9;
  zoom = Math.max(1, Math.min(zoom, 20));
  draw();
});

canvas.addEventListener("mousemove", e => {
  if (e.buttons !== 1) return;
  scrollX -= e.movementX * zoom;
  scrollX = Math.max(0, scrollX);
  draw();
});

// ========================
// AUDIO
// ========================
async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  return audioCtx.decodeAudioData(buf);
}

// ========================
// CLICK DETECTION (SAFE)
// ========================
function detectClicks(samples, sr) {
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > max) max = v;
  }

  const threshold = max * 0.35;
  const minGap = 0.08;

  const clicks = [];
  let last = -Infinity;

  for (let i = 0; i < samples.length; i++) {
    const t = i / sr;
    if (Math.abs(samples[i]) > threshold && t - last > minGap) {
      clicks.push(t);
      last = t;
    }
  }
  return clicks;
}

// ========================
// BEAT ANALYSIS
// ========================
async function analyzeBeats(samples, sr, clicks) {
  const beats = [];

  for (const time of clicks) {
    const centroid = spectralCentroid(samples, sr, time);
    beats.push({ time, centroid });
  }

  // robust clustering
  const centroids = beats.map(b => b.centroid).sort((a, b) => a - b);
  const split = centroids[Math.floor(centroids.length / 2)];

  const low = beats.filter(b => b.centroid < split);
  const high = beats.filter(b => b.centroid >= split);

  const downbeats = low.length < high.length ? low : high;

  beats.forEach(b => {
    b.isDownbeat = downbeats.includes(b);
  });

  return beats;
}

// ========================
// SPECTRAL CENTROID (FAST, NO OFFLINE CONTEXT)
// ========================
function spectralCentroid(samples, sr, time) {
  const size = 2048;
  const start = Math.floor(time * sr);
  if (start + size >= samples.length) return 0;

  let weighted = 0;
  let sum = 0;

  for (let i = 0; i < size; i++) {
    const mag = Math.abs(samples[start + i]);
    const freq = (i * sr) / size;
    weighted += freq * mag;
    sum += mag;
  }

  return sum ? weighted / sum : 0;
}

// ========================
// BEATS PER BAR DETECTION
// ========================
function detectBeatsPerBar(beats) {
  const distances = [];

  let lastDownbeat = null;
  beats.forEach(b => {
    if (b.isDownbeat) {
      if (lastDownbeat !== null) {
        distances.push(b.time - lastDownbeat);
      }
      lastDownbeat = b.time;
    }
  });

  if (!distances.length) return null;

  const avgBar = distances.reduce((a, b) => a + b, 0) / distances.length;
  const avgBeat = averageBeatInterval(beats);

  return Math.round(avgBar / avgBeat);
}

function averageBeatInterval(beats) {
  let sum = 0;
  let count = 0;
  for (let i = 1; i < beats.length; i++) {
    sum += beats[i].time - beats[i - 1].time;
    count++;
  }
  return sum / count;
}

// ========================
// TEMPO SEGMENTATION
// ========================
function detectTempoChanges(beats, tolerance = 1) {
  const changes = [];
  let lastBpm = null;

  for (let i = 1; i < beats.length; i++) {
    const bpm = 60 / (beats[i].time - beats[i - 1].time);
    if (!lastBpm || Math.abs(bpm - lastBpm) > tolerance) {
      changes.push({ time: beats[i].time, bpm });
      lastBpm = bpm;
    }
  }
  return changes;
}

// ========================
// VISUALIZATION
// ========================
function resizeCanvas() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawWaveform();
  drawBeats();
}

function drawWaveform() {
  const mid = canvas.height / 2;
  const step = Math.ceil(samples.length / (canvas.width * zoom));

  ctx.strokeStyle = "#475569";
  ctx.beginPath();

  for (let x = 0; x < canvas.width; x++) {
    const idx = Math.floor((x + scrollX) * step);
    const v = samples[idx] || 0;
    const y = mid + v * mid;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawBeats() {
  beatData.forEach(b => {
    const x =
      (b.time * sampleRate) / (samples.length / (canvas.width * zoom)) -
      scrollX;

    if (x < 0 || x > canvas.width) return;

    ctx.strokeStyle = b.isDownbeat ? "#ef4444" : "#22d3ee";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  });
}
