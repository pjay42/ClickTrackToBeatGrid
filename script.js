(() => {
  // ----------------------------
  // DOM lookup (with fallbacks)
  // ----------------------------
  const $ = (id) => document.getElementById(id);

  const fileInput =
    $("fileInput") || document.querySelector('input[type="file"]');
  const analyzeBtn =
    $("processBtn") || $("analyze") || document.querySelector("button");
  const canvas = $("waveform") || document.querySelector("canvas");
  const output = $("output") || document.querySelector("pre");

  // Optional controls (you said zoom works great already)
  const zoomRange = $("zoomRange");   // expected type="range"
  const scrollRange = $("scrollRange"); // expected type="range"

  const missing = [];
  if (!fileInput) missing.push("fileInput");
  if (!analyzeBtn) missing.push("processBtn/analyze button");
  if (!canvas) missing.push("waveform canvas");
  if (!output) missing.push("output");

  if (missing.length) {
    console.error("Missing required DOM elements:", missing.join(", "));
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.error("Could not get 2D context from canvas.");
    return;
  }

  // ----------------------------
  // Audio
  // ----------------------------
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // State
  let audioBuffer = null;
  let samples = null;
  let sr = 44100;
  let durationSec = 0;

  // Analysis results
  let clickTimes = [];
  let events = []; // { time, centroid, cluster, isDownbeat, bpm? }
  let segments = []; // tempo segments

  // View state (zoom/scroll)
  let view = {
    zoom: 1,           // 1..N (higher = more zoom)
    windowSec: 10,     // visible window length in seconds
    startSec: 0        // window start time
  };

  // ----------------------------
  // Helpers: rounding / formatting
  // ----------------------------
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const r1 = (x) => Math.round(x * 10) / 10;

  // ----------------------------
  // UI: canvas sizing
  // ----------------------------
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 220;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  }

  window.addEventListener("resize", () => {
    if (!samples) return;
    resizeCanvas();
    draw();
  });

  // ----------------------------
  // Decode
  // ----------------------------
  async function decodeFile(file) {
    const data = await file.arrayBuffer();
    // Safari sometimes needs a copy
    const buf = await audioCtx.decodeAudioData(data.slice(0));
    return buf;
  }

  function getMonoSamples(buffer) {
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);

    // Mixdown stereo -> mono
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.getChannelData(1);
    const mono = new Float32Array(buffer.length);
    for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    return mono;
  }

  // ----------------------------
  // Click detection (no spread ops)
  // ----------------------------
  function detectClicks(samples, sr, opts = {}) {
    const minGap = opts.minGap ?? 0.08; // seconds
    const threshPct = opts.threshPct ?? 0.35;

    // Find max abs without Math.max(...arr) (avoids call stack overflow)
    let maxAbs = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > maxAbs) maxAbs = a;
    }
    const threshold = maxAbs * threshPct;

    const clicks = [];
    let last = -Infinity;

    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v < threshold) continue;

      const t = i / sr;
      if (t - last > minGap) {
        clicks.push(t);
        last = t;
      }
    }
    return clicks;
  }

  // ----------------------------
  // FFT centroid (band-limited) to keep values meaningful
  // ----------------------------
  async function centroidForClick(samples, sr, time, opts = {}) {
    const fftSize = opts.fftSize ?? 2048;
    const start = Math.floor(time * sr);

    if (start + fftSize >= samples.length) return 0;

    const offline = new OfflineAudioContext(1, fftSize, sr);
    const buf = offline.createBuffer(1, fftSize, sr);

    // copy slice
    const slice = samples.subarray(start, start + fftSize);
    buf.copyToChannel(slice, 0);

    const src = offline.createBufferSource();
    const analyser = offline.createAnalyser();
    analyser.fftSize = fftSize;

    src.buffer = buf;
    src.connect(analyser);
    analyser.connect(offline.destination);
    src.start(0);

    await offline.startRendering();

    const freqData = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqData); // dB values

    // Band-limit centroid to reduce "everything ~7400Hz" issues
    // Typical click tones often sit between a few hundred Hz and a few kHz.
    return spectralCentroidBand(freqData, sr, fftSize, 300, 5000);
  }

  function spectralCentroidBand(freqDataDb, sampleRate, fftSize, fMin, fMax) {
    const binHz = sampleRate / fftSize;

    let iMin = Math.floor(fMin / binHz);
    let iMax = Math.ceil(fMax / binHz);
    iMin = Math.max(0, Math.min(iMin, freqDataDb.length - 1));
    iMax = Math.max(0, Math.min(iMax, freqDataDb.length - 1));

    let weightedSum = 0;
    let magSum = 0;

    // Convert dB -> linear magnitude; clamp super-low values
    for (let i = iMin; i <= iMax; i++) {
      const db = freqDataDb[i];
      // ignore bins far below noise floor
      if (!Number.isFinite(db) || db < -120) continue;

      const mag = Math.pow(10, db / 20);
      const freq = i * binHz;

      weightedSum += freq * mag;
      magSum += mag;
    }

    return magSum ? (weightedSum / magSum) : 0;
  }

  // ----------------------------
  // 2-means clustering (k=2) on centroid feature
  // ----------------------------
  function kmeans2(values, iters = 20) {
    // values: number[]
    const clean = values.filter(v => Number.isFinite(v));
    if (clean.length < 2) return { centers: [0, 0], labels: values.map(() => 0) };

    // init centers: min & max (robust for 2 clusters)
    let c0 = Math.min(...clean);
    let c1 = Math.max(...clean);

    // Edge case: all same
    if (Math.abs(c1 - c0) < 1e-6) {
      return { centers: [c0, c1], labels: values.map(() => 0) };
    }

    let labels = new Array(values.length).fill(0);

    for (let iter = 0; iter < iters; iter++) {
      // assign
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) { labels[i] = 0; continue; }
        const d0 = Math.abs(v - c0);
        const d1 = Math.abs(v - c1);
        labels[i] = d0 <= d1 ? 0 : 1;
      }

      // recompute centers
      let s0 = 0, n0 = 0, s1 = 0, n1 = 0;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        if (labels[i] === 0) { s0 += v; n0++; }
        else { s1 += v; n1++; }
      }

      const newC0 = n0 ? s0 / n0 : c0;
      const newC1 = n1 ? s1 / n1 : c1;

      if (Math.abs(newC0 - c0) < 1e-6 && Math.abs(newC1 - c1) < 1e-6) break;
      c0 = newC0; c1 = newC1;
    }

    return { centers: [c0, c1], labels };
  }

  // ----------------------------
  // Tempo segmentation (BPM per interval, then merge into segments)
  // ----------------------------
  function computeBpms(times) {
    const bpms = new Array(times.length).fill(null);
    for (let i = 1; i < times.length; i++) {
      const dt = times[i] - times[i - 1];
      if (dt > 0) bpms[i] = 60 / dt;
    }
    return bpms;
  }

  function segmentTempo(times, bpms, tolBpm = 0.8) {
    const segs = [];
    if (times.length < 2) return segs;

    let segStartIdx = 1;
    let segBpm = bpms[1] ?? 0;

    for (let i = 2; i < times.length; i++) {
      const b = bpms[i];
      if (!Number.isFinite(b)) continue;

      if (Math.abs(b - segBpm) > tolBpm) {
        segs.push({
          startTime: times[segStartIdx],
          endTime: times[i - 1],
          bpm: segBpm
        });
        segStartIdx = i;
        segBpm = b;
      } else {
        // slowly track segment bpm (light smoothing)
        segBpm = 0.9 * segBpm + 0.1 * b;
      }
    }

    segs.push({
      startTime: times[segStartIdx],
      endTime: times[times.length - 1],
      bpm: segBpm
    });

    // round
    return segs.map(s => ({
      startTime: r3(s.startTime),
      endTime: r3(s.endTime),
      bpm: r1(s.bpm)
    }));
  }

  // ----------------------------
  // Beats-per-bar detection (2..8) + downbeat choice
  // ----------------------------
  function detectBeatsPerBarAndDownbeat(events, labels) {
    // labels are 0/1 clusters. We'll score which cluster forms the "downbeat"
    // by checking periodicity at candidate beats-per-bar.
    const N = events.length;
    if (N < 8) {
      // fallback: minority cluster is downbeats
      const count0 = labels.filter(x => x === 0).length;
      const count1 = N - count0;
      const down = count0 <= count1 ? 0 : 1;
      return { beatsPerBar: null, downbeatCluster: down };
    }

    // Candidate beats-per-bar
    const candidates = [2, 3, 4, 5, 6, 7, 8];

    function periodicScore(clusterId, bpb) {
      // Expect downbeats roughly every bpb beats:
      // compute hits when index% bpb == 0 for that cluster.
      let hits = 0;
      let total = 0;
      for (let i = 0; i < N; i++) {
        if (i % bpb !== 0) continue;
        total++;
        if (labels[i] === clusterId) hits++;
      }
      if (!total) return 0;
      // prefer both high hit-rate and being relatively rare overall
      const rate = hits / total;
      const rarity = 1 - (labels.filter(x => x === clusterId).length / N);
      return rate * 0.8 + rarity * 0.2;
    }

    let best = { score: -Infinity, bpb: null, downCluster: 0 };

    for (const bpb of candidates) {
      const s0 = periodicScore(0, bpb);
      const s1 = periodicScore(1, bpb);

      if (s0 > best.score) best = { score: s0, bpb, downCluster: 0 };
      if (s1 > best.score) best = { score: s1, bpb, downCluster: 1 };
    }

    // If the best score is weak, fallback to minority
    if (best.score < 0.35) {
      const count0 = labels.filter(x => x === 0).length;
      const count1 = N - count0;
      const down = count0 <= count1 ? 0 : 1;
      return { beatsPerBar: null, downbeatCluster: down };
    }

    return { beatsPerBar: best.bpb, downbeatCluster: best.downCluster };
  }

  // ----------------------------
  // Waveform drawing (zoom + scroll + overlays)
  // ----------------------------
  function computeWindowSec() {
    // base window is 12 seconds at zoom=1, smaller window when zoom increases
    const base = 12;
    const z = Math.max(1, view.zoom);
    return Math.max(0.5, base / z);
  }

  function clampView() {
    view.windowSec = computeWindowSec();
    const maxStart = Math.max(0, durationSec - view.windowSec);
    view.startSec = Math.max(0, Math.min(view.startSec, maxStart));
  }

  function updateScrollRangeFromView(preserveRatio = true) {
    if (!scrollRange) return;

    const prevMax = Number(scrollRange.max || 0);
    const prevVal = Number(scrollRange.value || 0);
    const prevRatio = prevMax > 0 ? prevVal / prevMax : 0;

    const maxStart = Math.max(0, durationSec - view.windowSec);

    // Range maps directly to startSec * 1000 to keep precision stable
    scrollRange.min = 0;
    scrollRange.max = Math.floor(maxStart * 1000);
    scrollRange.step = 1;

    if (preserveRatio) {
      scrollRange.value = Math.floor(prevRatio * Number(scrollRange.max || 0));
      view.startSec = (Number(scrollRange.value) || 0) / 1000;
      clampView();
    } else {
      scrollRange.value = Math.floor(view.startSec * 1000);
    }
  }

  function draw() {
    if (!samples) return;

    clampView();
    resizeCanvas();

    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 220;

    // background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, w, h);

    // visible sample bounds
    const startSamp = Math.floor(view.startSec * sr);
    const endSamp = Math.min(samples.length, Math.floor((view.startSec + view.windowSec) * sr));
    const span = Math.max(1, endSamp - startSamp);

    // waveform
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1;
    ctx.beginPath();

    const mid = h / 2;
    const step = Math.max(1, Math.floor(span / w));

    for (let x = 0; x < w; x++) {
      const idx = startSamp + x * step;
      if (idx >= endSamp) break;
      const s = samples[idx] || 0;
      const y = mid + s * mid;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // overlays: beat markers
    drawBeatMarkers(w, h);

    // top info
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "12px system-ui";
    ctx.fillText(
      `view: ${r3(view.startSec)}s → ${r3(view.startSec + view.windowSec)}s  (zoom ${view.zoom.toFixed(2)}x)`,
      10, 16
    );
  }

  function drawBeatMarkers(w, h) {
    if (!events || !events.length) return;

    const start = view.startSec;
    const end = view.startSec + view.windowSec;

    for (const e of events) {
      if (e.time < start || e.time > end) continue;

      const x = ((e.time - start) / view.windowSec) * w;

      // downbeats vs beats
      ctx.strokeStyle = e.isDownbeat ? "#fb7185" : "#22c55e";
      ctx.globalAlpha = e.isDownbeat ? 0.95 : 0.55;
      ctx.lineWidth = e.isDownbeat ? 2 : 1;

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  // ----------------------------
  // Control listeners (zoom + scroll)
  // ----------------------------
  if (zoomRange) {
    zoomRange.addEventListener("input", () => {
      // preserve current view center when zoom changes
      const center = view.startSec + view.windowSec / 2;

      view.zoom = Number(zoomRange.value) || 1;
      view.windowSec = computeWindowSec();

      view.startSec = center - view.windowSec / 2;
      clampView();
      updateScrollRangeFromView(false); // set scroll to match new startSec
      draw();
    });
  }

  if (scrollRange) {
    scrollRange.addEventListener("input", () => {
      view.startSec = (Number(scrollRange.value) || 0) / 1000;
      clampView();
      draw();
    });
  }

  // ----------------------------
  // Main Analyze
  // ----------------------------
  analyzeBtn.addEventListener("click", async () => {
    try {
      if (!fileInput.files || !fileInput.files.length) return;

      await audioCtx.resume();

      const file = fileInput.files[0];
      output.textContent = "Decoding audio…";

      audioBuffer = await decodeFile(file);
      sr = audioBuffer.sampleRate;
      durationSec = audioBuffer.duration;

      samples = getMonoSamples(audioBuffer);

      // init view
      view.zoom = zoomRange ? (Number(zoomRange.value) || 1) : 1;
      view.windowSec = computeWindowSec();
      view.startSec = 0;

      updateScrollRangeFromView(false);
      draw();

      // 1) detect clicks
      output.textContent = "Detecting clicks…";
      clickTimes = detectClicks(samples, sr, { minGap: 0.08, threshPct: 0.35 });

      if (clickTimes.length < 2) {
        output.textContent = "No clicks detected. Try lowering threshold (threshPct) or minGap.";
        return;
      }

      // 2) centroid per click
      output.textContent = `Analyzing ${clickTimes.length} clicks (centroid)…`;
      events = [];
      for (let i = 0; i < clickTimes.length; i++) {
        const t = clickTimes[i];
        const c = await centroidForClick(samples, sr, t, { fftSize: 2048 });
        events.push({ time: t, centroid: c });
      }

      // 3) cluster centroids
      const centroids = events.map(e => e.centroid);
      const { centers, labels } = kmeans2(centroids, 25);

      // 4) beats-per-bar + choose downbeat cluster
      const { beatsPerBar, downbeatCluster } = detectBeatsPerBarAndDownbeat(events, labels);

      // apply labels
      for (let i = 0; i < events.length; i++) {
        events[i].cluster = labels[i];
        events[i].isDownbeat = labels[i] === downbeatCluster;
      }

      // 5) tempo segmentation
      const bpms = computeBpms(clickTimes);
      segments = segmentTempo(clickTimes, bpms, 0.8);

      // update scroll max (in case duration changes)
      updateScrollRangeFromView(false);
      draw();

      // Output (rounded formatting)
      const out = {
        meta: {
          sampleRate: sr,
          durationSec: r3(durationSec),
          clicks: clickTimes.length,
          centroidCenters: centers.map(r1),
          beatsPerBar: beatsPerBar ?? null
        },
        tempoSegments: segments,
        events: events.map(e => ({
          time: r3(e.time),
          centroid: r1(e.centroid),
          downbeat: !!e.isDownbeat
        }))
      };

      output.textContent = JSON.stringify(out, null, 2);
    } catch (err) {
      console.error(err);
      output.textContent = `Error: ${err?.message || err}`;
    }
  });
})();
