const audioCtx = new AudioContext();

const fileInput = document.getElementById("fileInput");
const analyzeBtn = document.getElementById("analyzeBtn"); // MUST match HTML
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");
const output = document.getElementById("output");

/* ============================
   MAIN CLICK HANDLER
============================ */
analyzeBtn.addEventListener("click", async () => {
  if (!fileInput.files.length) return;

  await audioCtx.resume();

  const file = fileInput.files[0];
  const buffer = await decodeAudio(file);
  const samples = buffer.getChannelData(0);
  const sr = buffer.sampleRate;

  resizeCanvas();
  drawWaveform(samples);

  const clicks = detectClicks(samples, sr);

  const events = clicks.map(time => {
    const centroid = computeCentroid(samples, sr, time);
    return { time, centroid };
  });

  const { downbeats, beats } = classify(events);
  const tempoChanges = detectTempo(clicks);

  drawBeatOverlay(events, downbeats);

  output.textContent = JSON.stringify(
    { events, downbeats, tempoChanges },
    null,
    2
  );
});

/* ============================
   AUDIO DECODE
============================ */
async function decodeAudio(file) {
  const data = await file.arrayBuffer();
  return audioCtx.decodeAudioData(data);
}

/* ============================
   CLICK DETECTION (SAFE)
============================ */
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

/* ============================
   SPECTRAL CENTROID (NO FFT NODES)
============================ */
function computeCentroid(samples, sr, time) {
  const size = 2048;
  const start = Math.floor(time * sr);

  if (start + size >= samples.length) return 0;

  let weightedSum = 0;
  let magSum = 0;

  for (let i = 0; i < size; i++) {
    const sample = samples[start + i];
    const mag = Math.abs(sample);
    const freq = (i * sr) / size;

    weightedSum += freq * mag;
    magSum += mag;
  }

  return magSum ? weightedSum / magSum : 0;
}

/* ============================
   CLASSIFY DOWNBEATS
============================ */
function classify(events) {
  const centroids = events.map(e => e.centroid).sort((a, b) => a - b);
  const split = centroids[Math.floor(centroids.length / 2)];

  const low = [];
  const high = [];

  events.forEach(e => (e.centroid < split ? low : high).push(e));

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
      changes.push({ time: times[i], bpm });
      last = bpm;
    }
  }

  return changes;
}

/* ============================
   VISUALIZATION
============================ */
function resizeCanvas() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
}

function drawWaveform(samples) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#38bdf8";
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
function drawBeatOverlay(events, downbeats) {
  const duration = events[events.length - 1].time;

  events.forEach(e => {
    const x = (e.time / duration) * canvas.width;

    const isDownbeat = downbeats.includes(e);

    ctx.strokeStyle = isDownbeat ? "#f87171" : "#22c55e";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  });
}
