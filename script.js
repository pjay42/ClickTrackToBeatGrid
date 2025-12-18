document.addEventListener("DOMContentLoaded", () => {

  const audioCtx = new AudioContext();

  const fileInput = document.getElementById("fileInput");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const canvas = document.getElementById("waveform");
  const ctx = canvas.getContext("2d");
  const output = document.getElementById("output");

  analyzeBtn.addEventListener("click", async () => {
    if (!fileInput.files.length) return;

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
      const centroid = await analyzeFFT(samples, sr, time);
      analyzed.push({ time, centroid });
    }

    const { downbeats, beats } = classify(analyzed);
    const tempoChanges = detectTempo(clicks);

    drawBeatOverlay(downbeats, beats, buffer.duration);

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
      const freq = i * sampleRate / fftSize;

      weightedSum += freq * mag;
      magnitudeSum += mag;
    }
    return magnitudeSum ? weightedSum / magnitudeSum : 0;
  }

  function classify(events) {
    const values = events.map(e => e.centroid).sort((a,b)=>a-b);
    const split = values[Math.floor(values.length / 2)];

    const low = [];
    const high = [];

    events.forEach(e => (e.centroid < split ? low : high).push(e));

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

  // 🔥 VISUAL OVERLAY
  function drawBeatOverlay(downbeats, beats, duration) {
    const h = canvas.height;

    downbeats.forEach(b => {
      const x = (b.time / duration) * canvas.width;
      ctx.strokeStyle = "#ef4444"; // red
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    });

    beats.forEach(b => {
      const x = (b.time / duration) * canvas.width;
      ctx.strokeStyle = "#22d3ee"; // cyan
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    });
  }

});
