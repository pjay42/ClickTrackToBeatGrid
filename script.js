/* Click Track Analyzer (Drop-in script.js)
 * - WAV/MP3 decode
 * - Click detection
 * - Centroid-based classification (downbeat vs beat)
 * - Beats-per-bar auto detection
 * - Tempo segmentation (BPM changes)
 * - Zoom + scroll waveform with bottom scrollbar
 * - Overlay markers (downbeats vs beats)
 */

(() => {
  // ---------------------------
  // DOM + Safety
  // ---------------------------
  const fileInput = document.getElementById("fileInput");
  const processBtn = document.getElementById("processBtn"); // Analyze button
  const canvas = document.getElementById("waveform");
  const output = document.getElementById("output");

  const missing = [];
  if (!fileInput) missing.push("fileInput");
  if (!processBtn) missing.push("processBtn");
  if (!canvas) missing.push("waveform");
  if (!output) missing.push("output");

  if (missing.length) {
    console.error("Missing required DOM elements:", missing.join(", "));
    // Don't throw — just stop.
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    console.error("Unable to get 2D context from #waveform canvas.");
    return;
  }

  // Make sure canvas has some height (GitHub pages sometimes collapses it)
  if (!canvas.style.height) canvas.style.height = "200px";

  // ---------------------------
  // Audio Context
  // ---------------------------
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // ---------------------------
  // UI: Zoom + Scroll controls
  // ---------------------------
  const controls = ensureControlsBelowCanvas(canvas);

  // State
  const state = {
    audioBuffer: null,
    samples: null,
    sr: 44100,
    duration: 0,

    clicks: [],            // [timeSec]
    events: [],            // [{time, centroid}]
    classification: null,  // {downbeats:Set(index), beats:Set(index), threshold, centroids}
    bpb: null,             // beats-per-bar
    segments: [],          // tempo segments

    // viewport
    zoom: 1,               // 1..N
    scroll: 0,             // 0..1
  };

  // Wire controls
  controls.zoom.addEventListener("input", () => {
    state.zoom = clamp(parseFloat(controls.zoom.value), 1, 50);
    updateScrollMax();
    redrawAll();
  });

  controls.scroll.addEventListener("input", () => {
    state.scroll = clamp(parseFloat(controls.scroll.value), 0, 1);
    redrawAll();
  });

  // ---------------------------
  // Main handler
  // ---------------------------
  processBtn.addEventListener("click", async () => {
    try {
      output.textContent = "";
      await audioCtx.resume(); // required in Safari/iOS

      const file = fileInput.files?.[0];
      if (!file) {
        output.textContent = "No file selected.";
        return;
      }

      const buffer = await decode(file);
      if (!buffer) {
        output.textContent = "Decode failed.";
        return;
      }

      // Use mono (mixdown if needed)
      const samples = mixToMono(buffer);
      const sr = buffer.sampleRate;

      state.audioBuffer = buffer;
      state.samples = samples;
      state.sr = sr;
      state.duration = buffer.duration;

      resizeCanvasToCSSPixels();
      updateScrollMax();

      // 1) Detect clicks (times)
      state.clicks = detectClicks(samples, sr);

      // 2) Compute centroid per click
      state.events = await analyzeCentroids(samples, sr, state.clicks);

      // 3) Classify downbeats vs beats using 2-cluster on centroid
      state.classification = classifyByCentroid(state.events);

      // 4) Beats-per-bar auto detection (based on centroid pattern periodicity)
      state.bpb = detectBeatsPerBar(state.events, state.classification);

      // 5) Tempo segmentation
      state.segments = segmentTempo(state.clicks, { toleranceBpm: 1.0, minSegmentBeats: 8 });

      // Draw waveform + overlays
      redrawAll();

      // Print results JSON
      const downbeatIndices = [...state.classification.downbeatIdx].sort((a,b)=>a-b);
      const beatIndices = [...state.classification.beatIdx].sort((a,b)=>a-b);

      const result = {
        file: { name: file.name, type: file.type, durationSec: state.duration, sampleRate: sr },
        clicksDetected: state.clicks.length,
        beatsPerBar: state.bpb,
        centroidModel: {
          threshold: state.classification.threshold,
          lowMean: state.classification.lowMean,
          highMean: state.classification.highMean,
          downbeatCluster: state.classification.downbeatCluster,
        },
        tempoSegments: state.segments,
        events: state.events.map((e, i) => ({
          index: i,
          time: e.time,
          centroid: round(e.centroid, 2),
          isDownbeat: state.classification.downbeatIdx.has(i),
        })),
        // Handy: indices only
        downbeats: downbeatIndices,
        beats: beatIndices,
      };

      output.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      console.error(err);
      output.textContent = `Error: ${err?.message || String(err)}`;
    }
  });

  // ---------------------------
  // Decode
  // ---------------------------
  async function decode(file) {
    const data = await file.arrayBuffer();
    return await audioCtx.decodeAudioData(data);
  }

  function mixToMono(buffer) {
    const ch = buffer.numberOfChannels;
    const len = buffer.length;
    const out = new Float32Array(len);

    if (ch === 1) {
      out.set(buffer.getChannelData(0));
      return out;
    }

    // Average channels
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  // ---------------------------
  // Click detection (robust, no stack overflow)
  // ---------------------------
  function detectClicks(samples, sr) {
    if (!samples || samples.length === 0) return [];

    // Adaptive threshold using peak (iterate; DON'T spread)
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }

    // If audio is very quiet, bail early
    if (peak < 1e-4) return [];

    const threshold = peak * 0.35; // tweak if needed
    const minGapSec = 0.08;        // avoids double-fires on click transient

    const clicks = [];
    let lastClickT = -Infinity;

    // Slight refinement: require local-maximum over a tiny neighborhood
    const neighborhood = Math.floor(sr * 0.003); // 3ms

    for (let i = neighborhood; i < samples.length - neighborhood; i++) {
      const v = Math.abs(samples[i]);
      const t = i / sr;

      if (v < threshold) continue;
      if (t - lastClickT < minGapSec) continue;

      // local max check
      let isPeak = true;
      for (let k = 1; k <= neighborhood; k++) {
        if (Math.abs(samples[i - k]) > v || Math.abs(samples[i + k]) > v) {
          isPeak = false;
          break;
        }
      }
      if (!isPeak) continue;

      clicks.push(t);
      lastClickT = t;
    }

    return clicks;
  }

  // ---------------------------
  // Centroid analysis per click (stable, band-limited)
  // ---------------------------
  async function analyzeCentroids(samples, sr, clickTimes) {
    const events = [];
    for (const t of clickTimes) {
      const centroid = await centroidForClick(samples, sr, t);
      events.push({ time: t, centroid });
    }
    return events;
  }

  async function centroidForClick(samples, sr, timeSec) {
    // Window around click
    const fftSize = 4096;                // higher = more freq resolution
    const windowSec = fftSize / sr;
    const start = Math.floor(timeSec * sr);

    if (!samples || start < 0 || start + fftSize > samples.length) return 0;

    // Copy & apply Hann window to reduce spectral smear
    const slice = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1)));
      slice[i] = (samples[start + i] || 0) * w;
    }

    // Offline context: render slice through analyser
    const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, fftSize, sr);
    const buf = offline.createBuffer(1, fftSize, sr);
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

    const freqBins = analyser.frequencyBinCount;
    const freqDataDb = new Float32Array(freqBins);
    analyser.getFloatFrequencyData(freqDataDb);

    // Band-limit to where click tones usually live
    // (Adjust if your tones are lower/higher)
    const minHz = 200;
    const maxHz = 6000;

    const binHz = sr / fftSize;
    const minBin = clampInt(Math.floor(minHz / binHz), 0, freqBins - 1);
    const maxBin = clampInt(Math.floor(maxHz / binHz), 0, freqBins - 1);

    // Find max dB in band (for stable relative weighting)
    let maxDb = -Infinity;
    for (let i = minBin; i <= maxBin; i++) {
      const db = freqDataDb[i];
      if (Number.isFinite(db) && db > maxDb) maxDb = db;
    }
    if (!Number.isFinite(maxDb)) return 0;

    // Spectral centroid using RELATIVE linear magnitudes
    // weight = 10^((db - maxDb)/20) in [0..1]
    let weightedSum = 0;
    let magSum = 0;

    for (let i = minBin; i <= maxBin; i++) {
      const db = freqDataDb[i];
      if (!Number.isFinite(db)) continue;

      const relDb = db - maxDb; // <= 0
      // Ignore extremely small bins (helps avoid “everything looks high”)
      if (relDb < -60) continue;

      const mag = Math.pow(10, relDb / 20);
      const freq = i * binHz;

      weightedSum += freq * mag;
      magSum += mag;
    }

    if (magSum <= 0) return 0;
    return weightedSum / magSum;
  }

  // ---------------------------
  // Classification by centroid: 2-cluster + choose smaller cluster as downbeats
  // ---------------------------
  function classifyByCentroid(events) {
    const centroids = events.map(e => e.centroid).filter(x => Number.isFinite(x));

    // If centroid failed, bail gracefully
    if (centroids.length < 4) {
      return {
        downbeatIdx: new Set(),
        beatIdx: new Set(events.map((_, i) => i)),
        threshold: 0,
        lowMean: 0,
        highMean: 0,
        downbeatCluster: "unknown",
      };
    }

    // Robust split threshold: median
    const sorted = [...events.map(e => e.centroid)].sort((a,b)=>a-b);
    const median = sorted[Math.floor(sorted.length / 2)];

    const low = [];
    const high = [];
    events.forEach((e, i) => (e.centroid < median ? low : high).push({ i, c: e.centroid }));

    const lowMean = mean(low.map(x => x.c));
    const highMean = mean(high.map(x => x.c));
    const threshold = (lowMean + highMean) / 2;

    // smaller cluster is likely downbeats (1 per bar)
    const lowIsDownbeat = low.length < high.length;
    const downbeatIdx = new Set((lowIsDownbeat ? low : high).map(x => x.i));
    const beatIdx = new Set((lowIsDownbeat ? high : low).map(x => x.i));

    return {
      downbeatIdx,
      beatIdx,
      threshold,
      lowMean,
      highMean,
      downbeatCluster: lowIsDownbeat ? "low" : "high",
    };
  }

  // ---------------------------
  // Beats-per-bar auto detection
  // We look at downbeat positions and find most common spacing (in beats).
  // ---------------------------
  function detectBeatsPerBar(events, cls) {
    const down = [];
    for (let i = 0; i < events.length; i++) {
      if (cls.downbeatIdx.has(i)) down.push(i);
    }
    if (down.length < 3) return null;

    const diffs = [];
    for (let i = 1; i < down.length; i++) {
      diffs.push(down[i] - down[i - 1]);
    }

    // Vote for common bar lengths (2..12 typical)
    const votes = new Map();
    for (const d of diffs) {
      for (let k = 2; k <= 12; k++) {
        // if d is close to k or multiple of k, vote (handles missed detections)
        const r = d % k;
        const dist = Math.min(r, k - r);
        if (dist <= 1) votes.set(k, (votes.get(k) || 0) + 1);
      }
    }

    let best = null;
    let bestScore = -Infinity;
    for (const [k, score] of votes.entries()) {
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    return best;
  }

  // ---------------------------
  // Tempo Segmentation
  // - compute per-beat bpm
  // - split when bpm differs by tolerance
  // ---------------------------
  function segmentTempo(clickTimes, { toleranceBpm = 1.0, minSegmentBeats = 8 } = {}) {
    if (!clickTimes || clickTimes.length < 2) return [];

    const bpms = [];
    for (let i = 1; i < clickTimes.length; i++) {
      const dt = clickTimes[i] - clickTimes[i - 1];
      if (dt <= 0) continue;
      bpms.push({ i, bpm: 60 / dt }); // bpm for interval ending at i
    }
    if (bpms.length === 0) return [];

    const segments = [];
    let segStartIdx = 0;
    let segBpms = [bpms[0].bpm];

    function segMedian(arr) {
      const s = [...arr].sort((a,b)=>a-b);
      return s[Math.floor(s.length / 2)];
    }

    for (let k = 1; k < bpms.length; k++) {
      const currBpm = bpms[k].bpm;
      const med = segMedian(segBpms);

      if (Math.abs(currBpm - med) > toleranceBpm) {
        // end segment
        const segEndIdx = bpms[k - 1].i; // click index
        const lengthBeats = segEndIdx - segStartIdx;

        if (lengthBeats >= minSegmentBeats) {
          segments.push({
            startClickIndex: segStartIdx,
            endClickIndex: segEndIdx,
            startTime: clickTimes[segStartIdx],
            endTime: clickTimes[segEndIdx],
            bpm: round(segMedian(segBpms), 3),
            beats: lengthBeats,
          });
          segStartIdx = segEndIdx;
          segBpms = [currBpm];
        } else {
          // too short—absorb into current
          segBpms.push(currBpm);
        }
      } else {
        segBpms.push(currBpm);
      }
    }

    // final segment
    const finalEndIdx = clickTimes.length - 1;
    const finalBeats = finalEndIdx - segStartIdx;

    segments.push({
      startClickIndex: segStartIdx,
      endClickIndex: finalEndIdx,
      startTime: clickTimes[segStartIdx],
      endTime: clickTimes[finalEndIdx],
      bpm: round(segMedian(segBpms), 3),
      beats: finalBeats,
    });

    return segments;
  }

  // ---------------------------
  // Drawing: Waveform + overlays (scroll/zoom)
  // ---------------------------
  function resizeCanvasToCSSPixels() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 800;
    const cssH = canvas.clientHeight || 200;

    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  }

  function updateScrollMax() {
    // Range input always 0..1000; we map to 0..1 internally
    controls.scroll.min = "0";
    controls.scroll.max = "1000";
    controls.scroll.step = "1";

    // If zoomed in, scrolling matters; if zoom=1, lock scroll to 0
    if (state.zoom <= 1.001) {
      controls.scroll.value = "0";
      state.scroll = 0;
      controls.scroll.disabled = true;
    } else {
      controls.scroll.disabled = false;
    }
  }

  function redrawAll() {
    if (!state.samples || !state.samples.length) {
      // Clear
      resizeCanvasToCSSPixels();
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      return;
    }
    resizeCanvasToCSSPixels();
    drawWaveform(state.samples, state.sr);
    drawOverlays();
  }

  function drawWaveform(samples, sr) {
    if (!samples || samples.length === 0) return;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, w, h);

    // Viewport in time
    const dur = state.duration || (samples.length / sr);
    const viewDur = dur / state.zoom;
    const maxStart = Math.max(0, dur - viewDur);
    const startT = maxStart * state.scroll;
    const endT = startT + viewDur;

    // Convert to sample range
    const startS = Math.floor(startT * sr);
    const endS = Math.min(samples.length, Math.floor(endT * sr));
    const span = Math.max(1, endS - startS);

    // Draw waveform by min/max per pixel (fast + good)
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let x = 0; x < w; x++) {
      const s0 = startS + Math.floor((x / w) * span);
      const s1 = startS + Math.floor(((x + 1) / w) * span);

      let mn = 1, mx = -1;
      for (let s = s0; s < s1; s++) {
        const v = samples[s] || 0;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }

      const y1 = mid + mn * mid;
      const y2 = mid + mx * mid;

      // vertical line per pixel
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();

    // Viewport label
    ctx.fillStyle = "#94a3b8";
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillText(
      `Zoom: ${state.zoom.toFixed(1)}x  View: ${startT.toFixed(2)}s – ${endT.toFixed(2)}s`,
      10,
      18
    );
  }

  function drawOverlays() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    const samples = state.samples;
    const sr = state.sr;
    const dur = state.duration || (samples.length / sr);
    const viewDur = dur / state.zoom;
    const maxStart = Math.max(0, dur - viewDur);
    const startT = maxStart * state.scroll;
    const endT = startT + viewDur;

    if (!state.events?.length) return;

    // Draw click markers
    for (let i = 0; i < state.events.length; i++) {
      const t = state.events[i].time;
      if (t < startT || t > endT) continue;

      const x = ((t - startT) / viewDur) * w;
      const isDownbeat = state.classification?.downbeatIdx?.has(i);

      ctx.strokeStyle = isDownbeat ? "#f97316" : "#22c55e"; // orange vs green
      ctx.globalAlpha = isDownbeat ? 0.95 : 0.65;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;

    // Optional: show tempo segment boundaries
    if (state.segments?.length) {
      ctx.strokeStyle = "#e2e8f0";
      ctx.globalAlpha = 0.35;
      for (const seg of state.segments) {
        const t = seg.startTime;
        if (t < startT || t > endT) continue;
        const x = ((t - startT) / viewDur) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------
  // Helpers
  // ---------------------------
  function ensureControlsBelowCanvas(canvasEl) {
    // If you already have controls, keep them. Otherwise inject.
    let container = document.getElementById("waveformControls");
    if (!container) {
      container = document.createElement("div");
      container.id = "waveformControls";
      container.style.marginTop = "10px";
      container.style.display = "grid";
      container.style.gap = "8px";
      container.style.maxWidth = "100%";
      canvasEl.insertAdjacentElement("afterend", container);
    }

    // Zoom slider
    let zoom = document.getElementById("zoom");
    if (!zoom) {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "120px 1fr 70px";
      row.style.alignItems = "center";
      row.style.gap = "10px";

      const label = document.createElement("div");
      label.textContent = "Zoom";
      label.style.color = "#94a3b8";

      zoom = document.createElement("input");
      zoom.type = "range";
      zoom.id = "zoom";
      zoom.min = "1";
      zoom.max = "50";
      zoom.step = "0.1";
      zoom.value = "1";

      const val = document.createElement("div");
      val.id = "zoomVal";
      val.style.color = "#94a3b8";
      val.style.textAlign = "right";
      val.textContent = "1.0x";

      zoom.addEventListener("input", () => {
        val.textContent = `${parseFloat(zoom.value).toFixed(1)}x`;
      });

      row.appendChild(label);
      row.appendChild(zoom);
      row.appendChild(val);

      container.appendChild(row);
    }

    // Scroll bar (bottom navigation)
    let scroll = document.getElementById("scroll");
    if (!scroll) {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "120px 1fr 70px";
      row.style.alignItems = "center";
      row.style.gap = "10px";

      const label = document.createElement("div");
      label.textContent = "Scroll";
      label.style.color = "#94a3b8";

      scroll = document.createElement("input");
      scroll.type = "range";
      scroll.id = "scroll";
      scroll.min = "0";
      scroll.max = "1000";
      scroll.step = "1";
      scroll.value = "0";

      const val = document.createElement("div");
      val.id = "scrollVal";
      val.style.color = "#94a3b8";
      val.style.textAlign = "right";
      val.textContent = "0%";

      scroll.addEventListener("input", () => {
        const pct = Math.round((parseInt(scroll.value, 10) / 1000) * 100);
        val.textContent = `${pct}%`;
        state.scroll = parseInt(scroll.value, 10) / 1000;
      });

      row.appendChild(label);
      row.appendChild(scroll);
      row.appendChild(val);

      container.appendChild(row);
    }

    // Map scroll range [0..1000] to [0..1]
    scroll.addEventListener("input", () => {
      state.scroll = parseInt(scroll.value, 10) / 1000;
    });

    // Map zoom to state
    zoom.addEventListener("input", () => {
      state.zoom = parseFloat(zoom.value);
    });

    return { zoom, scroll };
  }

  function mean(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (const x of arr) s += x;
    return s / arr.length;
  }

  function clamp(x, a, b) {
    return Math.max(a, Math.min(b, x));
  }
  function clampInt(x, a, b) {
    return Math.max(a, Math.min(b, x | 0));
  }
  function round(x, d = 2) {
    const p = Math.pow(10, d);
    return Math.round(x * p) / p;
  }

  // Redraw on resize
  window.addEventListener("resize", () => {
    updateScrollMax();
    redrawAll();
  });
})();
