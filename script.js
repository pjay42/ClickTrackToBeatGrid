const audioCtx = new AudioContext();

const fileInput = document.getElementById("fileInput");
const analyzeBtn = document.getElementById("analyzeBtn");
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");
const output = document.getElementById("output");

/* =======================
   MAIN CLICK HANDLER
======================= */
analyzeBtn.addEventListener("click", async () => {
  if (!fileInput.files.length) return;
  await audioCtx.resume();

  const buffer = await decode(fileInput.files[0]);
  const samples = buffer.getChannelData(0);
  const sr = buffer.sampleRate;

  resizeCanvas();
  drawWaveform(samples);

  const clickTimes = detectClicks(samples, sr);
  const analyzed = await analyzeClicks(samples, sr, clickTimes);

  const classified = classifyByCentroid(analyzed);
  const tempoMap = buildTempoMap(classified);

  drawBeatsOverlay(classified);

  output.textContent = JSON.stringify(
    {
      beats: classified,
      tempoMap
    },
    null,
    2
  );
});

/* =======================
   AUDIO
======================= */
async function decode(file) {
  return audioCtx.decodeAudioData(await file.arrayBuffer());
}

/* =======================
   CLICK DETECTION
======================= */
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
    const v = Math.abs(samples[i]);
    const t = i / sr;

    if (v > threshold && t - last > minGap) {
      clicks.push(t);
      last = t;
    }
  }
  return clicks;
}

/* =======================
   FFT + CENTROID
======================= */
async function analyzeClicks(samples, sr, times) {
  const results = [];

  for (const time of times) {
    const centroid = await spectralCentroidAt(samples, sr, time);
    results.push({ time, centroid });
  }
  return results;
}

async function spectralCentroidAt(samples, sr, time) {
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

  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(data);

  let weighted = 0;
  let total = 0;

  for (let i = 0; i < data.length; i++) {
    const mag = Math.pow(10, data[i] / 20);
    const freq = i * sr / size;
    weighted += freq * mag;
    total += mag;
  }

  return total ? weighted / total : 0;
}

/* =======================
   CLASSIFICATION
======================= */
function classifyByCentroid(events) {
  const centroids = events.map(e => e.centroid).sort((a,b)=>a-b);
  const split = centroids[Math.floor(centroids.length / 2)];

  const low = [];
  const high = [];

  events.forEach(e =>
    (e.centroid < split ? low : high).push(e)
  );

  const downbeats = low.length < high.length ? low : high;
  const beats = low.length < high.length ? high : low;

  return events.map(e => ({
    ...e,
    isDownbeat: downbeats.includes(e)
  }));
}

/* =======================
   TEMPO MAP
======================= */
function buildTempoMap(events, tolerance = 1) {
  const map = [];
  let lastBpm = null;

  for (let i = 1; i < events.length; i++) {
    const bpm = 60 / (events[i].time - events[i - 1].time);

    if (!lastBpm || Math.abs(bpm - lastBpm) > tolerance) {
      map.push({
        time: events[i].time,
        bpm: Math.round(bpm * 100) / 100
      });
      lastBpm = bpm;
    }

    events[i].bpm = lastBpm;
  }
  return map;
}

/* =======================
   VISUALIZATION
======================= */
function drawBeatsOverlay(events) {
  const w = canvas.width;
  const h = canvas.height;

  ctx.save();
  ctx.globalAlpha = 0.85;

  events.forEach(e => {
    const x = (e.time / events[events.length - 1].time) * w;
    ctx.strokeStyle = e.isDownbeat ? "#ef4444" : "#38bdf8";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  });

  ctx.restore();
}

function resizeCanvas() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}

function drawWaveform(samples) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#64748b";
  ctx.beginPath();

  const step = Math.ceil(samples.length / canvas.width);
  const mid = canvas.height / 2;

  for (let x = 0; x < canvas.width; x++) {
    const v = samples[x * step] || 0;
    const y = mid + v * mid;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}
