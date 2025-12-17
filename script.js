const audioCtx = new AudioContext();
const fileInput = document.getElementById("fileInput");
const analyzeBtn = document.getElementById("analyze");
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");
const output = document.getElementById("output");

analyzeBtn.addEventListener("click", async () => {
  if (!fileInput.files.length) return;

  // REQUIRED for Chrome / Safari
  await audioCtx.resume();

  const file = fileInput.files[0];
  const buffer = await decode(file);
  const samples = buffer.getChannelData(0);
  const sr = buffer.sampleRate;

  resizeCanvas();
  drawWaveform(samples);

  const clicks = detectClicks(samples, sr);

  const analyzed = [];
  for (const time of clicks) {
    const freq = await analyzeFFT(samples, sr, time);
    analyzed.push({ time, freq });
  }

  const { downbeats, beats } = classify(analyzed);
  const tempoChanges = detectTempo(clicks);

  output.textContent = JSON.stringify(
    { downbeats, beats, tempoChanges },
    null,
    2
  );
});

async function decode(file) {
  const data = await file.arrayBuffer();
  return audioCtx.decodeAudioData(data);
}

function detectClicks(samples, sr) {
  const threshold = 0.4;
  const minGap = 0.05;
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

async function analyzeFFT(samples, sr, time) {
  const length = 2048;
  const start = Math.floor(time * sr);
  const slice = samples.slice(start, start + length);

  const offline = new OfflineAudioContext(1, length, sr);
  const buffer = offline.createBuffer(1, slice.length, sr);
  buffer.copyToChannel(slice, 0);

  const src = offline.createBufferSource();
  const analyser = offline.createAnalyser();
  analyser.fftSize = length;

  src.buffer = buffer;
  src.connect(analyser);
  analyser.connect(offline.destination);
  src.start();

  await offline.startRendering();

  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(data);

  let max = -Infinity;
  let index = 0;

  for (let i = 0; i < data.length; i++) {
    if (data[i] > max) {
      max = data[i];
      index = i;
    }
  }

  return index * (sr / length);
}

function classify(events) {
  const freqs = events.map(e => e.freq).sort((a,b)=>a-b);
  const split = freqs[Math.floor(freqs.length / 2)];

  const low = [];
  const high = [];

  events.forEach(e => (e.freq < split ? low : high).push(e));

  return low.length < high.length
    ? { downbeats: low, beats: high }
    : { downbeats: high, beats: low };
}

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
