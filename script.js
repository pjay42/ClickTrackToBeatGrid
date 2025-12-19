(() => {
  "use strict";

  // ===== DOM =====
  const fileInput = document.getElementById("fileInput");
  const processBtn = document.getElementById("processBtn");
  const canvas = document.getElementById("waveform");
  const zoomEl = document.getElementById("zoom");
  const output = document.getElementById("output");

  if (!fileInput || !processBtn || !canvas || !zoomEl || !output) {
    console.error("Missing required DOM elements:", {
      fileInput: !!fileInput,
      processBtn: !!processBtn,
      waveform: !!canvas,
      zoom: !!zoomEl,
      output: !!output,
    });
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.error("Canvas 2D context unavailable.");
    return;
  }

  // If you don’t have a scroll input, we create one and place it right under the canvas.
  let scrollEl = document.getElementById("scroll");
  if (!scrollEl) {
    scrollEl = document.createElement("input");
    scrollEl.type = "range";
    scrollEl.id = "scroll";
    scrollEl.min = "0";
    scrollEl.max = "0";
    scrollEl.step = "1";
    scrollEl.value = "0";
    scrollEl.style.width = "100%";
    scrollEl.style.marginTop = "10px";
    scrollEl.title = "Scroll";
    canvas.parentElement?.appendChild(scrollEl);
  }

  // ===== Audio Context =====
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // ===== State =====
  let audioBuffer = null;
  let samples = null;
  let sampleRate = 44100;

  // beats: { time, centroid, isDownbeat, bpm? ... }
  let beats = [];
  let selectedBeatIndex = -1;

  // View window state
  let viewStartSec = 0;         // start time of viewport
  let viewDurSec = 0;           // duration of viewport
  let totalDurSec = 0;

  // For click picking: store marker x positions for current view
  let markerXs = []; // array of { idx, x, time }

  // ===== Utilities =====
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmtTime = (t) => Number(t.toFixed(3));
  const fmtBpm = (b) => Number(b.toFixed(1));

  function resizeCanvasToDisplaySize() {
    // Canvas CSS can differ from actual resolution; sync for crisp drawing
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }

  // Avoid spread on huge arrays (prevents "Maximum call stack size exceeded")
  function arrayMaxAbs(floatArray) {
    let m = 0;
    for (let i = 0; i < floatArray.length; i++) {
      const a = Math.abs(floatArray[i]);
      if (a > m) m = a;
    }
    return m;
  }

  function kmeans2(values, maxIter = 30) {
    // Simple 1D kmeans for two clusters
    if (!values.length) return { c0: [], c1: [], m0: 0, m1: 0 };

    const sorted = [...values].sort((a, b) => a - b);
    let m0 = sorted[Math.floor(sorted.length * 0.25)];
    let m1 = sorted[Math.floor(sorted.length * 0.75)];
    if (m0 === m1) m1 = m0 + 1e-6;

    let assign = new Array(values.length).fill(0);

    for (let it = 0; it < maxIter; it++) {
      let changed = false;

      // assign
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const a0 = Math.abs(v - m0);
        const a1 = Math.abs(v - m1);
        const k = a0 <= a1 ? 0 : 1;
        if (assign[i] !== k) {
          assign[i] = k;
          changed = true;
        }
      }

      // update means
      let s0 = 0, n0 = 0, s1 = 0, n1 = 0;
      for (let i = 0; i < values.length; i++) {
        if (assign[i] === 0) { s0 += values[i]; n0++; }
        else { s1 += values[i]; n1++; }
      }
      const nm0 = n0 ? s0 / n0 : m0;
      const nm1 = n1 ? s1 / n1 : m1;

      if (Math.abs(nm0 - m0) < 1e-6 && Math.abs(nm1 - m1) < 1e-6 && !changed) break;
      m0 = nm0; m1 = nm1;
    }

    const c0 = [], c1 = [];
    for (let i = 0; i < values.length; i++) {
      (assign[i] === 0 ? c0 : c1).push(i);
    }
    return { c0, c1, m0, m1 };
  }

  // ===== Core: Decode =====
  async function decode(file) {
    const data = await file.arrayBuffer();
    return audioCtx.decodeAudioData(data);
  }

  // ===== Core: Click detection =====
  function detectClicks(samples, sr) {
    // adaptive threshold from max abs
    const max = arrayMaxAbs(samples);
    const threshold = max * 0.35;
    const minGap = 0.08; // seconds

    const clicks = [];
    let last = -Infinity;

    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      const t = i / sr;
      if (v > threshold && (t - last) > minGap) {
        clicks.push(t);
        last = t;
      }
    }
    return clicks;
  }

  // ===== Core: Spectral centroid =====
  function spectralCentroidFromDb(freqDb, sr, fftSize) {
    // freqDb is Float32Array in dB (negative values usually)
    // Convert to linear magnitude; clamp extreme values to avoid everything going huge.
    let weighted = 0;
    let sum = 0;

    for (let i = 0; i < freqDb.length; i++) {
      const db = freqDb[i];
      if (!isFinite(db)) continue;

      // Clamp floor to reduce numerical weirdness
      const clampedDb = Math.max(db, -120);
      const mag = Math.pow(10, clampedDb / 20); // dB -> linear amplitude
      const freq = (i * sr) / fftSize;

      weighted += freq * mag;
      sum += mag;
    }

    return sum ? (weighted / sum) : 0;
  }

  async function analyzeCentroid(samples, sr, timeSec) {
    const fftSize = 2048;
    const start = Math.floor(timeSec * sr);
    if (start + fftSize >= samples.length) return 0;

    // Copy window
    const window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      window[i] = samples[start + i] || 0;
    }

    // Offline render so we can use AnalyserNode for FFT reliably
    const offline = new OfflineAudioContext(1, fftSize, sr);
    const buf = offline.createBuffer(1, fftSize, sr);
    buf.copyToChannel(window, 0);

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

    return spectralCentroidFromDb(freqDb, sr, fftSize);
  }

  // ===== Core: Tempo (basic change list) =====
  function detectTempoChanges(clickTimes, toleranceBpm = 1) {
    const changes = [];
    let last = null;

    for (let i = 1; i < clickTimes.length; i++) {
      const dt = clickTimes[i] - clickTimes[i - 1];
      if (dt <= 0) continue;

      const bpm = 60 / dt;
      if (last === null || Math.abs(bpm - last) > toleranceBpm) {
        changes.push({ time: clickTimes[i], bpm });
        last = bpm;
      }
    }
    return changes;
  }

  // ===== Classification (centroid-based, kmeans2) =====
  function classifyDownbeatsByCentroid(events) {
    // events: [{time, centroid}]
    const cents = events.map(e => e.centroid);
    const { c0, c1 } = kmeans2(cents);

    // Decide which cluster is downbeats:
    // Default: smaller cluster -> downbeats (typical 1 per bar).
    // Fallback: if sizes are similar, use higher centroid as downbeats (common in some click tracks).
    const n0 = c0.length, n1 = c1.length;

    let downCluster = 0;
    if (Math.abs(n0 - n1) <= Math.max(2, Math.floor(events.length * 0.02))) {
      // sizes similar -> use centroid mean rule
      const mean0 = c0.reduce((s, i) => s + cents[i], 0) / (n0 || 1);
      const mean1 = c1.reduce((s, i) => s + cents[i], 0) / (n1 || 1);
      downCluster = mean0 >= mean1 ? 0 : 1;
    } else {
      downCluster = n0 < n1 ? 0 : 1;
    }

    const downSet = new Set((downCluster === 0 ? c0 : c1));
    return events.map((e, idx) => ({
      ...e,
      isDownbeat: downSet.has(idx),
    }));
  }

  // ===== Viewport / Zoom / Scroll =====
  function updateViewport() {
    if (!audioBuffer) return;

    totalDurSec = audioBuffer.duration;

    const zoom = Number(zoomEl.value || 1); // 1..20
    // At zoom=1 show entire file; at zoom=20 show 1/20 of file
    viewDurSec = totalDurSec / zoom;
    viewDurSec = clamp(viewDurSec, 0.25, totalDurSec);

    // scroll range maps to start time (0..totalDur-viewDur)
    const maxStart = Math.max(0, totalDurSec - viewDurSec);

    // We use scrollEl as integer steps (0..1000) for stable movement
    const steps = 1000;
    scrollEl.max = String(steps);
    const s = Number(scrollEl.value || 0) / steps;
    viewStartSec = s * maxStart;

    redraw();
  }

  // Keep scroll stable while zooming:
  function onZoomChange() {
    if (!audioBuffer) return;

    // preserve center time while zooming
    const prevDur = viewDurSec || audioBuffer.duration;
    const center = viewStartSec + prevDur / 2;

    const zoom = Number(zoomEl.value || 1);
    const newDur = clamp(audioBuffer.duration / zoom, 0.25, audioBuffer.duration);
    const maxStart = Math.max(0, audioBuffer.duration - newDur);

    const newStart = clamp(center - newDur / 2, 0, maxStart);
    viewDurSec = newDur;
    viewStartSec = newStart;

    // update scroll value to match newStart
    const steps = Number(scrollEl.max || 1000);
    const ratio = maxStart > 0 ? (newStart / maxStart) : 0;
    scrollEl.value = String(Math.round(ratio * steps));

    redraw();
  }

  function onScrollChange() {
    if (!audioBuffer) return;
    // update start from scroll without jumping
    const steps = Number(scrollEl.max || 1000);
    const s = steps > 0 ? (Number(scrollEl.value || 0) / steps) : 0;

    const maxStart = Math.max(0, audioBuffer.duration - viewDurSec);
    viewStartSec = s * maxStart;

    redraw();
  }

  // ===== Waveform + Overlay drawing =====
  function redraw() {
    if (!samples || !audioBuffer) return;

    resizeCanvasToDisplaySize();

    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    // background
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, W, H);

    drawWaveformWindow(W, H);
    drawBeatOverlay(W, H);
  }

  function drawWaveformWindow(W, H) {
    // Draw only visible window
    const startSamp = Math.floor(viewStartSec * sampleRate);
    const endSamp = Math.min(samples.length, Math.floor((viewStartSec + viewDurSec) * sampleRate));
    const windowLen = Math.max(1, endSamp - startSamp);

    // Downsample to pixel columns
    const mid = H / 2;
    const cols = Math.max(1, Math.floor(W));
    const step = Math.max(1, Math.floor(windowLen / cols));

    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let x = 0; x < cols; x++) {
      const i0 = startSamp + x * step;
      if (i0 >= endSamp) break;

      // min/max peak in this column for nicer waveform
      let min = 1, max = -1;
      const i1 = Math.min(endSamp, i0 + step);
      for (let i = i0; i < i1; i++) {
        const v = samples[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }

      // draw line from max to min (vertical)
      const y1 = mid + max * mid;
      const y2 = mid + min * mid;

      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }

    ctx.stroke();

    // viewport info
    ctx.fillStyle = "rgba(226,232,240,0.85)";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(
      `View: ${fmtTime(viewStartSec)}s → ${fmtTime(viewStartSec + viewDurSec)}s  (zoom ${zoomEl.value}x)`,
      10,
      18
    );
  }

  function timeToX(t, W) {
    const p = (t - viewStartSec) / viewDurSec;
    return p * W;
  }

  function drawBeatOverlay(W, H) {
    markerXs = [];

    // Draw beat markers that fall in view
    const t0 = viewStartSec;
    const t1 = viewStartSec + viewDurSec;

    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b.time < t0 || b.time > t1) continue;

      const x = timeToX(b.time, W);
      markerXs.push({ idx: i, x, time: b.time });

      // marker
      ctx.beginPath();
      ctx.lineWidth = (i === selectedBeatIndex) ? 2 : 1;
      ctx.strokeStyle = b.isDownbeat ? "#fbbf24" : "#a78bfa"; // downbeat = amber, beat = purple
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }

    // selected label
    if (selectedBeatIndex >= 0 && selectedBeatIndex < beats.length) {
      const b = beats[selectedBeatIndex];
      ctx.fillStyle = "rgba(2,6,23,0.8)";
      ctx.fillRect(10, H - 38, 340, 28);
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(
        `Selected: t=${fmtTime(b.time)}s  centroid=${b.centroid.toFixed(2)}  downbeat=${b.isDownbeat ? "true" : "false"} (Shift+Click toggles)`,
        18,
        H - 20
      );
    }
  }

  // ===== Click picking =====
  function pickNearestMarker(xCss) {
    // xCss is in CSS pixels (not DPR scaled)
    if (!markerXs.length) return -1;

    // Find nearest marker by x
    let best = -1;
    let bestDx = Infinity;

    for (const m of markerXs) {
      const dx = Math.abs(m.x - xCss);
      if (dx < bestDx) {
        bestDx = dx;
        best = m.idx;
      }
    }

    // Only select if close enough (in px)
    const PICK_RADIUS = 8;
    if (bestDx <= PICK_RADIUS) return best;
    return -1;
  }

  canvas.addEventListener("click", (ev) => {
    if (!beats.length) return;

    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;

    const idx = pickNearestMarker(x);
    if (idx === -1) return;

    // Shift+Click toggles downbeat flag
    if (ev.shiftKey) {
      beats[idx].isDownbeat = !beats[idx].isDownbeat;
    }

    selectedBeatIndex = idx;
    renderOutput(); // show selection + overall summary
    redraw();
  });

  // ===== Output =====
  function renderOutput() {
    const tempoChanges = detectTempoChanges(beats.map(b => b.time));
    const selected =
      selectedBeatIndex >= 0 && selectedBeatIndex < beats.length
        ? beats[selectedBeatIndex]
        : null;

    // Keep output readable + rounded
    const payload = {
      summary: {
        totalBeats: beats.length,
        downbeats: beats.filter(b => b.isDownbeat).length,
        durationSec: fmtTime(totalDurSec),
      },
      selectedBeat: selected
        ? {
            index: selectedBeatIndex,
            time: fmtTime(selected.time),
            centroid: Number(selected.centroid.toFixed(2)),
            downbeat: !!selected.isDownbeat,
          }
        : null,
      tempoChanges: tempoChanges.map(t => ({
        time: fmtTime(t.time),
        bpm: fmtBpm(t.bpm),
      })),
      beats: beats.map(b => ({
        time: fmtTime(b.time),
        centroid: Number(b.centroid.toFixed(2)),
        downbeat: !!b.isDownbeat,
      })),
    };

    output.textContent = JSON.stringify(payload, null, 2);
  }

  // ===== Analyze pipeline =====
  processBtn.addEventListener("click", async () => {
    try {
      if (!fileInput.files.length) return;

      // Required for Safari/Chrome autoplay policies
      await audioCtx.resume();

      processBtn.disabled = true;
      output.textContent = "Analyzing…";

      audioBuffer = await decode(fileInput.files[0]);
      sampleRate = audioBuffer.sampleRate;

      // Use mono channel 0
      samples = audioBuffer.getChannelData(0);
      totalDurSec = audioBuffer.duration;

      // Initialize viewport + controls
      zoomEl.value = zoomEl.value || "1";
      scrollEl.value = "0";

      // Detect clicks
      const clickTimes = detectClicks(samples, sampleRate);

      // Analyze centroids (async per click)
      const events = [];
      for (let i = 0; i < clickTimes.length; i++) {
        const t = clickTimes[i];
        const centroid = await analyzeCentroid(samples, sampleRate, t);
        events.push({ time: t, centroid });
      }

      // classify
      beats = classifyDownbeatsByCentroid(events).map(b => ({
        ...b,
        time: b.time,
        centroid: b.centroid,
        isDownbeat: b.isDownbeat,
      }));

      selectedBeatIndex = -1;

      // Setup scroll to use 0..1000 and update viewport
      scrollEl.max = "1000";
      scrollEl.value = "0";
      viewStartSec = 0;
      updateViewport();
      renderOutput();

    } catch (err) {
      console.error(err);
      output.textContent = `Error: ${err?.message || String(err)}`;
    } finally {
      processBtn.disabled = false;
    }
  });

  // ===== Controls =====
  zoomEl.addEventListener("input", onZoomChange);
  scrollEl.addEventListener("input", onScrollChange);
  window.addEventListener("resize", () => redraw());
})();
