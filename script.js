const audioCtx = new AudioContext();
const fileInput = document.getElementById("fileInput");
const analyzeBtn = document.getElementById("processBtn");
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");
const output = document.getElementById("output");

analyzeBtn.addEventListener("click", async () => {
  try {
    if (!fileInput.files.length) return;

    await audioCtx.resume();

    const file = fileInput.files[0];
    const buffer = await decode(file);
    const samples = buffer.getChannelData(0);
    const sr = buffer.sampleRate;

    resizeCanvas();
    drawWaveform(samples);

    const clicks = detectClicks(samples, sr);
    if (!clicks.length) {
      output.textContent = "No clicks detected.";
      return;
    }

    const analyzed = clicks.map(time => ({
      time,
      freq: analyzeFFT(samples, sr, time)
    }));

    const { downbeats, beats } = classify(analyzed);
    const tempoChanges = detectTempo(clicks);

    output.textContent = JSON.stringify(
      { downbeats, beats, tempoChanges },
      null,
      2
    );

  } catch (err) {
    console.error(err);
    output.textContent = "Error: " + err.message;
  }
});

/* ---------------- AUDIO ---------------- */

async function decode(file) {
  const data = await file.arrayBuffer();
  return audioCtx.decodeAudioData(data);
}

/* ---------------- CLICK DETECTION ---------------- */

function detectClicks(samples, sr) {
  let max = 0;

  // FAST peak scan (no allocations)
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

/* ---------------- FFT / SPECTRAL CENTROID ---------------- */

function analyzeFFT(samples, sr, time) {
  const size = 2048;
  const start = Math.floor(time * sr);

  if (start + size >= samples.length) return 0;

  // Windowed slice
  let weightedSum = 0;
  let magSum = 0;

  for (let i = 0; i < size / 2; i++) {
    const sample = samples[start + i];
    const mag = Math.abs(sample);
    const freq = (i * sr) / size;

    weightedSum += freq * mag;
    magSum += mag;
  }

  return magSum ? weightedSum / magSum : 0;
}

/* ---------------- CLASSIFICATION ---------------- */

function classify(events) {
  const freqs = events.map(e => e.freq).sort((a, b) => a - b);
  const split = freqs[Math.floor(freqs.length / 2)];

  const low = [];
  const high = [];

  events.forEach(e => (e.freq < split ? low : high).push(e));

  return low.length < high.length
    ? { downbeats: low, beats: high }
    : { downbeats: high, beats: low };
}

/* ---------------- TEMPO ---------------- */

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

/* ---------------- VISUALS ---------------- */

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
