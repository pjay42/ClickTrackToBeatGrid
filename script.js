
(() => {
  "use strict";

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function pickEl(label, ids) {
    for (const id of ids) {
      const el = $(id);
      if (el) return el;
    }
    console.error(`Missing required DOM element: ${label} (tried: ${ids.join(", ")})`);
    return null;
  }

  // These support your earlier variants + common alternatives
  const fileInput = pickEl("fileInput", ["fileInput", "file", "audioFile"]);
  const processBtn = pickEl("processBtn", ["processBtn", "analyze", "analyzeBtn"]);
  const canvas = pickEl("waveform", ["waveform", "canvas", "waveCanvas"]);
  const output = pickEl("output", ["output", "result", "jsonOutput"]);

  if (!fileInput || !processBtn || !canvas || !output) {
    console.error("Missing required DOM elements: fileInput, processBtn, waveform, output");
    return;
  }

  const ctx2d = canvas.getContext("2d");

  // ---------- Audio ----------
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  async function decodeAudioFile(file) {
    const data = await file.arrayBuffer();
    return await audioCtx.decodeAudioData(data);
  }

  // ---------- Utils ----------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function arrayMaxAbs(samples) {
    // avoids Math.max(...abs) call stack issues
    let m = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > m) m = v;
    }
    return m;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function rollingMedian(values, win = 5) {
    const half = Math.floor(win / 2);
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const s = Math.max(0, i - half);
      const e = Math.min(values.length, i + half + 1);
      out[i] = median(values.slice(s, e));
    }
    return out;
  }

  // ---------- Click detection ----------
  function detectClicks(samples, sr, opts = {}) {
    const maxAbs = arrayMaxAbs(samples);
    const threshold = (opts.thresholdFrac ?? 0.35) * maxAbs; // adaptive
    const minGap = opts.minGap ?? 0.08; // seconds
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

  // ---------- FFT centroid (band-limited + noise-gated) ----------
  function spectralCentroidFromDB(freqDataDB, sampleRate, fftSize, band = { lo: 200, hi: 6000 }) {
    // Convert dB -> linear amplitude; ignore -Infinity; ignore bins outside band; ignore noise floor
    const binHz = sampleRate / fftSize;

    const loBin = Math.floor(band.lo / binHz);
    const hiBin = Math.min(freqDataDB.length - 1, Math.ceil(band.hi / binHz));

    // Estimate noise floor from lower quantile in-band
    const mags = [];
    for (let i = loBin; i <= hiBin; i++) {
      const db = freqDataDB[i];
      if (!Number.isFinite(db)) continue;
      mags.push(db);
    }
    mags.sort((a, b) => a - b);
    const floorDB = mags.length ? mags[Math.floor(mags.length * 0.2)] : -120; // 20th percentile
    const gateDB = floorDB + 12; // keep bins 12dB above floor

    let weightedSum = 0;
    let magnitudeSum = 0;

    for (let i = loBin; i <= hiBin; i++) {
      const db = freqDataDB[i];
      if (!Number.isFinite(db)) continue;
      if (db < gateDB) continue;

      // dB (amplitude) to linear amplitude
      const mag = Math.pow(10, db / 20);
      const freq = i * binHz;

      weightedSum += freq * mag;
      magnitudeSum += mag;
    }

    return magnitudeSum > 0 ? (weightedSum / magnitudeSum) : 0;
  }

  async function analyzeFFTcentroid(samples, sr, time, opts = {}) {
    const fftSize = opts.fftSize ?? 2048;
    const start = Math.floor(time * sr);
    if (start + fftSize >= samples.length) return 0;

    // Offline context just for this window
    const offline = new OfflineAudioContext(1, fftSize, sr);
    const buf = offline.createBuffer(1, fftSize, sr);

    // Copy a short window
    const slice = samples.slice(start, start + fftSize);
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

    return spectralCentroidFromDB(freqData, sr, fftSize, opts.band ?? { lo: 200, hi: 6000 });
  }

  // ---------- 2-means clustering for downbeat classification ----------
  function kmeans2(values, iters = 20) {
    if (values.length < 2) return { c1: values[0] ?? 0, c2: values[0] ?? 0, labels: values.map(() => 0) };

    const minV = Math.min(...values);
    const maxV = Math.max(...values);

    let c1 = minV;
    let c2 = maxV;

    const labels = new Array(values.length).fill(0);

    for (let it = 0; it < iters; it++) {
      // assign
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        labels[i] = (Math.abs(v - c1) <= Math.abs(v - c2)) ? 0 : 1;
      }
      // update
      let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
      for (let i = 0; i < values.length; i++) {
        if (labels[i] === 0) { s1 += values[i]; n1++; }
        else { s2 += values[i]; n2++; }
      }
      const nc1 = n1 ? (s1 / n1) : c1;
      const nc2 = n2 ? (s2 / n2) : c2;

      if (Math.abs(nc1 - c1) < 1e-6 && Math.abs(nc2 - c2) < 1e-6) break;
      c1 = nc1; c2 = nc2;
    }

    return { c1, c2, labels };
  }

  function classifyDownbeats(events) {
    // events: [{time, centroid}]
    const cents = events.map(e => e.centroid);
    const { labels } = kmeans2(cents);

    const group0 = [];
    const group1 = [];
    for (let i = 0; i < events.length; i++) {
      (labels[i] === 0 ? group0 : group1).push(events[i]);
    }

    // fewer = downbeats (typical)
    const downbeats = group0.length <= group1.length ? group0 : group1;
    const beats = group0.length <= group1.length ? group1 : group0;

    return { downbeats, beats };
  }

  // ---------- Beats-per-bar autodetect ----------
  function detectBeatsPerBar(clickTimes, downbeatTimes, maxBeatsPerBar = 12) {
    if (clickTimes.length < 4 || downbeatTimes.length < 2) return { beatsPerBar: 4, confidence: 0 };

    // Map each downbeat time to nearest click index
    const downIdx = downbeatTimes.map(t => nearestIndex(clickTimes, t)).sort((a, b) => a - b);

    // Differences between successive downbeat indices => beats per bar
    const diffs = [];
    for (let i = 1; i < downIdx.length; i++) {
      const d = downIdx[i] - downIdx[i - 1];
      if (d >= 2 && d <= maxBeatsPerBar) diffs.push(d);
    }
    if (!diffs.length) return { beatsPerBar: 4, confidence: 0 };

    // Mode of diffs
    const hist = new Map();
    for (const d of diffs) hist.set(d, (hist.get(d) ?? 0) + 1);

    let best = 4, bestCount = -1;
    for (const [k, v] of hist.entries()) {
      if (v > bestCount) { best = k; bestCount = v; }
    }

    const confidence = bestCount / diffs.length;
    return { beatsPerBar: best, confidence };
  }

  function nearestIndex(sortedTimes, t) {
    // binary search nearest
    let lo = 0, hi = sortedTimes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedTimes[mid] < t) lo = mid + 1;
      else hi = mid - 1;
    }
    const i = clamp(lo, 0, sortedTimes.length - 1);
    const j = clamp(i - 1, 0, sortedTimes.length - 1);
    return (Math.abs(sortedTimes[i] - t) < Math.abs(sortedTimes[j] - t)) ? i : j;
  }

  // ---------- Tempo change segmentation ----------
  function computeBpmSeries(clickTimes) {
    const bpms = [];
    for (let i = 1; i < clickTimes.length; i++) {
      const dt = clickTimes[i] - clickTimes[i - 1];
      bpms.push(dt > 0 ? 60 / dt : 0);
    }
    return bpms;
  }

  function segmentTempo(clickTimes, opts = {}) {
    const tolerance = opts.tolerance ?? 1.0;      // bpm delta to consider a change
    const debounce = opts.debounce ?? 3;          // consecutive intervals required
    const smoothWin = opts.smoothWin ?? 5;

    const raw = computeBpmSeries(clickTimes);
    const smoothed = rollingMedian(raw, smoothWin);

    // segments in terms of click index boundaries
    const segments = [];
    if (!smoothed.length) return { segments, raw, smoothed };

    let segStartClickIndex = 0;
    let current = smoothed[0];
    let streak = 0;

    for (let i = 1; i < smoothed.length; i++) {
      const bpm = smoothed[i];
      if (Math.abs(bpm - current) > tolerance) {
        streak++;
        if (streak >= debounce) {
          // finalize previous segment ending at click i (since bpm[i] is interval between clicks i and i+1)
          const endClickIndex = i; // segment ends at click i
          segments.push({
            startTime: clickTimes[segStartClickIndex],
            endTime: clickTimes[endClickIndex],
            bpm: current
          });

          // start new segment at click i
          segStartClickIndex = i;
          current = bpm;
          streak = 0;
        }
      } else {
        streak = 0;
        // slowly track within tolerance
        current = (current * 0.9) + (bpm * 0.1);
      }
    }

    // final segment
    segments.push({
      startTime: clickTimes[segStartClickIndex],
      endTime: clickTimes[clickTimes.length - 1],
      bpm: current
    });

    return { segments, raw, smoothed };
  }

  // ---------- Waveform zoom/scroll + overlay ----------
  const viewState = {
    zoom: 1,           // 1 = fit entire file
    offsetSec: 0,      // viewport start time
    durationSec: 0,
    isPanning: false,
    panStartX: 0,
    panStartOffset: 0
  };

  function resizeCanvasToCSS() {
    const w = Math.max(300, canvas.clientWidth || 900);
    const h = Math.max(120, canvas.clientHeight || 200);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  function secondsPerView() {
    // zoom=1 => full duration in view. zoom=2 => half duration, etc.
    return viewState.durationSec > 0 ? (viewState.durationSec / viewState.zoom) : 0;
  }

  function timeToX(t) {
    const spv = secondsPerView();
    if (!spv) return 0;
    const rel = (t - viewState.offsetSec) / spv;
    return rel * canvas.width;
  }

  function xToTime(x) {
    const spv = secondsPerView();
    return viewState.offsetSec + (x / canvas.width) * spv;
  }

  function drawWaveformViewport(samples, sr, clicks, downbeats) {
    resizeCanvasToCSS();

    const w = canvas.width, h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);

    // background
    ctx2d.fillStyle = "#020617";
    ctx2d.fillRect(0, 0, w, h);

    const spv = secondsPerView();
    if (!spv || !samples.length) return;

    const startSec = viewState.offsetSec;
    const endSec = startSec + spv;

    const startIdx = Math.floor(startSec * sr);
    const endIdx = Math.min(samples.length - 1, Math.ceil(endSec * sr));

    // waveform
    ctx2d.strokeStyle = "#38bdf8";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();

    const mid = h / 2;
    const span = Math.max(1, endIdx - startIdx);
    const step = Math.max(1, Math.floor(span / w));

    for (let x = 0; x < w; x++) {
      const i = startIdx + x * step;
      if (i >= endIdx) break;

      // peak in this pixel column for nicer display
      let min = 1, max = -1;
      const stop = Math.min(endIdx, i + step);
      for (let j = i; j < stop; j++) {
        const v = samples[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }

      const y1 = mid + min * mid;
      const y2 = mid + max * mid;
      ctx2d.moveTo(x, y1);
      ctx2d.lineTo(x, y2);
    }
    ctx2d.stroke();

    // overlay clicks
    if (clicks && clicks.length) {
      // regular beats
      ctx2d.strokeStyle = "rgba(226,232,240,0.35)";
      ctx2d.lineWidth = 1;
      for (const t of clicks) {
        if (t < startSec || t > endSec) continue;
        const x = timeToX(t);
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, h);
        ctx2d.stroke();
      }
    }

    // overlay downbeats
    if (downbeats && downbeats.length) {
      ctx2d.strokeStyle = "rgba(248,113,113,0.85)";
      ctx2d.lineWidth = 2;
      for (const t of downbeats) {
        if (t < startSec || t > endSec) continue;
        const x = timeToX(t);
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, h);
        ctx2d.stroke();
      }
    }

    // top info
    ctx2d.fillStyle = "rgba(226,232,240,0.85)";
    ctx2d.font = "12px system-ui, sans-serif";
    ctx2d.fillText(
      `zoom: ${viewState.zoom.toFixed(2)}  view: ${startSec.toFixed(2)}s–${endSec.toFixed(2)}s`,
      10, 16
    );
  }

  function attachZoomAndPan(renderFn) {
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();

      // zoom around mouse position
      const mouseX = e.offsetX;
      const anchorTime = xToTime(mouseX);

      const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = clamp(viewState.zoom * zoomFactor, 1, 200);

      // keep anchor time under cursor
      const oldSpv = secondsPerView();
      viewState.zoom = newZoom;
      const newSpv = secondsPerView();

      const anchorRel = (anchorTime - viewState.offsetSec) / oldSpv; // 0..1
      viewState.offsetSec = anchorTime - anchorRel * newSpv;

      // clamp offset
      viewState.offsetSec = clamp(viewState.offsetSec, 0, Math.max(0, viewState.durationSec - newSpv));

      renderFn();
    }, { passive: false });

    canvas.addEventListener("mousedown", (e) => {
      viewState.isPanning = true;
      viewState.panStartX = e.clientX;
      viewState.panStartOffset = viewState.offsetSec;
    });

    window.addEventListener("mousemove", (e) => {
      if (!viewState.isPanning) return;
      const dx = e.clientX - viewState.panStartX;

      const spv = secondsPerView();
      const secPerPx = spv / canvas.width;
      viewState.offsetSec = viewState.panStartOffset - dx * secPerPx;

      viewState.offsetSec = clamp(viewState.offsetSec, 0, Math.max(0, viewState.durationSec - spv));
      renderFn();
    });

    window.addEventListener("mouseup", () => {
      viewState.isPanning = false;
    });
  }

  // ---------- Main flow ----------
  let lastAnalysis = null;

  function render() {
    if (!lastAnalysis) return;
    drawWaveformViewport(
      lastAnalysis.samples,
      lastAnalysis.sr,
      lastAnalysis.clicks,
      lastAnalysis.downbeatTimes
    );
  }

  attachZoomAndPan(render);

  processBtn.addEventListener("click", async () => {
    try {
      if (!fileInput.files || !fileInput.files.length) return;

      // Required for Chrome / Safari gesture policies
      await audioCtx.resume();

      output.textContent = "Decoding audio...";
      const file = fileInput.files[0];
      const buffer = await decodeAudioFile(file);

      // mixdown to mono if needed
      const sr = buffer.sampleRate;
      let samples = buffer.getChannelData(0);
      if (buffer.numberOfChannels > 1) {
        const ch1 = buffer.getChannelData(0);
        const ch2 = buffer.getChannelData(1);
        const mono = new Float32Array(buffer.length);
        for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (ch1[i] + ch2[i]);
        samples = mono;
      }

      viewState.durationSec = samples.length / sr;
      viewState.zoom = 1;
      viewState.offsetSec = 0;

      output.textContent = "Detecting clicks...";
      const clicks = detectClicks(samples, sr, { thresholdFrac: 0.35, minGap: 0.08 });

      output.textContent = `Found ${clicks.length} clicks. Analyzing tone...`;

      // Analyze centroid per click (batch with occasional UI yields)
      const events = [];
      for (let i = 0; i < clicks.length; i++) {
        const t = clicks[i];
        const centroid = await analyzeFFTcentroid(samples, sr, t, {
          fftSize: 2048,
          band: { lo: 200, hi: 6000 }
        });
        events.push({ time: t, centroid });

        if (i % 50 === 0) {
          output.textContent = `Analyzing tone... ${i}/${clicks.length}`;
          await new Promise(r => setTimeout(r, 0));
        }
      }

      // classify downbeats
      const { downbeats, beats } = classifyDownbeats(events);
      const downbeatTimes = downbeats.map(e => e.time).sort((a, b) => a - b);

      // beats-per-bar autodetect
      const { beatsPerBar, confidence } = detectBeatsPerBar(clicks, downbeatTimes);

      // tempo segmentation
      const tempo = segmentTempo(clicks, { tolerance: 1.0, debounce: 3, smoothWin: 5 });

      // store for rendering
      lastAnalysis = { samples, sr, clicks, downbeatTimes };
      render();

      // output JSON
      output.textContent = JSON.stringify({
        summary: {
          clicks: clicks.length,
          downbeats: downbeats.length,
          beatsPerBar,
          beatsPerBarConfidence: Number(confidence.toFixed(3)),
          tempoSegments: tempo.segments.length
        },
        tempoSegments: tempo.segments.map(s => ({
          startTime: Number(s.startTime.toFixed(4)),
          endTime: Number(s.endTime.toFixed(4)),
          bpm: Number(s.bpm.toFixed(3))
        })),
        events: events.map(e => ({
          time: Number(e.time.toFixed(6)),
          centroid: Number(e.centroid.toFixed(2)),
          isDownbeat: downbeatTimes.includes(e.time) // exact match since sourced from events
        }))
      }, null, 2);

    } catch (err) {
      console.error(err);
      output.textContent = `Error: ${err && err.message ? err.message : String(err)}`;
    }
  });
})();
