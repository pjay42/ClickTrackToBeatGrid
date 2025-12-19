(() => {
  "use strict";

  // ---------- DOM ----------
  const fileInput = document.getElementById("fileInput");
  const processBtn = document.getElementById("processBtn");
  const canvas = document.getElementById("waveform");
  const zoomEl = document.getElementById("zoom");
  const output = document.getElementById("output");

  if (!fileInput || !processBtn || !canvas || !zoomEl || !output) {
    const missing = [
      !fileInput && "fileInput",
      !processBtn && "processBtn",
      !canvas && "waveform",
      !zoomEl && "zoom",
      !output && "output",
    ].filter(Boolean);
    console.error("Missing required DOM elements:", missing.join(", "));
    return;
  }

  const ctx = canvas.getContext("2d");
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Canvas container (for positioning tooltip)
  const canvasContainer =
    canvas.parentElement && getComputedStyle(canvas.parentElement).position !== "static"
      ? canvas.parentElement
      : document.body;

  // ---------- UI: scroll range (create if missing) ----------
  let scrollEl = document.getElementById("scroll");
  if (!scrollEl) {
    scrollEl = document.createElement("input");
    scrollEl.type = "range";
    scrollEl.id = "scroll";
    scrollEl.min = "0";
    scrollEl.max = "1000";
    scrollEl.step = "1";
    scrollEl.value = "0";
    scrollEl.style.width = "100%";
    scrollEl.style.marginTop = "10px";
    // Insert right after canvas (or after wrapper div if present)
    const after = canvas.parentElement || canvas;
    after.insertAdjacentElement("afterend", scrollEl);
  }

  // ---------- UI: tooltip ----------
  const tooltip = document.createElement("div");
  tooltip.style.position = "absolute";
  tooltip.style.pointerEvents = "none";
  tooltip.style.padding = "6px 8px";
  tooltip.style.borderRadius = "8px";
  tooltip.style.background = "rgba(2, 6, 23, 0.92)";
  tooltip.style.border = "1px solid rgba(148, 163, 184, 0.35)";
  tooltip.style.color = "#e2e8f0";
  tooltip.style.fontSize = "12px";
  tooltip.style.whiteSpace = "nowrap";
  tooltip.style.display = "none";
  tooltip.style.zIndex = "9999";
  canvasContainer.appendChild(tooltip);

  // ---------- State ----------
  let audioBuffer = null;
  let samples = null;
  let sampleRate = 48000;
  let duration = 0;

  let beats = []; // chronological: { idx, time, centroid, isDownbeat, bpm }
  let tempoChanges = []; // { time, bpm } (rounded)
  let beatsPerBar = null;

  // View window (seconds)
  let viewStart = 0;
  let viewDur = 0; // computed from zoom
  let selectedBeatIdx = -1;

  // ---------- Helpers ----------
  const r3 = (x) => Math.round(x * 1000) / 1000; // time
  const r1 = (x) => Math.round(x * 10) / 10;     // bpm
  const r2 = (x) => Math.round(x * 100) / 100;   // centroid display

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function resizeCanvasToCSS() {
    const w = Math.max(300, canvas.clientWidth || canvas.parentElement?.clientWidth || 800);
    const h = Math.max(120, canvas.height || 200);
    canvas.width = w;
    canvas.height = h;
  }

  function showError(err) {
    console.error(err);
    output.textContent = String(err?.stack || err);
  }

  // Avoid Math.max(...hugeArray) (stack blowups)
  function maxAbs(arr) {
    let m = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = Math.abs(arr[i]);
      if (v > m) m = v;
    }
    return m;
  }

  // Convert stereo->mono by averaging (if needed)
  function getMonoChannel(buffer) {
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
    const a = buffer.getChannelData(0);
    const b = buffer.getChannelData(1);
    const out = new Float32Array(buffer.length);
    for (let i = 0; i < out.length; i++) out[i] = (a[i] + b[i]) * 0.5;
    return out;
  }

  // ---------- Audio load ----------
  async function decodeFile(file) {
    const data = await file.arrayBuffer();
    return await audioCtx.decodeAudioData(data);
  }

  // ---------- Click detection ----------
  function detectClicks(samples, sr) {
    // Adaptive threshold based on peak
    const peak = maxAbs(samples);
    const threshold = peak * 0.35; // tweakable
    const minGapSec = 0.08;        // tweakable (80ms)

    const clicks = [];
    let last = -Infinity;

    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v < threshold) continue;

      const t = i / sr;
      if (t - last > minGapSec) {
        clicks.push(t);
        last = t;
      }
    }
    return clicks;
  }

  // ---------- FFT / centroid ----------
  function spectralCentroidDb(freqDataDb, sr, fftSize) {
    // freqDataDb is in dBFS from AnalyserNode
    // Convert dB -> linear magnitude and compute centroid
    let weighted = 0;
    let sum = 0;

    for (let i = 0; i < freqDataDb.length; i++) {
      const db = freqDataDb[i];
      if (!Number.isFinite(db)) continue;

      // dB -> linear amplitude. Clamp very low values to avoid underflow dominating.
      const mag = Math.pow(10, db / 20);
      const freq = (i * sr) / fftSize;

      weighted += freq * mag;
      sum += mag;
    }
    return sum > 0 ? weighted / sum : 0;
  }

  async function analyzeCentroid(samples, sr, time) {
    const fftSize = 2048;
    const start = Math.floor(time * sr);

    if (start + fftSize >= samples.length) return 0;

    const offline = new OfflineAudioContext(1, fftSize, sr);
    const buf = offline.createBuffer(1, fftSize, sr);

    // Copy slice
    const slice = samples.subarray(start, start + fftSize);
    buf.copyToChannel(slice, 0);

    const src = offline.createBufferSource();
    src.buffer = buf;

    const analyser = offline.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0;

    src.connect(analyser);
    analyser.connect(offline.destination);
    src.start(0);

    await offline.startRendering();

    const freqDb = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqDb);

    return spectralCentroidDb(freqDb, sr, fftSize);
  }

  // ---------- Classification (robust k-means 2 clusters) ----------
  function kmeans2(values, iters = 12) {
    if (values.length < 2) {
      return { c1: values[0] || 0, c2: values[0] || 0, labels: values.map(() => 0) };
    }

    // init with percentiles
    const sorted = [...values].sort((a, b) => a - b);
    let c1 = sorted[Math.floor(sorted.length * 0.25)];
    let c2 = sorted[Math.floor(sorted.length * 0.75)];
    if (c1 === c2) c2 = c1 + 1;

    let labels = new Array(values.length).fill(0);

    for (let k = 0; k < iters; k++) {
      // assign
      let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const d1 = Math.abs(v - c1);
        const d2 = Math.abs(v - c2);
        const lab = d1 <= d2 ? 0 : 1;
        labels[i] = lab;
        if (lab === 0) { s1 += v; n1++; } else { s2 += v; n2++; }
      }
      // update (guard empty)
      if (n1 > 0) c1 = s1 / n1;
      if (n2 > 0) c2 = s2 / n2;
    }

    return { c1, c2, labels };
  }

  function classifyDownbeatsByCentroid(events) {
    // events: [{time, centroid}]
    const cents = events.map(e => e.centroid);
    const { c1, c2, labels } = kmeans2(cents);

    // Count each cluster; smaller count = downbeats (typical)
    let n0 = 0, n1 = 0;
    for (const lab of labels) (lab === 0 ? n0++ : n1++);

    const downLabel = (n0 <= n1) ? 0 : 1;
    const downCentroid = downLabel === 0 ? c1 : c2;
    const upCentroid = downLabel === 0 ? c2 : c1;

    // Build with isDownbeat
    const out = events.map((e, i) => ({
      ...e,
      isDownbeat: labels[i] === downLabel,
      downCentroid,
      upCentroid
    }));

    return out;
  }

  // ---------- Beats-per-bar autodetect ----------
  function autoBeatsPerBar(beatFlags) {
    // beatFlags: boolean[] isDownbeat per beat in time order
    // Choose N in [2..12] that best matches downbeats on a regular grid.
    if (beatFlags.length < 8) return null;

    let bestN = 4;
    let bestScore = -Infinity;

    for (let N = 2; N <= 12; N++) {
      // Try all offsets 0..N-1 and score alignment
      for (let offset = 0; offset < N; offset++) {
        let good = 0, bad = 0;
        for (let i = 0; i < beatFlags.length; i++) {
          const shouldBeDown = ((i - offset) % N === 0);
          if (shouldBeDown === beatFlags[i]) good++;
          else bad++;
        }
        const score = good - bad * 1.2;
        if (score > bestScore) {
          bestScore = score;
          bestN = N;
        }
      }
    }
    return bestN;
  }

  // ---------- Tempo (per click) + change segmentation ----------
  function computeBpmPerClick(clickTimes) {
    // bpm for beat i computed from delta(i-1 -> i). For i=0, copy i=1 later.
    const bpm = new Array(clickTimes.length).fill(0);
    for (let i = 1; i < clickTimes.length; i++) {
      const dt = clickTimes[i] - clickTimes[i - 1];
      bpm[i] = dt > 0 ? (60 / dt) : 0;
    }
    if (clickTimes.length > 1) bpm[0] = bpm[1];
    return bpm;
  }

  function segmentTempo(clickTimes, bpmPerClick, toleranceBpm = 1.0) {
    const changes = [];
    let last = null;

    for (let i = 0; i < clickTimes.length; i++) {
      const b = bpmPerClick[i];
      if (!Number.isFinite(b) || b <= 0) continue;
      if (last == null || Math.abs(b - last) > toleranceBpm) {
        changes.push({ time: clickTimes[i], bpm: b });
        last = b;
      }
    }
    return changes;
  }

  // ---------- Waveform drawing (windowed) ----------
  function drawWaveformWindow(samples, sr, startSec, durSec) {
    resizeCanvasToCSS();

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // background baseline
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#1e293b";
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    const startIdx = Math.floor(startSec * sr);
    const endIdx = Math.min(samples.length, Math.floor((startSec + durSec) * sr));
    const span = Math.max(1, endIdx - startIdx);
    const samplesPerPixel = span / W;

    ctx.strokeStyle = "#38bdf8";
    ctx.globalAlpha = 0.95;
    ctx.beginPath();

    for (let x = 0; x < W; x++) {
      const i0 = startIdx + Math.floor(x * samplesPerPixel);
      const i1 = startIdx + Math.floor((x + 1) * samplesPerPixel);

      // min/max within this pixel column
      let min = 1, max = -1;
      for (let i = i0; i < i1 && i < samples.length; i++) {
        const v = samples[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }

      const y1 = (1 - (max + 1) / 2) * H;
      const y2 = (1 - (min + 1) / 2) * H;

      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function timeToX(t) {
    // map time to x within current window
    return ((t - viewStart) / viewDur) * canvas.width;
  }

  function xToTime(x) {
    return viewStart + (x / canvas.width) * viewDur;
  }

  // ---------- Beat overlay ----------
  function drawBeatsOverlay() {
    if (!beats.length) return;

    // Draw downbeats and beats as vertical lines
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b.time < viewStart || b.time > viewStart + viewDur) continue;

      const x = timeToX(b.time);

      // color: downbeat vs beat
      ctx.strokeStyle = b.isDownbeat ? "#fbbf24" : "#a78bfa";
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();

      // small marker near bottom
      ctx.fillStyle = b.isDownbeat ? "#fbbf24" : "#a78bfa";
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(x, canvas.height - 10, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Selected beat highlight
    if (selectedBeatIdx >= 0 && selectedBeatIdx < beats.length) {
      const b = beats[selectedBeatIdx];
      if (b.time >= viewStart && b.time <= viewStart + viewDur) {
        const x = timeToX(b.time);
        ctx.strokeStyle = "#22c55e";
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    ctx.globalAlpha = 1;
  }

  function redrawAll() {
    if (!samples) return;
    drawWaveformWindow(samples, sampleRate, viewStart, viewDur);
    drawBeatsOverlay();
  }

  // ---------- Beat picking ----------
  function findNearestBeatAtX(x, pxTolerance = 8) {
    if (!beats.length) return -1;
    const t = xToTime(x);

    // Binary search for nearest time (beats are chronological)
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (beats[mid].time < t) lo = mid + 1;
      else hi = mid;
    }

    const candidates = [lo, lo - 1, lo + 1].filter(i => i >= 0 && i < beats.length);
    let best = -1;
    let bestDx = Infinity;

    for (const i of candidates) {
      const bx = timeToX(beats[i].time);
      const dx = Math.abs(bx - x);
      if (dx < bestDx) { bestDx = dx; best = i; }
    }

    return bestDx <= pxTolerance ? best : -1;
  }

  function showTooltipForBeat(idx, clientX, clientY) {
    if (idx < 0 || idx >= beats.length) {
      tooltip.style.display = "none";
      return;
    }
    const b = beats[idx];
    tooltip.innerHTML =
      `t: <b>${r3(b.time)}</b>s&nbsp;&nbsp;` +
      `BPM: <b>${r1(b.bpm)}</b>&nbsp;&nbsp;` +
      `centroid: <b>${r2(b.centroid)}</b>&nbsp;&nbsp;` +
      `downbeat: <b>${b.isDownbeat ? "true" : "false"}</b>`;

    tooltip.style.display = "block";

    // Position relative to container
    const rect = canvas.getBoundingClientRect();
    const containerRect = canvasContainer.getBoundingClientRect();
    const x = clientX - containerRect.left + 10;
    const y = clientY - containerRect.top + 10;

    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  // ---------- Output ----------
  function renderOutput() {
    const beatsOut = beats.map(b => ({
      idx: b.idx,
      time: r3(b.time),
      bpm: r1(b.bpm),
      centroid: r2(b.centroid),
      downbeat: b.isDownbeat
    }));

    const tempoOut = tempoChanges.map(c => ({
      time: r3(c.time),
      bpm: r1(c.bpm)
    }));

    const payload = {
      durationSec: r3(duration),
      beatsDetected: beats.length,
      beatsPerBar: beatsPerBar ?? null,
      tempoChanges: tempoOut,
      beats: beatsOut
    };

    output.textContent = JSON.stringify(payload, null, 2);
  }

  // ---------- Controls ----------
  function updateViewFromControls() {
    if (!audioBuffer) return;

    const zoomFactor = Number(zoomEl.value || 1);
    // Window duration: full duration / zoomFactor, but clamp to at least 1s
    viewDur = clamp(duration / zoomFactor, 1, duration);

    // Scroll range maps to [0 .. duration - viewDur]
    const maxStart = Math.max(0, duration - viewDur);
    const raw = Number(scrollEl.value || 0);
    const denom = Math.max(1, Number(scrollEl.max || 1000));
    viewStart = (raw / denom) * maxStart;

    redrawAll();
  }

  zoomEl.addEventListener("input", () => {
    // Preserve center time when zoom changes
    if (!audioBuffer) return;
    const center = viewStart + viewDur * 0.5;

    const zoomFactor = Number(zoomEl.value || 1);
    const newDur = clamp(duration / zoomFactor, 1, duration);
    const maxStart = Math.max(0, duration - newDur);

    viewStart = clamp(center - newDur * 0.5, 0, maxStart);
    viewDur = newDur;

    // Update scroll slider to match new viewStart
    const denom = Math.max(1, Number(scrollEl.max || 1000));
    scrollEl.value = String(Math.round((viewStart / maxStart) * denom) || 0);

    redrawAll();
  });

  scrollEl.addEventListener("input", updateViewFromControls);

  // Canvas hover/click handlers
  canvas.addEventListener("mousemove", (e) => {
    if (!beats.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    const idx = findNearestBeatAtX(x, 10);
    showTooltipForBeat(idx, e.clientX, e.clientY);
  });

  canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });

  canvas.addEventListener("click", (e) => {
    if (!beats.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    const idx = findNearestBeatAtX(x, 10);
    if (idx !== -1) {
      selectedBeatIdx = idx;
      redrawAll();
      // Optional: also scroll output to that beat by re-render (keeps it simple)
      renderOutput();
    }
  });

  // ---------- Main analyze ----------
  processBtn.addEventListener("click", async () => {
    try {
      if (!fileInput.files || !fileInput.files.length) return;

      tooltip.style.display = "none";
      selectedBeatIdx = -1;

      // Required for Safari/Chrome autoplay policies
      await audioCtx.resume();

      const file = fileInput.files[0];
      audioBuffer = await decodeFile(file);

      sampleRate = audioBuffer.sampleRate;
      duration = audioBuffer.duration;

      // Use mono samples for analysis & drawing
      samples = getMonoChannel(audioBuffer);

      // Initialize view
      resizeCanvasToCSS();
      viewStart = 0;
      viewDur = clamp(duration / Number(zoomEl.value || 1), 1, duration);

      // Configure scroll slider
      scrollEl.min = "0";
      scrollEl.max = "1000";
      scrollEl.step = "1";
      scrollEl.value = "0";

      // Detect click times
      const clickTimes = detectClicks(samples, sampleRate);

      // Analyze centroid for each click
      const events = [];
      for (let i = 0; i < clickTimes.length; i++) {
        const t = clickTimes[i];
        const centroid = await analyzeCentroid(samples, sampleRate, t);
        events.push({ time: t, centroid });
      }

      // Tempo per click and change segmentation
      const bpmPerClick = computeBpmPerClick(clickTimes);
      tempoChanges = segmentTempo(clickTimes, bpmPerClick, 1.0);

      // Classify downbeats by centroid clustering
      const classified = classifyDownbeatsByCentroid(events);

      // Beats-per-bar autodetect (best-fit grid)
      const flags = classified.map(e => e.isDownbeat);
      beatsPerBar = autoBeatsPerBar(flags);

      // Build chronological beats list with bpm
      beats = classified.map((e, idx) => ({
        idx,
        time: e.time,
        centroid: e.centroid,
        isDownbeat: e.isDownbeat,
        bpm: bpmPerClick[idx] || 0
      }));

      // Draw
      redrawAll();
      renderOutput();
    } catch (err) {
      showError(err);
    }
  });

  // Redraw on resize
  window.addEventListener("resize", () => {
    if (!samples) return;
    redrawAll();
  });
})();
