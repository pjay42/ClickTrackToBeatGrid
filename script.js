(() => {
  "use strict";

  // -----------------------------
  // DOM + state
  // -----------------------------
  const fileInput = document.getElementById("fileInput");
  const processBtn = document.getElementById("processBtn");
  const canvas = document.getElementById("waveform");
  const output = document.getElementById("output");
  const zoomInput = document.getElementById("zoom");

  if (!fileInput || !processBtn || !canvas || !output || !zoomInput) {
    console.error("Missing required DOM elements: fileInput, processBtn, waveform, output, zoom");
    return;
  }

  // Create / ensure pan slider + labels
  const ui = ensureZoomPanUI();

  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) {
    console.error("Canvas 2D context not available.");
    return;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioCtx();

  /** @type {{
   *  buffer: AudioBuffer|null,
   *  samples: Float32Array|null,
   *  sr: number,
   *  duration: number,
   *  beats: Array<{time:number, centroid:number, isDownbeat:boolean, bpm:number}>,
   *  visibleStartSec: number,
   *  visibleDurSec: number,
   *  selectedBeatIndex: number,
   * }} */
  const state = {
    buffer: null,
    samples: null,
    sr: 0,
    duration: 0,
    beats: [],
    visibleStartSec: 0,
    visibleDurSec: 0,
    selectedBeatIndex: -1,
  };

  // Tooltip
  const tooltip = makeTooltip();

  // -----------------------------
  // Events
  // -----------------------------
  processBtn.addEventListener("click", async () => {
    try {
      if (!fileInput.files || !fileInput.files.length) return;

      // Required for Safari/Chrome: unlock audio context
      await audioCtx.resume();

      const file = fileInput.files[0];
      const buffer = await decodeAudio(file);
      const samples = toMono(buffer);
      const sr = buffer.sampleRate;

      state.buffer = buffer;
      state.samples = samples;
      state.sr = sr;
      state.duration = buffer.duration;
      state.selectedBeatIndex = -1;

      // Detect click times
      const clickTimes = detectClicks(samples, sr);

      // Feature extraction (centroid)
      const events = [];
      for (const t of clickTimes) {
        const centroid = await analyzeCentroidOffline(samples, sr, t);
        events.push({ time: t, centroid });
      }

      // Classify downbeats vs upbeats (robust 2-means on centroid)
      const classified = classifyByCentroidKMeans(events);

      // Compute BPM per beat + segment changes
      const beatsWithTempo = computeBpmPerBeat(classified);

      // Final beats list (chronological)
      state.beats = beatsWithTempo.sort((a, b) => a.time - b.time);

      // Setup viewport (zoom/pan)
      state.visibleStartSec = 0;
      state.visibleDurSec = computeVisibleDuration(state.duration, Number(ui.zoom.value));
      syncPanSlider();

      // Render
      resizeCanvasForHiDPI();
      renderAll();

      // Output table
      renderBeatTable();

      // enable UI
      ui.pan.disabled = state.beats.length === 0;
      ui.zoom.disabled = state.beats.length === 0;
    } catch (err) {
      console.error(err);
      output.textContent = String(err?.message || err);
    }
  });

  // Zoom / pan
  ui.zoom.addEventListener("input", () => {
    if (!state.samples) return;
    state.visibleDurSec = computeVisibleDuration(state.duration, Number(ui.zoom.value));
    // keep left edge consistent when zoom changes
    state.visibleStartSec = clamp(state.visibleStartSec, 0, Math.max(0, state.duration - state.visibleDurSec));
    syncPanSlider();
    renderAll();
  });

  ui.pan.addEventListener("input", () => {
    if (!state.samples) return;
    // pan value is normalized 0..1 across the scrollable range
    const maxStart = Math.max(0, state.duration - state.visibleDurSec);
    const norm = Number(ui.pan.value) / 1000; // 0..1
    state.visibleStartSec = norm * maxStart;
    renderAll();
  });

  // Canvas interactions (hover + click)
  canvas.addEventListener("mousemove", (e) => {
    if (!state.samples || !state.beats.length) return;
    const hit = hitTestBeat(e);
    if (hit.index >= 0) {
      const b = state.beats[hit.index];
      tooltip.show(e.clientX, e.clientY, formatTooltip(b, hit.index));
      canvas.style.cursor = "pointer";
    } else {
      tooltip.hide();
      canvas.style.cursor = "default";
    }
  });

  canvas.addEventListener("mouseleave", () => {
    tooltip.hide();
    canvas.style.cursor = "default";
  });

  canvas.addEventListener("click", (e) => {
    if (!state.samples || !state.beats.length) return;
    const hit = hitTestBeat(e);
    if (hit.index >= 0) {
      state.selectedBeatIndex = hit.index;
      renderAll();
      // also scroll table to selection
      const row = document.querySelector(`[data-beat-index="${hit.index}"]`);
      if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  window.addEventListener("resize", () => {
    if (!state.samples) return;
    resizeCanvasForHiDPI();
    renderAll();
  });

  // -----------------------------
  // Core audio helpers
  // -----------------------------
  async function decodeAudio(file) {
    const data = await file.arrayBuffer();
    return await audioCtx.decodeAudioData(data);
  }

  function toMono(buffer) {
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);

    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.getChannelData(1);
    const out = new Float32Array(ch0.length);
    for (let i = 0; i < out.length; i++) out[i] = (ch0[i] + ch1[i]) * 0.5;
    return out;
  }

  // -----------------------------
  // Click detection (no Math.max(...arr) to avoid call stack errors)
  // -----------------------------
  function detectClicks(samples, sr) {
    // Adaptive threshold from absolute max
    let maxAbs = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > maxAbs) maxAbs = v;
    }

    const threshold = maxAbs * 0.35; // tune if needed
    const minGapSec = 0.08;
    const minGapSamples = Math.floor(minGapSec * sr);

    const clicks = [];
    let lastIndex = -Infinity;

    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > threshold && i - lastIndex > minGapSamples) {
        // refine to local peak in a small window for better timing
        const refinedIndex = refineToLocalPeak(samples, i, sr);
        clicks.push(refinedIndex / sr);
        lastIndex = refinedIndex;
        i = refinedIndex; // move forward
      }
    }

    return clicks;
  }

  function refineToLocalPeak(samples, startIndex, sr) {
    const windowSec = 0.01; // 10ms
    const w = Math.floor(windowSec * sr);
    const start = Math.max(0, startIndex - Math.floor(w / 2));
    const end = Math.min(samples.length - 1, startIndex + Math.floor(w / 2));
    let bestI = startIndex;
    let bestV = 0;

    for (let i = start; i <= end; i++) {
      const v = Math.abs(samples[i]);
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }
    return bestI;
  }

  // -----------------------------
  // Spectral centroid (OfflineAudioContext analyser)
  // -----------------------------
  async function analyzeCentroidOffline(samples, sr, timeSec) {
    const fftSize = 2048;
    const start = Math.floor(timeSec * sr);

    if (start < 0 || start + fftSize >= samples.length) return 0;

    const offline = new OfflineAudioContext(1, fftSize, sr);
    const buf = offline.createBuffer(1, fftSize, sr);

    // copy segment
    const segment = samples.subarray(start, start + fftSize);
    buf.copyToChannel(segment, 0);

    const src = offline.createBufferSource();
    src.buffer = buf;

    const analyser = offline.createAnalyser();
    analyser.fftSize = fftSize;

    src.connect(analyser);
    analyser.connect(offline.destination);

    src.start(0);
    await offline.startRendering();

    const freqData = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqData);

    return spectralCentroid(freqData, sr, fftSize);
  }

  function spectralCentroid(freqDataDb, sampleRate, fftSize) {
    // Use only a reasonable band to avoid the very top bins dominating
    // (clicks have broadband energy; this stabilizes classification).
    const nyquist = sampleRate / 2;
    const minHz = 200;   // ignore DC/rumble
    const maxHz = Math.min(6000, nyquist); // cap high end for stability

    const minBin = Math.max(0, Math.floor((minHz / nyquist) * freqDataDb.length));
    const maxBin = Math.min(freqDataDb.length - 1, Math.floor((maxHz / nyquist) * freqDataDb.length));

    let weighted = 0;
    let sum = 0;

    for (let i = minBin; i <= maxBin; i++) {
      const db = freqDataDb[i];
      // convert dB to linear magnitude (amplitude-ish)
      const mag = Math.pow(10, db / 20);
      const freq = (i * sampleRate) / fftSize;
      weighted += freq * mag;
      sum += mag;
    }

    return sum ? (weighted / sum) : 0;
  }

  // -----------------------------
  // Classification (2-means on centroid; choose smaller cluster as downbeats)
  // -----------------------------
  function classifyByCentroidKMeans(events) {
    if (!events.length) return [];

    const values = events.map(e => e.centroid);
    // init with 25th/75th percentiles
    const sorted = [...values].sort((a, b) => a - b);
    const c0Init = sorted[Math.floor(sorted.length * 0.25)];
    const c1Init = sorted[Math.floor(sorted.length * 0.75)];

    let c0 = c0Init;
    let c1 = c1Init;

    // kmeans iterations
    for (let iter = 0; iter < 20; iter++) {
      let s0 = 0, n0 = 0;
      let s1 = 0, n1 = 0;

      for (const v of values) {
        if (Math.abs(v - c0) <= Math.abs(v - c1)) {
          s0 += v; n0++;
        } else {
          s1 += v; n1++;
        }
      }

      const nc0 = n0 ? (s0 / n0) : c0;
      const nc1 = n1 ? (s1 / n1) : c1;

      if (Math.abs(nc0 - c0) < 1e-6 && Math.abs(nc1 - c1) < 1e-6) break;
      c0 = nc0; c1 = nc1;
    }

    // Assign clusters
    const cluster0 = [];
    const cluster1 = [];
    for (const e of events) {
      if (Math.abs(e.centroid - c0) <= Math.abs(e.centroid - c1)) cluster0.push(e);
      else cluster1.push(e);
    }

    // Smaller cluster is likely downbeats
    const downCluster = cluster0.length <= cluster1.length ? 0 : 1;

    return events.map(e => {
      const in0 = Math.abs(e.centroid - c0) <= Math.abs(e.centroid - c1);
      const cluster = in0 ? 0 : 1;
      return {
        time: e.time,
        centroid: e.centroid,
        isDownbeat: cluster === downCluster
      };
    });
  }

  // -----------------------------
  // Tempo per beat + basic segmentation
  // -----------------------------
  function computeBpmPerBeat(classifiedEvents) {
    const events = [...classifiedEvents].sort((a, b) => a.time - b.time);
    if (events.length < 2) {
      return events.map(e => ({ ...e, bpm: 0 }));
    }

    // instantaneous bpm (between beats), then a small median smoothing
    const inst = new Array(events.length).fill(0);
    for (let i = 1; i < events.length; i++) {
      const dt = events[i].time - events[i - 1].time;
      inst[i] = dt > 0 ? (60 / dt) : 0;
    }

    const smooth = medianSmooth(inst, 5);

    return events.map((e, i) => ({
      ...e,
      bpm: smooth[i] || 0
    }));
  }

  function medianSmooth(arr, win) {
    const out = arr.slice();
    const half = Math.floor(win / 2);
    for (let i = 0; i < arr.length; i++) {
      const a = [];
      for (let j = i - half; j <= i + half; j++) {
        if (j >= 0 && j < arr.length && arr[j] > 0) a.push(arr[j]);
      }
      if (a.length) {
        a.sort((x, y) => x - y);
        out[i] = a[Math.floor(a.length / 2)];
      }
    }
    return out;
  }

  // -----------------------------
  // Rendering: waveform + beat overlay + selection
  // -----------------------------
  function resizeCanvasForHiDPI() {
    // Keep CSS size from the element, set backing store scaled for devicePixelRatio
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight || Number(canvas.getAttribute("height")) || 200;

    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));

    // Normalize drawing coordinates to CSS pixels
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function renderAll() {
    if (!state.samples) return;
    drawWaveform();
    drawBeatOverlay();
  }

  function drawWaveform() {
    const samples = state.samples;
    const sr = state.sr;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight || 200;

    ctx2d.clearRect(0, 0, w, h);

    // Visible window in samples
    const startS = Math.floor(state.visibleStartSec * sr);
    const endS = Math.min(samples.length, Math.floor((state.visibleStartSec + state.visibleDurSec) * sr));
    const len = Math.max(1, endS - startS);

    // Downsample step per pixel
    const step = Math.max(1, Math.floor(len / w));
    const mid = h / 2;

    ctx2d.beginPath();
    ctx2d.strokeStyle = "#38bdf8";
    ctx2d.lineWidth = 1;

    for (let x = 0; x < w; x++) {
      const i = startS + x * step;
      if (i >= endS) break;

      // min/max in this bucket for a nicer waveform
      let min = 1, max = -1;
      const bucketEnd = Math.min(endS, i + step);
      for (let j = i; j < bucketEnd; j++) {
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

    // baseline
    ctx2d.strokeStyle = "rgba(148,163,184,0.25)";
    ctx2d.beginPath();
    ctx2d.moveTo(0, mid);
    ctx2d.lineTo(w, mid);
    ctx2d.stroke();
  }

  function drawBeatOverlay() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight || 200;

    const start = state.visibleStartSec;
    const end = state.visibleStartSec + state.visibleDurSec;

    // Beat markers
    for (let i = 0; i < state.beats.length; i++) {
      const b = state.beats[i];
      if (b.time < start || b.time > end) continue;

      const x = ((b.time - start) / (end - start)) * w;

      // line
      ctx2d.beginPath();
      ctx2d.lineWidth = (i === state.selectedBeatIndex) ? 2 : 1;
      ctx2d.strokeStyle = b.isDownbeat ? "#f87171" : "rgba(226,232,240,0.55)";
      ctx2d.moveTo(x, 0);
      ctx2d.lineTo(x, h);
      ctx2d.stroke();

      // small top tick
      ctx2d.fillStyle = b.isDownbeat ? "#f87171" : "rgba(226,232,240,0.75)";
      ctx2d.fillRect(x - 1, 0, 2, 10);
    }
  }

  function hitTestBeat(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = canvas.clientWidth;

    const start = state.visibleStartSec;
    const end = start + state.visibleDurSec;

    let bestIndex = -1;
    let bestDist = Infinity;

    for (let i = 0; i < state.beats.length; i++) {
      const t = state.beats[i].time;
      if (t < start || t > end) continue;

      const bx = ((t - start) / (end - start)) * w;
      const d = Math.abs(bx - x);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }

    // 6px hit radius feels good
    if (bestDist <= 6) return { index: bestIndex, dist: bestDist };
    return { index: -1, dist: bestDist };
  }

  // -----------------------------
  // Beat table (chronological)
  // -----------------------------
  function renderBeatTable() {
    if (!state.beats.length) {
      output.textContent = "";
      return;
    }

    // Replace <pre> content with a table
    output.innerHTML = "";

    const table = document.createElement("table");
    table.style.width = "100%";
    table.style.marginTop = "12px";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");

    const thTime = document.createElement("th");
    thTime.textContent = "Time (s)";
    const thDown = document.createElement("th");
    thDown.textContent = "Downbeat";
    const thBpm = document.createElement("th");
    thBpm.textContent = "BPM";

    hr.appendChild(thTime);
    hr.appendChild(thDown);
    hr.appendChild(thBpm);
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    state.beats.forEach((b, i) => {
      const tr = document.createElement("tr");
      tr.dataset.beatIndex = String(i);

      if (i === state.selectedBeatIndex) {
        tr.style.outline = "2px solid rgba(56,189,248,0.6)";
        tr.style.outlineOffset = "-2px";
      }

      const tdTime = document.createElement("td");
      tdTime.textContent = fmtTime(b.time);

      const tdDown = document.createElement("td");
      tdDown.textContent = b.isDownbeat ? "Yes" : "No";

      const tdBpm = document.createElement("td");
      tdBpm.textContent = fmtBpm(b.bpm);

      tr.appendChild(tdTime);
      tr.appendChild(tdDown);
      tr.appendChild(tdBpm);

      tr.addEventListener("click", () => {
        state.selectedBeatIndex = i;
        // bring selected into view
        centerOnBeatTime(b.time);
        renderAll();
        renderBeatTable();
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    output.appendChild(table);
  }

  function centerOnBeatTime(timeSec) {
    const maxStart = Math.max(0, state.duration - state.visibleDurSec);
    const targetStart = clamp(timeSec - state.visibleDurSec * 0.5, 0, maxStart);
    state.visibleStartSec = targetStart;
    syncPanSlider();
  }

  // -----------------------------
  // UI helpers (zoom/pan labeling, pan normalization)
  // -----------------------------
  function ensureZoomPanUI() {
    // Make sure zoom has a label
    let zoomLabel = document.querySelector('label[for="zoom"]');
    if (!zoomLabel) {
      zoomLabel = document.createElement("label");
      zoomLabel.setAttribute("for", "zoom");
      zoomLabel.textContent = "Zoom";
      zoomLabel.style.display = "block";
      zoomLabel.style.marginTop = "12px";
      zoomInput.parentNode.insertBefore(zoomLabel, zoomInput);
    }
    zoomInput.style.width = "100%";
    zoomInput.style.display = "block";

    // Ensure a pan slider exists
    let pan = document.getElementById("pan");
    if (!pan) {
      pan = document.createElement("input");
      pan.type = "range";
      pan.id = "pan";
      pan.min = "0";
      pan.max = "1000";
      pan.step = "1";
      pan.value = "0";
      pan.style.width = "100%";
      pan.style.display = "block";
      pan.disabled = true;

      const panLabel = document.createElement("label");
      panLabel.setAttribute("for", "pan");
      panLabel.textContent = "Scroll";
      panLabel.style.display = "block";
      panLabel.style.marginTop = "10px";

      // Insert after zoom
      zoomInput.parentNode.insertBefore(panLabel, zoomInput.nextSibling);
      zoomInput.parentNode.insertBefore(pan, panLabel.nextSibling);
    } else {
      pan.style.width = "100%";
      pan.style.display = "block";

      let panLabel = document.querySelector('label[for="pan"]');
      if (!panLabel) {
        panLabel = document.createElement("label");
        panLabel.setAttribute("for", "pan");
        panLabel.textContent = "Scroll";
        panLabel.style.display = "block";
        panLabel.style.marginTop = "10px";
        pan.parentNode.insertBefore(panLabel, pan);
      }
    }

    return { zoom: zoomInput, pan };
  }

  function computeVisibleDuration(totalDur, zoomVal) {
    // zoom=1 shows full file; higher zoom shows a smaller window
    const z = Math.max(1, zoomVal || 1);
    const dur = totalDur / z;
    // Don’t zoom in too ridiculously far—keep at least 1 second visible
    return Math.max(1, dur);
  }

  function syncPanSlider() {
    const maxStart = Math.max(0, state.duration - state.visibleDurSec);
    const norm = maxStart > 0 ? (state.visibleStartSec / maxStart) : 0;
    ui.pan.value = String(Math.round(norm * 1000));
    ui.pan.disabled = maxStart <= 0;
  }

  // -----------------------------
  // Tooltip
  // -----------------------------
  function makeTooltip() {
    const el = document.createElement("div");
    el.style.position = "fixed";
    el.style.zIndex = "9999";
    el.style.pointerEvents = "none";
    el.style.padding = "8px 10px";
    el.style.borderRadius = "8px";
    el.style.background = "rgba(15, 23, 42, 0.95)";
    el.style.border = "1px solid rgba(148, 163, 184, 0.35)";
    el.style.color = "#e2e8f0";
    el.style.fontSize = "12px";
    el.style.whiteSpace = "nowrap";
    el.style.transform = "translate(10px, 10px)";
    el.style.display = "none";
    document.body.appendChild(el);

    return {
      show(x, y, html) {
        el.innerHTML = html;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.display = "block";
      },
      hide() {
        el.style.display = "none";
      },
    };
  }

  function formatTooltip(b, index) {
    return [
      `<div><b>Beat #${index + 1}</b></div>`,
      `<div>Time: ${fmtTime(b.time)} s</div>`,
      `<div>Downbeat: ${b.isDownbeat ? "Yes" : "No"}</div>`,
      `<div>BPM: ${fmtBpm(b.bpm)}</div>`,
      `<div>Centroid: ${b.centroid.toFixed(2)}</div>`,
    ].join("");
  }

  // -----------------------------
  // Formatting helpers (per your rules)
  // -----------------------------
  function fmtTime(t) {
    // <= 3 decimals
    return (Math.round(t * 1000) / 1000).toFixed(3);
  }

  function fmtBpm(bpm) {
    // <= 1 decimal
    return (Math.round(bpm * 10) / 10).toFixed(1);
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

})();
