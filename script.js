// =========================
// DOM & AUDIO SETUP
// =========================
const audioCtx = new AudioContext();

const fileInput = document.getElementById("fileInput");
const analyzeBtn = document.getElementById("analyzeBtn"); // must match HTML
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");
const output = document.getElementById("output");

analyzeBtn.addEventListener("click", analyze);

// =========================
// MAIN ANALYSIS PIPELINE
// =========================
async function analyze() {
  if (!fileInput.files.length) return;
  await audioCtx.resume();

  const buffer = await decode(fileInput.files[0]);
  const samples = buffer.getChannelData(0);
  const sr = buffer.sampleRate;

  resizeCanvas();
  drawWaveform(samples);

  const clicks = detectClicks(samples, sr);
  const events = analyzeCentroids(samples, sr, clicks);

  const classified = classifyByCentroid(events);
  const beatsPerBar = detectBeatsPerBar(classified.downbeats);
  const tempoMap = segmentTempo(clicks);

  drawBeatOverlay(classified, samples.length, sr);

  output.textContent = JSON.stringify(
    {
      beatsDetected: clicks.length,
      downbeats: classified.downbeats.length,
      beatsPerBar,
      tempoChanges: tempoMap
    },
    null,
    2
  );
}

// =========================
// AUDIO DECODE
// =========================
async function decode(file) {
  const data = await file.arrayBuffer();
  return audioCtx.decodeAudioData(data);
}

// =========================
// CLICK DETECTION
// =========================
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

// =========================
// CENTROID ANALYSIS (SYNC, SAFE)
// =========================
function analyzeCentroids(samples, sr, times) {
  const size = 2048;
  const results = [];

  for (const time of times) {
    const start = Math.floor(time * sr);
    if (start + size >= samples.length) continue;

    const window = samples.slice(start, start + size);
    const centroid = spectralCentroid(window, sr);
    results.push({ time, centroid });
  }

  return results;
}

function spectralCentroid(window, sr) {
  let weighted = 0;
  let total = 0;

  for (let i = 0; i < window.length; i++) {
    const mag = Math.abs(window[i]);
    weighted += i * mag;
    total += mag;
  }

  if (!total) return 0;
  return (weighted / total) * (sr / window.length);
}

// =========================
// DOWNBEAT CLASSIFICATION
// =========================
function classifyByCentroid(events) {
  const values = events.map(e => e.centroid);
  const mean =
    values.reduce((a, b) => a + b, 0) / values.length;

  const low = [];
  const high = [];

  events.forEach(e =>
    (e.centroid < mean ? low : high).push(e)
  );

  return low.length < high.length
    ? { downbeats: low, beats: high }
    : { downbeats: high, beats: low };
}

// =========================
// BEATS-PER-BAR DETECTION
// =========================
function detectBeatsPerBar(downbeats) {
  if (downbeats.length < 2) return null;

  const intervals = [];
  for (let i = 1; i < downbeats.length; i++) {
    intervals.push(downbeats[i].time - downbeats[i - 1].time);
  }

  const avgBar = intervals.reduce((a, b) => a + b, 0) / intervals.length;

  // estimate beat length from overall clicks
  const approxBeat = intervals[0] / 4;
  const beatsPerBar = Math.round(avgBar / approxBeat);

  return beatsPerBar;
}

// =========================
// TEMPO CHANGE SEGMENTATION
// =========================
function segmentTempo(times, tolerance = 1) {
  const changes = [];
  let lastBpm = null;

  for (let i = 1; i < times.length; i++) {
    const bpm = 60 / (times[i] - times[i - 1]);

    if (!lastBpm || Math.abs(bpm - lastBpm) > tolerance) {
      changes.push({
        time: times[i],
        bpm: Math.round(bpm * 100) / 100
      });
      lastBpm = bpm;
    }
  }

  return changes;
}

// =========================
// VISUALIZATION
// =========================
function drawWaveform(samples) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#38bdf8";
  ctx.beginPath();

  const step = Math.ceil(samples.length / canvas.width);
  const mid = canvas.height / 2;

  for (let x = 0; x < canvas.width; x++) {
    const s = samples[x * step] || 0;
    ctx.lineTo(x, mid + s * mid);
  }

  ctx.stroke();
}

function drawBeatOverlay(classified, length, sr) {
  const totalTime = length / sr;

  classified.beats.forEach(b =>
    drawMarker(b.time / totalTime, "#60a5fa", 1)
  );

  classified.downbeats.forEach(d =>
    drawMarker(d.time / totalTime, "#f87171", 2)
  );
}

function drawMarker(normX, color, width) {
  const x = normX * canvas.width;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;

  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();
}

// =========================
// CANVAS
// =========================
function resizeCanvas() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}
