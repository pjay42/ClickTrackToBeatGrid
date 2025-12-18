(() => {
  "use strict";

  // ---------- DOM ----------
  const fileInput = document.getElementById("fileInput");
  const processBtn = document.getElementById("processBtn");
  const canvas = document.getElementById("waveform");
  const zoomEl = document.getElementById("zoom");
  const output = document.getElementById("output");

  const missing = [];
  if (!fileInput) missing.push("fileInput");
  if (!processBtn) missing.push("processBtn");
  if (!canvas) missing.push("waveform");
  if (!zoomEl) missing.push("zoom");
  if (!output) missing.push("output");
  if (missing.length) {
    console.error("Missing required DOM elements:", missing.join(", "));
    return;
  }

  // Create a bottom scrollbar if user didn't add one
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
    scrollEl.style.marginTop = "8px";
    canvas.insertAdjacentElement("afterend", scrollEl);
  }

  const ctx = canvas.getContext("2d", { alpha: false });

  // ---------- Audio ----------
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // ---------- State ----------
  let audioBuffer = null;
  let samples = null;
  let sampleRate = 44100;

  // viewport in samples
  let viewStart = 0;         // sample index
  let viewLen = 0;           // sample count
  let zoom = Number(zoomEl.value) || 1;

  // analysis results
  let clicks = [];           // [{time, sampleIndex, centroid}]
  let classification = null; // { beatsPerBar, downbeats, beats, tempoSegments }

  // ---------- Helpers ----------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const r1 = (x) => Math.round(x * 10) / 10;

  function setStatus(text) {
    output.textContent = text;
  }

  function setError(err) {
    console.error(err);
    output.textContent = String(err?.message || err);
  }

  function ensureCanvasSize() {
    // Keep canvas drawing buffer in sync with its CSS size for sharp rendering.
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 800;
    const cssH = canvas.clientHeight || 200;
    const w = Math.floor(cssW * dpr);
    const h = Math.floor(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function updateViewport() {
    if (!samples) return;

    zoom = Number(zoomEl.value) || 1;
    zoom = clamp(zoom, 1, 200);

    // Show 1/zoom of the file in the viewport (with a cap for usability)
    const total = samples.length;

    // Minimum visible window: ~0.25s
    const minLen = Math.max(1, Math.floor(sampleRate * 0.25));
    const targetLen = Math.floor(total / zoom);
    viewLen = clamp(targetLen, minLen, total);

    // clamp start
    viewStart = clamp(viewStart, 0, total - viewLen);

    // Update scrollbar range *in samples*.
    // We use 0..(total-viewLen) mapped to 0..100000 for smoothness.
    const maxStart = Math.max(0, total - viewLen);
    const rangeMax = 100000;

    // Preserve relative position (prevents “jump to end” when zoom changes)
    const prevMaxStart = Number(scrollEl.dataset.maxStart || maxStart);
    const prevValue = Number(scrollEl.value || 0);

    // Convert previous slider -> previous start ratio
    const prevRatio = prevMaxStart > 0 ? (prevValue / rangeMax) : 0;

    scrollEl.dataset.maxStart = String(maxStart);
    scrollEl.max = String(rangeMax);

    // If user isn't actively dragging, keep their relative position.
    if (!scrollEl.dataset.dragging) {
      const newVal = Math.round(prevRatio * rangeMax);
      scrollEl.value = String(clamp(newVal, 0, rangeMax));
      viewStart = Math.round(prevRatio * maxStart);
    } else {
      // if dragging, trust viewStart derived from slider
      const ratio = Number(scrollEl.value) / rangeMax;
      viewStart = Math.round(ratio * maxStart);
    }
  }

  function sliderToViewStart() {
    if (!samples) return;
    const maxStart = Math.max(0, samples.length - viewLen);
    const rangeMax = Number(scrollEl.max) || 100000;
    const ratio = rangeMax > 0 ? Number(scrollEl.value) / rangeMax : 0;
    viewStart = Math.round(ratio * maxStart);
  }

  // ---------- Waveform drawing ----------
  function draw() {
    if (!samples) return;
    ensureCanvasSize();
    updateViewport();

    const W = canvas.width;
    const H = canvas.height;
    const mid = H / 2;

    // Background
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, W, H);

    // Waveform
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1;
    ctx.beginPath();

    const start = viewStart;
    const end = viewStart + viewLen;

    // Downsample: one column per x pixel
    const step = Math.max(1, Math.floor(viewLen / W));

    for (let x = 0; x < W; x++) {
      const s0 = start + x * step;
      if (s0 >= end) break;

      // min/max envelope within this column
      let min = 1, max = -1;
      const s1 = Math.min(s0 + step, end);
      for (let i = s0; i < s1; i++) {
        const v = samples[i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }

      const y1 = mid + min * mid;
      const y2 = mid + max * mid;

      // draw a vertical line segment for envelope
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
    ctx.stroke();

    // Overlay beats/downbeats
    if (clicks?.length) {
      const viewStartTime = start / sampleRate;
      const viewEndTime = end / sampleRate;

      // beats
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1;

      for (const c of clicks) {
        if (c.time < viewStartTime || c.time > viewEndTime) continue;
        const x = ((c.time - viewStartTime) / (viewEndTime - viewStartTime)) * W;

        const isDown = classification?.downbeatsSet?.has(c.sampleIndex);

        ctx.strokeStyle = isDown ? "#f59e0b" : "#94a3b8"; // downbeat amber, others gray
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, H);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
    }
  }

  // ---------- Click detection ----------
  function detectClicksAdaptive(samples, sr) {
    // Avoid Math.max(...bigArray) stack overflow.
    // Use peak-based adaptive threshold from sampled absolute amplitude.
    let peak = 0;
    const n = samples.length;
    const stride = Math.max(1, Math.floor(n / 200000)); // sample up to ~200k points
    for (let i = 0; i < n; i += stride) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }

    const threshold = peak * 0.35; // adjust if needed
    const minGapSec = 0.08;        // 80ms guard against double-triggers
    const minGap = Math.floor(minGapSec * sr);

    const clicks = [];
    let last = -minGap;

    // Basic transient detector: first sample crossing threshold after gap.
    for (let i = 0; i < n; i++) {
      const v = Math.abs(samples[i]);
      if (v > threshold && (i - last) > minGap) {
        // refine to local maximum around i within small window
        const refine = Math.floor(0.01 * sr); // 10ms
        const a = i;
        const b = Math.min(n - 1, i + refine);
        let bestI = a;
        let bestV = v;
        for (let k = a; k <= b; k++) {
          const vv = Math.abs(samples[k]);
          if (vv > bestV) {
            bestV = vv;
            bestI = k;
          }
        }

        clicks.push({ time: bestI / sr, sampleIndex: bestI });
        last = bestI;
        i = bestI; // skip forward slightly
      }
    }

    return clicks;
  }

  // ---------- Centroid analysis ----------
  function hannWindow(N) {
    const w = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
    }
    return w;
  }

  const HANN_2048 = hannWindow(2048);

  async function centroidAt(samples, sr, sampleIndex, fftSize = 2048) {
    if (sampleIndex + fftSize >= samples.length) return 0;

    // band-limit centroid to a more useful click tone region
    // (helps prevent “everything ~7400Hz” behavior if high-frequency noise dominates)
    const fMin = 200;   // Hz
    const fMax = 6000;  // Hz

    const offline = new OfflineAudioContext(1, fftSize, sr);
    const buf = offline.createBuffer(1, fftSize, sr);

    const slice = new Float32Array(fftSize);
    const win = (fftSize === 2048) ? HANN_2048 : hannWindow(fftSize);

    for (let i = 0; i < fftSize; i++) {
      slice[i] = (samples[sampleIndex + i] || 0) * win[i];
    }
    buf.copyToChannel(slice, 0);

    const src = offline.createBufferSource();
    const analyser = offline.createAnalyser();
    analyser.fftSize = fftSize;

    src.buffer = buf;
    src.connect(analyser);
    analyser.connect(offline.destination);
    src.start();

    await offline.startRendering();

    const freqData = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqData);

    // Spectral centroid (band-limited, dB -> linear)
    let weighted = 0;
    let sum = 0;

    const binHz = sr / fftSize;
    const iMin = Math.max(0, Math.floor(fMin / binHz));
    const iMax = Math.min(freqData.length - 1, Math.ceil(fMax / binHz));

    for (let i = iMin; i <= iMax; i++) {
      const db = freqData[i];
      // ignore -Infinity and very low values
      if (!Number.isFinite(db) || db < -120) continue;
      const mag = Math.pow(10, db / 20);
      const f = i * binHz;
      weighted += f * mag;
      sum += mag;
    }

    return sum > 0 ? (weighted / sum) : 0;
  }

  // ---------- Classification ----------
  function kmeans2(values, iters = 20) {
    // values: number[]
    if (values.length < 2) {
      return { c1: values[0] || 0, c2: values[0] || 0, labels: values.map(() => 0) };
    }

    // init centers near 25% and 75% percentiles
    const sorted = [...values].sort((a, b) => a - b);
    const c1init = sorted[Math.floor(sorted.length * 0.25)];
    const c2init = sorted[Math.floor(sorted.length * 0.75)];

    let c1 = c1init;
    let c2 = c2init;
    let labels = new Array(values.length).fill(0);

    for (let t = 0; t < iters; t++) {
      let s1 = 0, n1 = 0, s2 = 0, n2 = 0;

      // assign
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const d1 = Math.abs(v - c1);
        const d2 = Math.abs(v - c2);
        const lab = d1 <= d2 ? 0 : 1;
        labels[i] = lab;
        if (lab === 0) { s1 += v; n1++; } else { s2 += v; n2++; }
      }

      // update (avoid empty cluster collapse)
      if (n1 > 0) c1 = s1 / n1;
      if (n2 > 0) c2 = s2 / n2;

      // if one cluster empty, break
      if (n1 === 0 || n2 === 0) break;
    }

    return { c1, c2, labels };
  }

  function inferBeatsPerBar(clicks, labels, preferMinority = true) {
    // Determine which label likely corresponds to downbeats: minority cluster by count.
    const count0 = labels.filter(l => l === 0).length;
    const count1 = labels.length - count0;

    let downLabel = 0;
    if (preferMinority) downLabel = (count0 <= count1) ? 0 : 1;

    // Compute distance between downLabel events in number of clicks
    const idxs = [];
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === downLabel) idxs.push(i);
    }
    if (idxs.length < 2) return { beatsPerBar: 4, downLabel };

    const gaps = [];
    for (let i = 1; i < idxs.length; i++) gaps.push(idxs[i] - idxs[i - 1]);

    // mode of gaps in a reasonable range
    const hist = new Map();
    for (const g of gaps) {
      if (g < 2 || g > 16) continue;
      hist.set(g, (hist.get(g) || 0) + 1);
    }
    let best = 4, bestCount = -1;
    for (const [g, c] of hist.entries()) {
      if (c > bestCount) { best = g; bestCount = c; }
    }
    return { beatsPerBar: best, downLabel };
  }

  function alignDownbeatsByPhase(clicks, labels, beatsPerBar, downLabel) {
    // Sometimes k-means labels are correct (two tones) but “which one is downbeat”
    // and the phase can drift. We choose a phase that maximizes agreement with downLabel.
    // That gives stable true/false.
    if (!beatsPerBar || beatsPerBar < 2) beatsPerBar = 4;

    // Choose phase 0..beatsPerBar-1
    let bestPhase = 0;
    let bestScore = -Infinity;

    for (let phase = 0; phase < beatsPerBar; phase++) {
      let score = 0;
      for (let i = 0; i < labels.length; i++) {
        const isGridDown = ((i - phase) % beatsPerBar === 0);
        const isToneDown = (labels[i] === downLabel);
        if (isGridDown && isToneDown) score += 2;
        else if (isGridDown && !isToneDown) score -= 1;
        else if (!isGridDown && isToneDown) score -= 0.5;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPhase = phase;
      }
    }

    // Build final downbeat set based on chosen phase (grid)
    const downbeatsSet = new Set();
    for (let i = 0; i < clicks.length; i++) {
      const isDown = ((i - bestPhase) % beatsPerBar === 0);
      if (isDown) downbeatsSet.add(clicks[i].sampleIndex);
    }
    return { bestPhase, downbeatsSet };
  }

  // ---------- Tempo segmentation ----------
  function detectTempoSegments(clicks, toleranceBpm = 1.0, minBeatsPerSeg = 4) {
    if (clicks.length < 2) return [];

    // Instant BPM per interval
    const bpms = [];
    for (let i = 1; i < clicks.length; i++) {
      const dt = clicks[i].time - clicks[i - 1].time;
      bpms.push(dt > 0 ? 60 / dt : 0);
    }

    // Median smoothing (window 5)
    const smooth = [];
    const w = 5;
    for (let i = 0; i < bpms.length; i++) {
      const a = Math.max(0, i - Math.floor(w / 2));
      const b = Math.min(bpms.length - 1, i + Math.floor(w / 2));
      const slice = bpms.slice(a, b + 1).sort((x, y) => x - y);
      smooth.push(slice[Math.floor(slice.length / 2)]);
    }

    const segments = [];
    let segStartBeat = 0;
    let segBpm = smooth[0] || 0;

    function closeSegment(endBeatExclusive) {
      const beats = endBeatExclusive - segStartBeat;
      if (beats < minBeatsPerSeg) return;
      const time = clicks[segStartBeat].time;
      segments.push({ time: r3(time), bpm: r1(segBpm) });
    }

    for (let i = 1; i < smooth.length; i++) {
      const bpm = smooth[i];
      if (Math.abs(bpm - segBpm) > toleranceBpm) {
        closeSegment(i);
        segStartBeat = i;
        segBpm = bpm;
      }
    }
    closeSegment(smooth.length);

    // Always include first segment (even if short)
    if (!segments.length && smooth.length) {
      segments.push({ time: r3(clicks[0].time), bpm: r1(smooth[0]) });
    }

    return segments;
  }

  // ---------- Main analyze ----------
  async function analyze() {
    try {
      if (!fileInput.files?.length) {
        setStatus("Choose a .wav or .mp3 first.");
        return;
      }

      setStatus("Decoding audio…");
      await audioCtx.resume();

      const file = fileInput.files[0];
      audioBuffer = await decodeAudio(file);
      sampleRate = audioBuffer.sampleRate;

      // Use mono channel 0
      samples = audioBuffer.getChannelData(0);

      // init viewport
      viewStart = 0;
      updateViewport();
      draw();

      setStatus("Detecting clicks…");
      const detected = detectClicksAdaptive(samples, sampleRate);

      setStatus(`Found ${detected.length} clicks. Calculating centroids…`);
      // centroid per click
      clicks = [];
      for (let i = 0; i < detected.length; i++) {
        const c = detected[i];
        const centroid = await centroidAt(samples, sampleRate, c.sampleIndex, 2048);
        clicks.push({ ...c, centroid });
      }

      // k-means on centroid values
      const values = clicks.map(c => c.centroid);
      const km = kmeans2(values);
      const labels = km.labels;

      // beats-per-bar inference and robust downbeat labeling
      const { beatsPerBar, downLabel } = inferBeatsPerBar(clicks, labels, true);
      const { bestPhase, downbeatsSet } = alignDownbeatsByPhase(clicks, labels, beatsPerBar, downLabel);

      // Build result arrays
      const downbeats = [];
      const beats = [];
      for (let i = 0; i < clicks.length; i++) {
        const item = {
          time: r3(clicks[i].time),
          centroid: r1(clicks[i].centroid),
          downbeat: downbeatsSet.has(clicks[i].sampleIndex)
        };
        (item.downbeat ? downbeats : beats).push(item);
      }

      // Tempo segmentation
      const tempoSegments = detectTempoSegments(clicks, 1.0, 4);

      classification = {
        beatsPerBar,
        bestPhase,
        downbeatsSet,
        tempoSegments,
        // helpful diagnostics:
        clusterCenters: { c1: r1(km.c1), c2: r1(km.c2) },
        downbeatClusterLabel: downLabel
      };

      // Redraw with overlay
      draw();

      // Output (rounded)
      setStatus(
        JSON.stringify(
          {
            beatsPerBar,
            tempoSegments,
            clusters: classification.clusterCenters,
            phase: bestPhase,
            downbeats,
            beats
          },
          null,
          2
        )
      );
    } catch (e) {
      setError(e);
    }
  }

  async function decodeAudio(file) {
    const data = await file.arrayBuffer();
    return await audioCtx.decodeAudioData(data);
  }

  // ---------- Events ----------
  processBtn.addEventListener("click", analyze);

  zoomEl.addEventListener("input", () => {
    // keep current relative position on zoom change
    updateViewport();
    draw();
  });

  scrollEl.addEventListener("input", () => {
    scrollEl.dataset.dragging = "1";
    sliderToViewStart();
    draw();
  });

  scrollEl.addEventListener("change", () => {
    // end drag
    delete scrollEl.dataset.dragging;
    updateViewport();
    draw();
  });

  window.addEventListener("resize", () => draw());
})();
