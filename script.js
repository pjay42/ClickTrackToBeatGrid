const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

const fileInput = document.getElementById("fileInput");
const analyzeBtn = document.getElementById("processBtn");
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");
const output = document.getElementById("output");

/* ============================
   MAIN ANALYZE BUTTON
============================ */
analyzeBtn.addEventListener("click", async () => {
  if (!fileInput.files.length) {
    alert("Please load an audio file first.");
    return;
  }

  await audioCtx.resume();

  const file = fileInput.files[0];
  const buffer = await decode(file);
  const samples = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const duration = buffer.duration;

  resizeCanvas();
  drawWaveform(samples);

  const clickTimes = detectClicks(samples, sr);

  const events = [];
  for (const time of clickTimes) {
    const centroid = await analyzeFFT(samples, sr, time);
    events.push({ time, centroid });
  }

  const { downbeats, beats } = classify(events);
  const tempoChanges = detectTempo(clickTimes);

  drawBeatOverlay(downbeats, beats, duration);

  output.textContent = JSON.stringify(
    {
      totalClicks: events.length,
      downbeats: downbeats.length,
      beats: beats.length,
      tempoChanges
    },
    null,
    2
  );
});

/* ============================
   AUDIO DECODE
============================ */
async function decode(file) {
  const data = await file.arrayBuffer();
  return await audioCtx.decodeAudioData(data);
}

/* ============================
   CLICK DETECTION
============================ */
function detectClicks(samples, sr) {
  const abs = samples.map(v => Math.abs(v));
  const max = Math.max(...abs);
  const threshold = max * 0.35;
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

/* ============================
   FFT + SPECTRAL CENTROID
============================ */
async function analyzeFFT(samples, sr, time) {
  const size = 2048;
  const start = Math.floor(time * sr);

  if (start + size >= samples.length) return 0;

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

  return spectralCentroid(freqData, sr, size);
}

function spectralCentroid(freqData, sampleRate, fftSize) {
  let weightedSum = 0;
  let magnitudeSum = 0;

  for (let i = 0; i < freqData.length; i++) {
    const mag = Math.pow(10, freqData[i] / 20);
    const freq = (i * sampleRate) / fftSize;

    weightedSum += freq * mag;
    magnitudeSum += mag;
  }

  return magnitudeSum ? weightedSum / magnitudeSum : 0;
}

/* ============================
   BEAT CLASSIFICATION
============================ */
function classify(events) {
  const values = events.map(e => e.centroid).sort((a, b) => a - b);
  const split = values[Math.floor(values.length / 2)];

  const low = [];
  const high = [];

  events.forEach(e =>
    (e.centroid < split ? low : high).push(e)
  );

  return low.length < high.length
    ? { downbeats: low, beats: high }
    : { downbeats: high, beats: low };
}

/* ============================
   TEMPO DETECTION
============================ */
function detectTempo(times, tolerance = 1) {
  let last = null;
  const changes = [];

  for (let i = 1; i < times.length; i++) {
    const bpm = 60 / (times[i] - times[i - 1]);
    if (!last || Math.abs(bpm - last) > tolerance) {
      changes.push({ time: times[i], bpm: Math.round(bpm * 100) / 100 });
      last = bpm;
    }
  }
  return changes;
}

/* ============================
   CANVAS HELPERS
============================ */
function resizeCanvas() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}

function drawWaveform(samples) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1;
  ctx.beginPath();

  const step = Math.ceil(samples.length / canvas.width);
  const mid = canvas.height / 2;

  for (let x = 0; x < canvas.width; x++) {
    const s = samples[x * step] || 0;
    const y = mid + s * mid;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/* ============================
   BEAT OVERLAY
============================ */
function drawBeatOverlay(downbeats, beats, duration) {
  const w = canvas.width;
  const h = canvas.height;

  ctx.lineWidth = 1;

  // Regular beats
  ctx.strokeStyle = "rgba(56,189,248,0.8)";
  beats.forEach(b => {
    const x = (b.time / duration) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  });

  // Downbeats
  ctx.strokeStyle = "rgba(248,113,113,0.9)";
  ctx.lineWidth = 2;
  downbeats.forEach(b => {
    const x = (b.time / duration) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  });
}
