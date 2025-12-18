/*  Click Track Analyzer (drop-in script.js)
    - Loads WAV/MP3 via WebAudio
    - Detects click times (transients)
    - Computes band-limited spectral centroid per click
    - Segments tempo changes
    - Auto-detects beats-per-bar
    - Classifies downbeats vs other beats using clustering + bar-regularity scoring
    - Draws zoomable + scrollable waveform with bottom scrollbar + beat overlay
*/

(() => {
  // ---------- DOM (with fallbacks) ----------
  const $ = (sel) => document.querySelector(sel);

  // preferred IDs
  const fileInput =
    $("#fileInput") ||
    $("#file") ||
    $('input[type="file"]');

  const analyzeBtn =
    $("#processBtn") ||
    $("#analyzeBtn") ||
    $("#analyze") ||
    $('button[data-action="analyze"]');

  const canvas =
    $("#waveform") ||
    $("#wave") ||
    $("canvas");

  const output =
    $("#output") ||
    $("#result") ||
    $("pre");

  if (!fileInput || !analyzeBtn || !canvas || !output) {
    const missing = [
      !fileInput && "fileInput",
      !analyzeBtn && "processBtn",
      !canvas && "waveform",
      !output && "output",
    ].filter(Boolean);
    console.error("Missing required DOM elements:", missing.join(", "));
    if (output) output.textContent = `Missing required DOM elements: ${missing.join(", ")}`;
    return;
  }

  // ---------- Audio ----------
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  async function decodeAudioFile(file) {
    const data = await file.arrayBuffer();
    return await audioCtx.decodeAudioData(data);
  }

  function toMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);

    // average channels (avoid huge allocations: do it once)
    const len = audioBuffer.length;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.getChannelData(1);
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    return mono;
  }

  // ---------- UI controls (created dynamically) ----------
  const controls = ensureControls();
  function ensureControls() {
    const host = canvas.parentElement || document.body;

    const wrap = document.createElement("div");
    wrap.style.display = "grid";
    wrap.style.gap = "10px";
    wrap.style.margin = "12px 0";

    // Zoom
    const zoomRow = makeSliderRow("Zoom (px/sec)", 50, 2000, 400, 10);
    // Threshold (as fraction of max envelope)
    const thrRow = makeSliderRow("Click threshold (%)", 5, 90, 35, 1);
    // Min gap
    const gapRow = makeSliderRow("Min gap (ms)", 30, 250, 80, 1);

    // First click is downbeat toggle
    const toggleRow = document.createElement("label");
    toggleRow.style.display = "flex";
    toggleRow.style.alignItems = "center";
    toggleRow.style.gap = "8px";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = false;
    const span = document.createElement("span");
    span.textContent = "Force: first click is downbeat";
    toggleRow.appendChild(chk);
    toggleRow.appendChild(span);

    // Bottom scrollbar (range)
    const scrollRow = document.createElement("div");
    scrollRow.style.display = "grid";
    scrollRow.style.gap = "6px";
    const scrollLabel = document.createElement("div");
    scrollLabel.style.fontSize = "12px";
    scrollLabel.style.opacity = "0.85";
    scrollLabel.textContent = "Waveform scroll";
    const scroll = document.createElement("input");
    scroll.type = "range";
    scroll.min = "0";
    scroll.max = "0";
    scroll.value = "0";
    scroll.step = "1";
    scroll.style.width = "100%";
    scrollRow.appendChild(scrollLabel);
    scrollRow.appendChild(scroll);

    wrap.appendChild(zoomRow.el);
    wrap.appendChild(thrRow.el);
    wrap.appendChild(gapRow.el);
    wrap.appendChild(toggleRow);
    wrap.appendChild(scrollRow);

    host.insertBefore(wrap, canvas.nextSibling);

    return {
      zoom: zoomRow.input,
      thresholdPct: thrRow.input,
      minGapMs: gapRow.input,
      forceFirstDownbeat: chk,
      scroll,
      scrollLabel,
    };
  }

  function makeSliderRow(label, min, max, value, step) {
    const el = document.createElement("div");
    el.style.display = "grid";
    el.style.gridTemplateColumns = "220px 1fr 70px";
    el.style.gap = "10px";
    el.style.alignItems = "center";

    const lab = document.createElement("div");
    lab.textContent = label;
    lab.style.fontSize = "12px";
    lab.style.opacity = "0.9";

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.step = String(step);

    const val = document.createElement("div");
    val.textContent = String(value);
    val.style.fontVariantNumeric = "tabular-nums";
    val.style.fontSize = "12px";
    val.style.textAlign = "right";
    val.style.opacity = "0.9";

    input.addEventListener("input", () => {
      val.textContent = input.value;
    });

    el.appendChild(lab);
    el.appendChild(input);
    el.appendChild(val);

    return { el, input };
  }

  // ---------- State ----------
  const state = {
    buffer: null,
    samples: null,
    sr: 44100,
    duration: 0,
    clicks: [],
    events: [],           // {time, centroid}
    segments: [],         // tempo segments
    beatsPerBar: 4,
    downbeatMask: [],     // boolean per click index
    viewStartSec: 0,
    viewWidthSec: 5,
    pxPerSec: 400,
  };

  // ---------- Helpers ----------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function median(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const mid = (a.length / 2) | 0;
    return a.length % 2 ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
  }

  function modeInt(arr, minVal, maxVal) {
    const counts = new Map();
    for (const v of arr) {
      const iv = Math.round(v);
      if (iv < minVal || iv > maxVal) continue;
      counts.set(iv, (counts.get(iv) || 0) + 1);
    }
    let best = minVal, bestC = -1;
    for (const [k, c] of counts.entries()) {
      if (c > bestC) { bestC = c; best = k; }
    }
    return best;
  }

  // ---------- Click detection (no spread / no huge map) ----------
  function detectClicks(samples, sr, thresholdPct, minGapMs) {
    // compute max abs without allocating huge arrays
    let maxAbs = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > maxAbs) maxAbs = a;
    }

    const threshold = maxAbs * (thresholdPct / 100);
    const minGap = minGapMs / 1000;

    const clicks = [];
    let last = -Infinity;

    // slight smoothing: require local peak
    for (let i = 1; i < samples.length - 1; i++) {
      const v = Math.abs(samples[i]);
      if (v < threshold) continue;
      if (v < Math.abs(samples[i - 1]) || v < Math.abs(samples[i + 1])) continue;

      const t = i / sr;
      if (t - last > minGap) {
        clicks.push(t);
        last = t;
      }
    }
    return clicks;
  }

  // ---------- FFT centroid (band-limited + noise floor) ----------
  async function centroidForClick(samples, sr, timeSec) {
    const fftSize = 2048;
    const start = Math.floor(timeSec * sr);
    if (start < 0 || start + fftSize >= samples.length) return 0;

    // Copy a short window
    const window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) window[i] = samples[start + i];

    // Offline context render (fast enough for click tracks)
    const offline = new OfflineAudioContext(1, fftSize, sr);
    const buf = offline.createBuffer(1, fftSize, sr);
    buf.copyToChannel(window, 0);

    const src = offline.createBufferSource();
    src.buffer = buf;

    const analyser = offline.createAnalyser();
    analyser.fftSize = fftSize;

    src.connect(analyser);
    analyser.connect(offline.destination);
    src.start(0);

    await offline.startRendering();

    const freqDataDb = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqDataDb);

    // centroid over band where click tones live
    // (keeps results from collapsing to ~7400 due to wideband noise)
    const minHz = 300;
    const maxHz = 6000;
    const binHz = sr / fftSize;
    const i0 = Math.max(1, Math.floor(minHz / binHz));
    const i1 = Math.min(freqDataDb.length - 1, Math.ceil(maxHz / binHz));

    // estimate noise floor: median dB in band
    const bandDb = [];
    for (let i = i0; i <= i1; i++) bandDb.push(freqDataDb[i]);
    const noiseDb = median(bandDb);

    let weighted = 0;
    let sum = 0;

    for (let i = i0; i <= i1; i++) {
      // suppress bins near noise floor
      const db = freqDataDb[i];
      const dbAbove = db - noiseDb;
      if (dbAbove < 6) continue; // ignore near-floor

      // convert dB to linear magnitude
      const mag = Math.pow(10, db / 20);
      const f = i * binHz;

      weighted += f * mag;
      sum += mag;
    }

    return sum ? (weighted / sum) : 0;
  }

  // ---------- Tempo segmentation ----------
  function segmentTempo(clicks, toleranceBpm = 1.0, smoothWindow = 5) {
    if (clicks.length < 2) return [];

    // instantaneous bpm series
    const bpms = [];
    for (let i = 1; i < clicks.length; i++) {
      const dt = clicks[i] - clicks[i - 1];
      bpms.push(dt > 0 ? (60 / dt) : 0);
    }

    // smooth by median filter
    const sm = bpms.map((_, i) => {
      const a = [];
      for (let k = -Math.floor(smoothWindow / 2); k <= Math.floor(smoothWindow / 2); k++) {
        const j = i + k;
        if (j >= 0 && j < bpms.length) a.push(bpms[j]);
      }
      return median(a);
    });

    // build segments
    const segments = [];
    let segStartIdx = 0;
    let current = sm[0];

    for (let i = 1; i < sm.length; i++) {
      const bpm = sm[i];
      if (Math.abs(bpm - current) > toleranceBpm) {
        segments.push({
          startTime: clicks[segStartIdx],
          endTime: clicks[i],
          bpm: current,
          startClickIndex: segStartIdx,
          endClickIndex: i,
        });
        segStartIdx = i;
        current = bpm;
      }
    }

    segments.push({
      startTime: clicks[segStartIdx],
      endTime: clicks[clicks.length - 1],
      bpm: current,
      startClickIndex: segStartIdx,
      endClickIndex: clicks.length - 1,
    });

    return segments;
  }

  // ---------- Beats-per-bar auto detection ----------
  function autoBeatsPerBar(clicks, downbeatIdxs, segments) {
    // estimate beat period from first tempo segment (or overall median)
    let beatSec;
    if (segments && segments.length) {
      beatSec = 60 / segments[0].bpm;
    } else {
      const dts = [];
      for (let i = 1; i < clicks.length; i++) dts.push(clicks[i] - clicks[i - 1]);
      beatSec = median(dts);
    }
    if (!beatSec || !isFinite(beatSec)) return 4;

    // intervals between downbeats -> candidate beats-per-bar
    const candidates = [];
    for (let i = 1; i < downbeatIdxs.length; i++) {
      const a = downbeatIdxs[i - 1];
      const b = downbeatIdxs[i];
      const sec = clicks[b] - clicks[a];
      const est = sec / beatSec;
      candidates.push(est);
    }

    // common meters 2..12; pick mode
    const bpb = modeInt(candidates, 2, 12);
    return bpb || 4;
  }

  // ---------- Clustering + label selection ----------
  function kmeans2(values, iters = 20) {
    if (!values.length) return { c1: 0, c2: 0, labels: [] };

    // init centers: 25th and 75th percentile
    const s = values.slice().sort((a, b) => a - b);
    let c1 = s[Math.floor(s.length * 0.25)];
    let c2 = s[Math.floor(s.length * 0.75)];

    let labels = new Array(values.length).fill(0);

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
      const nc1 = n1 ? s1 / n1 : c1;
      const nc2 = n2 ? s2 / n2 : c2;

      if (Math.abs(nc1 - c1) < 1e-6 && Math.abs(nc2 - c2) < 1e-6) break;
      c1 = nc1; c2 = nc2;
    }

    return { c1, c2, labels };
  }

  function scoreDownbeatMask(clickCount, bpb, mask) {
    // Score how regularly downbeats land every bpb clicks.
    // Penalize too-frequent downbeats.
    if (!clickCount || !mask.length) return -Infinity;

    let expected = 0;
    let correct = 0;
    let downCount = 0;

    for (let i = 0; i < clickCount; i++) {
      const isExpected = (i % bpb) === 0;
      if (isExpected) expected++;
      if (mask[i]) downCount++;
      if (mask[i] === isExpected) correct++;
    }

    // prefer masks that match regular bar starts and have ~N/bpb downbeats
    const targetDown = clickCount / bpb;
    const downPenalty = Math.abs(downCount - targetDown) / Math.max(1, targetDown);

    return correct - downPenalty * clickCount * 0.5;
  }

  function classifyDownbeats(events, segments, forceFirstDownbeat) {
    const centroids = events.map(e => e.centroid);

    // cluster into two groups
    const km = kmeans2(centroids);
    const labels = km.labels; // 0/1

    // two possible masks: label0=downbeat OR label1=downbeat
    const maskA = labels.map(l => l === 0);
    const maskB = labels.map(l => l === 1);

    // initial downbeat indices from smaller group (heuristic)
    const idxA = maskA.map((v, i) => v ? i : -1).filter(i => i >= 0);
    const idxB = maskB.map((v, i) => v ? i : -1).filter(i => i >= 0);
    const initDownIdxs = (idxA.length <= idxB.length) ? idxA : idxB;

    // estimate beats-per-bar from initial guess
    let bpb = autoBeatsPerBar(state.clicks, initDownIdxs, segments);

    // score both masks against periodicity
    const sA = scoreDownbeatMask(events.length, bpb, maskA);
    const sB = scoreDownbeatMask(events.length, bpb, maskB);

    let downMask = (sA >= sB) ? maskA : maskB;

    // optional: force first click downbeat (helps for some click tracks)
    if (forceFirstDownbeat && downMask.length) {
      // rotate mask to make click0 downbeat while preserving pattern as much as possible
      downMask[0] = true;
    }

    // refine beats-per-bar once we pick a mask
    const downIdxs = downMask.map((v, i) => v ? i : -1).filter(i => i >= 0);
    bpb = autoBeatsPerBar(state.clicks, downIdxs, segments);

    return { downMask, beatsPerBar: bpb, kmeans: km };
  }

  // ---------- Waveform drawing (zoom + scroll + overlays) ----------
  function setupCanvasSizing() {
    // Use devicePixelRatio for sharpness
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 800;
    const cssH = canvas.clientHeight || 200;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    if (!state.samples || !state.samples.length) return;

    setupCanvasSizing();

    // view parameters
    const pxPerSec = Number(controls.zoom.value);
    state.pxPerSec = pxPerSec;

    const cssW = canvas.clientWidth || 800;
    const cssH = canvas.clientHeight || 200;

    state.viewWidthSec = cssW / pxPerSec;

    // clamp start
    state.viewStartSec = clamp(state.viewStartSec, 0, Math.max(0, state.duration - state.viewWidthSec));

    // update scrollbar
    const maxStart = Math.max(0, state.duration - state.viewWidthSec);
    controls.scroll.max = String(Math.floor(maxStart * 1000));
    controls.scroll.value = String(Math.floor(state.viewStartSec * 1000));
    controls.scroll.step = "10"; // 10ms steps
    controls.scrollLabel.textContent =
      `Waveform scroll (start: ${state.viewStartSec.toFixed(3)}s / ${state.duration.toFixed(2)}s)`;

    // background
    ctx.clearRect(0, 0, cssW, cssH);

    // draw waveform in view
    drawWaveformWindow(state.samples, state.sr, state.viewStartSec, state.viewWidthSec, cssW, cssH);

    // overlays: tempo segments (subtle)
    drawTempoSegmentsOverlay(state.segments, cssW, cssH);

    // overlays: clicks (beats / downbeats)
    drawClickMarkers(state.clicks, state.downbeatMask, cssW, cssH);
  }

  function drawWaveformWindow(samples, sr, startSec, widthSec, w, h) {
    const startIdx = Math.floor(startSec * sr);
    const endIdx = Math.min(samples.length, Math.floor((startSec + widthSec) * sr));
    const len = Math.max(1, endIdx - startIdx);

    const mid = h / 2;

    ctx.lineWidth = 1;
    ctx.strokeStyle = "#38bdf8";
    ctx.beginPath();

    // Downsample to pixel columns; use min/max per column
    const samplesPerPx = len / w;

    for (let x = 0; x < w; x++) {
      const a0 = Math.floor(startIdx + x * samplesPerPx);
      const a1 = Math.min(endIdx, Math.floor(startIdx + (x + 1) * samplesPerPx));

      let mn = 1, mx = -1;
      for (let i = a0; i < a1; i++) {
        const v = samples[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }

      // vertical line from mn..mx
      const y1 = mid + mn * mid;
      const y2 = mid + mx * mid;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }

    ctx.stroke();
  }

  function xFromTime(tSec, w) {
    const rel = (tSec - state.viewStartSec) / state.viewWidthSec;
    return rel * w;
  }

  function drawClickMarkers(clicks, downMask, w, h) {
    if (!clicks || !clicks.length) return;

    for (let i = 0; i < clicks.length; i++) {
      const t = clicks[i];
      if (t < state.viewStartSec || t > state.viewStartSec + state.viewWidthSec) continue;

      const x = xFromTime(t, w);

      const isDown = !!downMask[i];

      ctx.beginPath();
      ctx.lineWidth = isDown ? 2 : 1;
      ctx.strokeStyle = isDown ? "#f87171" : "#e2e8f0";
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      // small label at top for downbeats
      if (isDown) {
        ctx.fillStyle = "#f87171";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText("D", x + 2, 12);
      }
    }
  }

  function drawTempoSegmentsOverlay(segments, w, h) {
    if (!segments || !segments.length) return;

    for (const seg of segments) {
      const x0 = xFromTime(seg.startTime, w);
      const x1 = xFromTime(seg.endTime, w);
      // only draw visible span
      const vx0 = clamp(x0, 0, w);
      const vx1 = clamp(x1, 0, w);
      if (vx1 <= 0 || vx0 >= w || vx1 <= vx0) continue;

      // subtle overlay block
      ctx.fillStyle = "rgba(148, 163, 184, 0.08)";
      ctx.fillRect(vx0, 0, vx1 - vx0, h);

      // bpm label near top
      ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(`${seg.bpm.toFixed(2)} bpm`, vx0 + 4, h - 8);
    }
  }

  // interactions: scrollbar + wheel zoom
  controls.scroll.addEventListener("input", () => {
    state.viewStartSec = Number(controls.scroll.value) / 1000;
    draw();
  });

  controls.zoom.addEventListener("input", () => draw());

  // Optional: horizontal scroll with trackpad/shift-wheel
  canvas.addEventListener("wheel", (e) => {
    if (!state.samples) return;
    // shift-scroll = move timeline
    if (e.shiftKey) {
      e.preventDefault();
      const deltaSec = (e.deltaY / 1000) * (state.viewWidthSec); // scale
      state.viewStartSec = clamp(state.viewStartSec + deltaSec, 0, Math.max(0, state.duration - state.viewWidthSec));
      draw();
    }
  }, { passive: false });

  // ---------- Main analyze ----------
  analyzeBtn.addEventListener("click", async () => {
    try {
      if (!fileInput.files || !fileInput.files.length) {
        output.textContent = "Choose a WAV or MP3 file first.";
        return;
      }

      // required for Chrome/Safari autoplay policy
      await audioCtx.resume();

      const file = fileInput.files[0];
      output.textContent = "Decoding audio…";

      const buffer = await decodeAudioFile(file);
      const sr = buffer.sampleRate;
      const samples = toMono(buffer);

      state.buffer = buffer;
      state.samples = samples;
      state.sr = sr;
      state.duration = buffer.duration;

      // detect clicks
      output.textContent = "Detecting clicks…";
      const thresholdPct = Number(controls.thresholdPct.value);
      const minGapMs = Number(controls.minGapMs.value);
      const clicks = detectClicks(samples, sr, thresholdPct, minGapMs);
      state.clicks = clicks;

      if (clicks.length < 2) {
        output.textContent = `Detected ${clicks.length} click(s). Try lowering threshold or min-gap.`;
        state.events = [];
        state.segments = [];
        state.downbeatMask = [];
        draw();
        return;
      }

      // analyze centroids
      output.textContent = `Analyzing ${clicks.length} clicks (centroid)…`;
      const events = [];
      // limit to a sane maximum if you load extremely long files
      const maxAnalyze = Math.min(clicks.length, 20000);

      for (let i = 0; i < maxAnalyze; i++) {
        const t = clicks[i];
        const centroid = await centroidForClick(samples, sr, t);
        events.push({ time: t, centroid });
      }
      state.events = events;

      // tempo segmentation
      const segments = segmentTempo(clicks, 1.0, 5);
      state.segments = segments;

      // classify downbeats
      const { downMask, beatsPerBar, kmeans } = classifyDownbeats(
        events,
        segments,
        controls.forceFirstDownbeat.checked
      );

      state.downbeatMask = downMask;
      state.beatsPerBar = beatsPerBar;

      // initial view: start at 0
      state.viewStartSec = 0;

      // render waveform + overlay
      draw();

      // output JSON summary
      const downbeats = [];
      const beats = [];
      for (let i = 0; i < events.length; i++) {
        const obj = { time: events[i].time, centroid: events[i].centroid };
        (downMask[i] ? downbeats : beats).push(obj);
      }

      output.textContent = JSON.stringify({
        meta: {
          fileName: file.name,
          sampleRate: sr,
          durationSec: Number(state.duration.toFixed(3)),
          detectedClicks: clicks.length,
          analyzedClicks: events.length,
          beatsPerBar,
          centroidClusters: { c1: kmeans.c1, c2: kmeans.c2 }
        },
        tempoSegments: segments,
        downbeats,
        beats
      }, null, 2);

    } catch (err) {
      console.error(err);
      output.textContent = `Error: ${err?.message || String(err)}`;
    }
  });

})();
