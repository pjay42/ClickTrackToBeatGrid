/*  Click Track Analyzer (drop-in script.js)
    Next logical steps implemented:
    1) Overlay detected beats on waveform (downbeats vs beats coloring)
    2) Zoomable + scrollable waveform (wheel zoom, drag pan, shift+wheel pan)
    4) Beats-per-bar auto detection (robust, scores both cluster assignments)
    5) Tempo change segmentation (segments with stable BPM)

    Assumes these elements exist in your HTML:
      <input  id="fileInput"  type="file" ...>
      <button id="processBtn">Analyze</button>
      <canvas id="waveform"></canvas>
      <pre    id="output"></pre>
*/

(() => {
  "use strict";

  // ---------- DOM ----------
  const elFile = document.getElementById("fileInput");
  const elBtn = document.getElementById("processBtn");
  const elCanvas = document.getElementById("waveform");
  const elOut = document.getElementById("output");

  if (!elFile || !elBtn || !elCanvas || !elOut) {
    console.error("Missing required DOM elements: fileInput, processBtn, waveform, output");
    return;
  }

  const g = {
    audioCtx: null,
    audioBuffer: null,
    samples: null,
    sr: 44100,
    duration: 0,

    clicks: [],          // times in seconds
    events: [],          // {time, centroid, isDownbeat, index}
    beatsPerBar: null,

    tempo: {
      bpmPerClick: [],   // bpm between click[i-1] and click[i]
      segments: []       // [{startTime, endTime, bpm}]
    },

    view: {
      // view window in seconds
      start: 0,
      secondsPerScreen: 10,   // zoom: lower = more zoomed-in
      minSecondsPerScreen: 0.5,
      maxSecondsPerScreen: 120,

      // interaction
      isDragging: false,
      dragStartX: 0,
      dragStartViewStart: 0
    }
  };

  // ---------- Audio helpers ----------
  function getAudioCtx() {
    if (!g.audioCtx) g.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return g.audioCtx;
  }

  async function decodeFile(file) {
    const ctx = getAudioCtx();
    await ctx.resume();
    const data = await file.arrayBuffer();
    return await ctx.decodeAudioData(data);
  }

  function getMonoSamples(buffer) {
    const ch0 = buffer.getChannelData(0);
    if (buffer.numberOfChannels === 1) return ch0;

    // Average channels (avoid extra allocations)
    const out = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += ch[i];
    }
    for (let i = 0; i < out.length; i++) out[i] /= buffer.numberOfChannels;
    return out;
  }

  // ---------- Canvas sizing ----------
  function resizeCanvasToCSS() {
    const dpr = window.devicePixelRatio || 1;
    const rect = elCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (elCanvas.width !== w || elCanvas.height !== h) {
      elCanvas.width = w;
      elCanvas.height = h;
    }
  }

  // ---------- Peak / click detection ----------
  // Robust, no Math.max(...bigArray), no massive intermediate arrays.
  function detectClicks(samples, sr) {
    // 1) estimate max abs quickly
    let maxAbs = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      const a = v < 0 ? -v : v;
      if (a > maxAbs) maxAbs = a;
    }

    // If file is quiet, bail
    if (!isFinite(maxAbs) || maxAbs <= 0) return [];

    // 2) adaptive threshold
    // click tracks are usually very peaky; 0.25–0.45 works well.
    const threshold = maxAbs * 0.35;

    // 3) peak picking with min gap & “local maximum” refinement
    const minGapSec = 0.07;
    const minGap = Math.floor(minGapSec * sr);

    const clicks = [];
    let i = 0;

    while (i < samples.length) {
      const a = samples[i] < 0 ? -samples[i] : samples[i];
      if (a >= threshold) {
        // walk forward to find the true local max within a short window
        const win = Math.min(i + Math.floor(0.02 * sr), samples.length - 1);
        let peakI = i;
        let peakA = a;

        for (let j = i + 1; j <= win; j++) {
          const aj = samples[j] < 0 ? -samples[j] : samples[j];
          if (aj > peakA) {
            peakA = aj;
            peakI = j;
          }
        }

        clicks.push(peakI / sr);
        i = peakI + minGap; // enforce gap
      } else {
        i++;
      }
    }

    return clicks;
  }

  // ---------- FFT feature: spectral centroid ----------
  // Uses OfflineAudioContext + Analyser to get freq bins in dB, then centroid.
  async function centroidAt(samples, sr, timeSec) {
    const fftSize = 2048;
    const start = Math.floor(timeSec * sr);

    if (start < 0 || start + fftSize >= samples.length) return 0;

    // Copy window
    const window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) window[i] = samples[start + i];

    const offline = new OfflineAudioContext(1, fftSize, sr);
    const buf = offline.createBuffer(1, fftSize, sr);
    buf.copyToChannel(window, 0);

    const src = offline.createBufferSource();
    const analyser = offline.createAnalyser();
    analyser.fftSize = fftSize;

    src.buffer = buf;
    src.connect(analyser);
    analyser.connect(offline.destination);
    src.start(0);

    await offline.startRendering();

    const freqData = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqData);

    return spectralCentroid(freqData, sr, fftSize);
  }

  function spectralCentroid(freqDataDb, sampleRate, fftSize) {
    let weightedSum = 0;
    let magSum = 0;

    // ignore very low bins to reduce DC/rumble influence
    const minHz = 80;
    const minBin = Math.floor((minHz * fftSize) / sampleRate);

    for (let i = minBin; i < freqDataDb.length; i++) {
      // Convert dB -> linear magnitude
      const mag = Math.pow(10, freqDataDb[i] / 20);
      const freq = (i * sampleRate) / fftSize;
      weightedSum += freq * mag;
      magSum += mag;
    }

    return magSum > 0 ? weightedSum / magSum : 0;
  }

  // ---------- 1D k-means (k=2) for centroid clustering ----------
  function kmeans2(values, iters = 25) {
    if (values.length < 2) return { c1: 0, c2: 0, labels: values.map(() => 0) };

    // init: pick 20th and 80th percentile
    const sorted = [...values].sort((a, b) => a - b);
    let c1 = sorted[Math.floor(sorted.length * 0.2)];
    let c2 = sorted[Math.floor(sorted.length * 0.8)];

    let labels = new Array(values.length).fill(0);

    for (let t = 0; t < iters; t++) {
      // assign
      let sum1 = 0, n1 = 0, sum2 = 0, n2 = 0;

      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const d1 = Math.abs(v - c1);
        const d2 = Math.abs(v - c2);
        const lab = d1 <= d2 ? 0 : 1;
        labels[i] = lab;
        if (lab === 0) { sum1 += v; n1++; } else { sum2 += v; n2++; }
      }

      // avoid empty cluster
      if (n1 === 0 || n2 === 0) break;

      const nc1 = sum1 / n1;
      const nc2 = sum2 / n2;

      if (Math.abs(nc1 - c1) < 1e-6 && Math.abs(nc2 - c2) < 1e-6) break;
      c1 = nc1; c2 = nc2;
    }

    return { c1, c2, labels };
  }

  // ---------- Beats-per-bar autodetect (scoring both assignments) ----------
  function inferBeatsPerBarFromDownbeats(clickCountBetweenDownbeats) {
    // choose the mode in a plausible range
    const hist = new Map();
    for (const n of clickCountBetweenDownbeats) {
      if (n >= 2 && n <= 12) hist.set(n, (hist.get(n) || 0) + 1);
    }
    let best = null;
    let bestCount = -1;
    for (const [k, v] of hist.entries()) {
      if (v > bestCount) { bestCount = v; best = k; }
    }
    return best; // may be null
  }

  function scoreDownbeatAssignment(downbeatIdxs, totalClicks) {
    // Score: stable beat counts per bar + enough bars + plausible beats-per-bar.
    if (downbeatIdxs.length < 3) return { score: Infinity, beatsPerBar: null };

    const diffs = [];
    for (let i = 1; i < downbeatIdxs.length; i++) {
      diffs.push(downbeatIdxs[i] - downbeatIdxs[i - 1]);
    }

    const beatsPerBar = inferBeatsPerBarFromDownbeats(diffs);
    if (!beatsPerBar) return { score: Infinity, beatsPerBar: null };

    // compute variance vs beatsPerBar
    let sumSq = 0;
    for (const d of diffs) {
      const e = d - beatsPerBar;
      sumSq += e * e;
    }
    const variance = sumSq / diffs.length;

    // penalties
    const coverage = downbeatIdxs.length / totalClicks; // expected ~1/4 if 4/4
    const coveragePenalty = Math.abs(coverage - (1 / beatsPerBar)) * 10;

    // prefer more bars
    const barsBonus = -Math.min(20, downbeatIdxs.length) * 0.05;

    return { score: variance + coveragePenalty + barsBonus, beatsPerBar };
  }

  // ---------- Tempo estimation + segmentation ----------
  function bpmSeriesFromClicks(clicks) {
    const bpm = new Array(clicks.length).fill(null);
    for (let i = 1; i < clicks.length; i++) {
      const dt = clicks[i] - clicks[i - 1];
      bpm[i] = dt > 0 ? 60 / dt : null;
    }
    return bpm;
  }

  function medianOf(arr) {
    const a = arr.filter(v => v != null && isFinite(v));
    if (!a.length) return null;
    a.sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function segmentTempo(clicks, bpmPerClick, opts = {}) {
    const tolBpm = opts.toleranceBpm ?? 1.0;
    const confirmCount = opts.confirmCount ?? 4; // consecutive clicks needed
    const smoothWindow = opts.smoothWindow ?? 9;

    // smooth by median filter
    const smoothed = bpmPerClick.slice();
    for (let i = 0; i < smoothed.length; i++) {
      const lo = Math.max(1, i - Math.floor(smoothWindow / 2));
      const hi = Math.min(smoothed.length - 1, i + Math.floor(smoothWindow / 2));
      const window = [];
      for (let j = lo; j <= hi; j++) window.push(smoothed[j]);
      smoothed[i] = medianOf(window);
    }

    const segments = [];
    let segStartIdx = 1;
    let segBpm = smoothed[1];

    if (segBpm == null) return { smoothed, segments: [] };

    let pendingStart = null;
    let pendingCount = 0;
    let pendingBpm = null;

    const finalize = (endIdxExclusive) => {
      const startTime = clicks[segStartIdx];
      const endTime = clicks[Math.min(endIdxExclusive, clicks.length - 1)];
      segments.push({
        startTime,
        endTime,
        bpm: segBpm
      });
    };

    for (let i = 2; i < clicks.length; i++) {
      const b = smoothed[i];
      if (b == null) continue;

      const diff = Math.abs(b - segBpm);

      if (diff > tolBpm) {
        if (pendingStart == null) {
          pendingStart = i;
          pendingBpm = b;
          pendingCount = 1;
        } else {
          pendingCount++;
          pendingBpm = b;
        }

        if (pendingCount >= confirmCount) {
          // close previous segment at pendingStart
          finalize(pendingStart);
          segStartIdx = pendingStart;
          segBpm = pendingBpm;
          pendingStart = null;
          pendingCount = 0;
          pendingBpm = null;
        }
      } else {
        pendingStart = null;
        pendingCount = 0;
        pendingBpm = null;
      }
    }

    // finalize last segment
    finalize(clicks.length - 1);

    return { smoothed, segments };
  }

  // ---------- Waveform rendering + overlays ----------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function secondsToX(t) {
    const { start, secondsPerScreen } = g.view;
    const w = elCanvas.width;
    return ((t - start) / secondsPerScreen) * w;
  }

  function xToSeconds(x) {
    const { start, secondsPerScreen } = g.view;
    const w = elCanvas.width;
    return start + (x / w) * secondsPerScreen;
  }

  function draw() {
    resizeCanvasToCSS();
    const ctx = elCanvas.getContext("2d");
    const w = elCanvas.width;
    const h = elCanvas.height;

    // background
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, w, h);

    if (!g.samples) return;

    // clamp view
    const maxStart = Math.max(0, g.duration - g.view.secondsPerScreen);
    g.view.start = clamp(g.view.start, 0, maxStart);

    // waveform
    drawWaveformWindow(ctx, w, h);

    // overlays: beats and downbeats
    drawBeatOverlay(ctx, w, h);

    // top info strip
    drawHUD(ctx, w, h);
  }

  function drawWaveformWindow(ctx, w, h) {
    const { start, secondsPerScreen } = g.view;
    const sr = g.sr;
    const samples = g.samples;

    const startSamp = Math.floor(start * sr);
    const endSamp = Math.min(samples.length - 1, Math.floor((start + secondsPerScreen) * sr));
    const span = Math.max(1, endSamp - startSamp);

    // draw min/max per pixel (fast and nice)
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1));

    const mid = h / 2;
    ctx.beginPath();

    for (let x = 0; x < w; x++) {
      const t0 = x / w;
      const t1 = (x + 1) / w;

      const i0 = startSamp + Math.floor(t0 * span);
      const i1 = startSamp + Math.floor(t1 * span);

      let min = 1, max = -1;
      for (let i = i0; i < i1; i++) {
        const v = samples[i] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }

      const y1 = mid - max * mid;
      const y2 = mid - min * mid;

      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }

    ctx.stroke();

    // center line
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "#94a3b8";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawBeatOverlay(ctx, w, h) {
    if (!g.events.length) return;

    // Only draw events within view
    const viewStart = g.view.start;
    const viewEnd = g.view.start + g.view.secondsPerScreen;

    for (const e of g.events) {
      if (e.time < viewStart || e.time > viewEnd) continue;

      const x = secondsToX(e.time);
      ctx.globalAlpha = e.isDownbeat ? 0.95 : 0.55;
      ctx.strokeStyle = e.isDownbeat ? "#fb7185" : "#a5b4fc"; // downbeat: pink/red, beat: indigo
      ctx.lineWidth = e.isDownbeat ? 2 : 1;

      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  function drawHUD(ctx, w, h) {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "rgba(15,23,42,0.85)";
    ctx.fillRect(0, 0, w, Math.max(28, h * 0.12));

    ctx.fillStyle = "#e2e8f0";
    ctx.font = `${Math.max(12, Math.floor(h * 0.06))}px system-ui, sans-serif`;

    const z = g.view.secondsPerScreen.toFixed(2);
    const s = g.view.start.toFixed(2);

    const bpb = g.beatsPerBar ? `${g.beatsPerBar}` : "—";

    const seg = g.tempo.segments?.[0]?.bpm != null ? `${g.tempo.segments.length} segment(s)` : "—";
    const text = `View: start ${s}s | zoom ${z}s/screen | clicks ${g.clicks.length} | beats/bar ${bpb} | tempo ${seg}`;
    ctx.fillText(text, 10, Math.max(18, h * 0.08));

    ctx.globalAlpha = 1;
  }

  // ---------- Interaction: zoom + pan ----------
  function setupInteractions() {
    // wheel: zoom (default), shift+wheel pan
    elCanvas.addEventListener("wheel", (ev) => {
      if (!g.samples) return;
      ev.preventDefault();

      const rect = elCanvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = (ev.clientX - rect.left) * dpr;

      if (ev.shiftKey) {
        // horizontal pan
        const deltaSec = (ev.deltaY / 100) * (g.view.secondsPerScreen * 0.15);
        g.view.start = g.view.start + deltaSec;
        draw();
        return;
      }

      // zoom around cursor
      const cursorTime = xToSeconds(x);
      const zoomFactor = Math.exp(ev.deltaY * 0.0012); // smooth
      const newSPS = clamp(
        g.view.secondsPerScreen * zoomFactor,
        g.view.minSecondsPerScreen,
        g.view.maxSecondsPerScreen
      );

      // preserve cursorTime under mouse
      const before = cursorTime;
      g.view.secondsPerScreen = newSPS;
      const after = xToSeconds(x);
      g.view.start += (before - after);

      draw();
    }, { passive: false });

    // drag to pan
    elCanvas.addEventListener("pointerdown", (ev) => {
      if (!g.samples) return;
      elCanvas.setPointerCapture(ev.pointerId);
      g.view.isDragging = true;
      g.view.dragStartX = ev.clientX;
      g.view.dragStartViewStart = g.view.start;
    });

    elCanvas.addEventListener("pointermove", (ev) => {
      if (!g.view.isDragging || !g.samples) return;
      const rect = elCanvas.getBoundingClientRect();
      const dxPx = ev.clientX - g.view.dragStartX;
      const dxNorm = dxPx / Math.max(1, rect.width);
      const dxSec = dxNorm * g.view.secondsPerScreen;
      g.view.start = g.view.dragStartViewStart - dxSec;
      draw();
    });

    const endDrag = (ev) => {
      if (!g.view.isDragging) return;
      g.view.isDragging = false;
      try { elCanvas.releasePointerCapture(ev.pointerId); } catch {}
      draw();
    };
    elCanvas.addEventListener("pointerup", endDrag);
    elCanvas.addEventListener("pointercancel", endDrag);

    window.addEventListener("resize", () => draw());
  }

  // ---------- Classification + beats/bar selection ----------
  function buildEvents(clicks, centroids, assignment) {
    // assignment: array same length as clicks, boolean isDownbeat
    const events = [];
    for (let i = 0; i < clicks.length; i++) {
      events.push({
        index: i,
        time: clicks[i],
        centroid: centroids[i],
        isDownbeat: !!assignment[i]
      });
    }
    return events;
  }

  function computeDownbeatIdxs(events) {
    const idxs = [];
    for (const e of events) if (e.isDownbeat) idxs.push(e.index);
    return idxs;
  }

  function chooseBestDownbeatAssignment(eventsCentroidOnly) {
    // eventsCentroidOnly: [{time, centroid}]
    const centroids = eventsCentroidOnly.map(e => e.centroid);
    const { c1, c2, labels } = kmeans2(centroids);

    // Two possible interpretations:
    // A) label 0 is downbeat (smaller cluster expectation is not always true)
    // B) label 1 is downbeat
    const assignA = labels.map(l => l === 0);
    const assignB = labels.map(l => l === 1);

    const dummyClicks = eventsCentroidOnly.length;

    const eventsA = buildEvents(
      eventsCentroidOnly.map(e => e.time),
      centroids,
      assignA
    );
    const eventsB = buildEvents(
      eventsCentroidOnly.map(e => e.time),
      centroids,
      assignB
    );

    const downA = computeDownbeatIdxs(eventsA);
    const downB = computeDownbeatIdxs(eventsB);

    const scoreA = scoreDownbeatAssignment(downA, dummyClicks);
    const scoreB = scoreDownbeatAssignment(downB, dummyClicks);

    // tie-break: if both Infinity, fallback to smaller cluster = downbeat
    if (!isFinite(scoreA.score) && !isFinite(scoreB.score)) {
      const n0 = labels.filter(l => l === 0).length;
      const n1 = labels.length - n0;
      const smallerIsDown = n0 <= n1 ? 0 : 1;
      const assignment = labels.map(l => l === smallerIsDown);
      const events = buildEvents(eventsCentroidOnly.map(e => e.time), centroids, assignment);
      return { events, beatsPerBar: null, kmeans: { c1, c2, labels } };
    }

    if (scoreA.score <= scoreB.score) {
      return { events: eventsA, beatsPerBar: scoreA.beatsPerBar, kmeans: { c1, c2, labels } };
    } else {
      return { events: eventsB, beatsPerBar: scoreB.beatsPerBar, kmeans: { c1, c2, labels } };
    }
  }

  // ---------- Main Analyze ----------
  elBtn.addEventListener("click", async () => {
    try {
      if (!elFile.files || !elFile.files.length) return;

      elBtn.disabled = true;
      elOut.textContent = "Analyzing…";

      const file = elFile.files[0];
      const buffer = await decodeFile(file);

      g.audioBuffer = buffer;
      g.samples = getMonoSamples(buffer);
      g.sr = buffer.sampleRate;
      g.duration = buffer.duration;

      // initial view: show first 10s or full duration if shorter
      g.view.start = 0;
      g.view.secondsPerScreen = clamp(Math.min(10, g.duration || 10), g.view.minSecondsPerScreen, g.view.maxSecondsPerScreen);

      // 1) detect clicks
      const clicks = detectClicks(g.samples, g.sr);
      g.clicks = clicks;

      if (clicks.length < 4) {
        elOut.textContent = "Not enough clicks detected. Try a louder click track or adjust detection parameters.";
        draw();
        return;
      }

      // 2) centroid per click
      // NOTE: FFT per click is expensive; this is fine for click tracks, but you can optimize later.
      const centroids = [];
      for (let i = 0; i < clicks.length; i++) {
        const c = await centroidAt(g.samples, g.sr, clicks[i]);
        centroids.push(c);
      }

      // 3) choose best downbeat assignment + beats/bar
      const centroidEvents = clicks.map((t, i) => ({ time: t, centroid: centroids[i] }));
      const chosen = chooseBestDownbeatAssignment(centroidEvents);
      g.events = chosen.events;
      g.beatsPerBar = chosen.beatsPerBar;

      // 4) tempo series + segmentation
      const bpmPerClick = bpmSeriesFromClicks(clicks);
      const seg = segmentTempo(clicks, bpmPerClick, {
        toleranceBpm: 1.0,
        confirmCount: 4,
        smoothWindow: 9
      });

      g.tempo.bpmPerClick = seg.smoothed;
      g.tempo.segments = seg.segments;

      // 5) output JSON (for now)
      elOut.textContent = JSON.stringify({
        clicksDetected: clicks.length,
        beatsPerBar: g.beatsPerBar,
        tempoSegments: g.tempo.segments,
        events: g.events.map(e => ({
          index: e.index,
          time: e.time,
          centroid: Number(e.centroid.toFixed(2)),
          isDownbeat: e.isDownbeat
        }))
      }, null, 2);

      // draw waveform + overlays
      draw();
    } catch (err) {
      console.error(err);
      elOut.textContent = `Error: ${err?.message || String(err)}`;
    } finally {
      elBtn.disabled = false;
    }
  });

  // ---------- Init ----------
  setupInteractions();
  resizeCanvasToCSS();
  draw();

})();
