// Click Track → grandMA3 Beat Grid (MA3 plugin XML generator)
// Drop-in script.js
(() => {
  "use strict";

  // ---------- DOM ----------
  const fileInput = document.getElementById("fileInput");
  const processBtn = document.getElementById("processBtn");
  const canvas = document.getElementById("waveform");
  const output = document.getElementById("output");
  const zoomEl = document.getElementById("zoom");
  const zoomValEl = document.getElementById("zoomVal");

  if (!fileInput || !processBtn || !canvas || !output) {
    console.error("Missing required DOM elements: fileInput, processBtn, waveform, output");
    return;
  }

  // Create download button if not present
  let downloadBtn = document.getElementById("downloadBtn");
  if (!downloadBtn) {
    downloadBtn = document.createElement("button");
    downloadBtn.id = "downloadBtn";
    downloadBtn.textContent = "Download MA3 Plugin";
    downloadBtn.style.marginLeft = "8px";
    processBtn.insertAdjacentElement("afterend", downloadBtn);
  }
  downloadBtn.disabled = true;

  // Create scroll slider if not present (bottom navigation)
  let scrollEl = document.getElementById("scroll");
  const scrollValEl = document.getElementById("scrollVal");
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

  // Initialize slider value labels (if present)
  if (zoomValEl && zoomEl) zoomValEl.textContent = `${Number(zoomEl.value) || 1}×`;
  if (scrollValEl && scrollEl) scrollValEl.textContent = `${Math.round((Number(scrollEl.value) || 0) / 10)}%`;

  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) {
    console.error("Could not get 2D context from waveform canvas");
    return;
  }

  // Tooltip (hover beat info)
  let tooltip = document.getElementById("beatTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "beatTooltip";
    tooltip.style.position = "fixed";
    tooltip.style.pointerEvents = "none";
    tooltip.style.background = "rgba(15,23,42,0.95)";
    tooltip.style.border = "1px solid rgba(148,163,184,0.35)";
    tooltip.style.padding = "8px 10px";
    tooltip.style.borderRadius = "8px";
    tooltip.style.color = "#e2e8f0";
    tooltip.style.fontSize = "12px";
    tooltip.style.display = "none";
    tooltip.style.zIndex = "9999";
    document.body.appendChild(tooltip);
  }

  // ---------- AUDIO ----------
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // ---------- STATE ----------
  let state = {
    audioBuffer: null,
    samples: null,
    sampleRate: 44100,
    fileBaseName: "click-track",
    beats: [], // chronological list: {time, centroid, downbeat, bpm, tempoOut}
    // waveform view:
    zoom: zoomEl ? Number(zoomEl.value) : 1, // 1..20
    scroll: 0, // 0..1
    // overlay hit-testing:
    markerXs: [], // [{x, beatIndex}]
    selectedBeatIndex: -1
  };

  // Initialize slider readouts (if present)
  if (zoomValEl && zoomEl) zoomValEl.textContent = `${Number(zoomEl.value) || 1}×`;
  if (scrollValEl && scrollEl) scrollValEl.textContent = `${Math.round((Number(scrollEl.value) || 0) / 10)}%`;

  // ---------- HELPERS ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt3 = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
  const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);

  function baseFileName(name) {
    return (name || "click-track").replace(/\.(wav|mp3)$/i, "");
  }

  async function decode(file) {
    const data = await file.arrayBuffer();
    // decodeAudioData returns a Promise in modern browsers, callback in older; handle both.
    const maybePromise = audioCtx.decodeAudioData(data);
    if (maybePromise && typeof maybePromise.then === "function") return await maybePromise;
    return await new Promise((resolve, reject) => {
      audioCtx.decodeAudioData(data, resolve, reject);
    });
  }

  // Avoid "Maximum call stack size exceeded" by NOT using Math.max(...bigArray)
  function maxAbs(samples) {
    let m = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > m) m = v;
    }
    return m;
  }

  function detectClicks(samples, sr) {
    // Adaptive threshold (safe for large files)
    const m = maxAbs(samples);
    const threshold = m * 0.35; // tweakable
    const minGap = 0.08;        // 80ms (tweakable)

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

  function spectralCentroid(freqDataDb, sampleRate, fftSize) {
    // Compute centroid in a useful band to avoid “everything ~7400Hz”:
    // ignore bins < ~150Hz and > ~8000Hz and ignore ultra-low magnitudes.
    const nyquist = sampleRate / 2;
    const binHz = sampleRate / fftSize;

    const lowHz = 150;
    const highHz = Math.min(8000, nyquist);

    const startBin = Math.floor(lowHz / binHz);
    const endBin = Math.min(freqDataDb.length - 1, Math.floor(highHz / binHz));

    let weightedSum = 0;
    let magSum = 0;

    for (let i = startBin; i <= endBin; i++) {
      const db = freqDataDb[i];
      // Ignore extremely quiet bins
      if (db < -80) continue;

      const mag = Math.pow(10, db / 20); // dB → linear
      const freq = i * binHz;

      weightedSum += freq * mag;
      magSum += mag;
    }

    return magSum ? (weightedSum / magSum) : 0;
  }

  async function analyzeCentroid(samples, sr, time) {
    const size = 2048;
    const start = Math.floor(time * sr);
    if (start + size >= samples.length) return 0;

    const offline = new OfflineAudioContext(1, size, sr);
    const buf = offline.createBuffer(1, size, sr);

    // Copy window
    const windowed = samples.slice(start, start + size);
    buf.copyToChannel(windowed, 0);

    const src = offline.createBufferSource();
    const analyser = offline.createAnalyser();
    analyser.fftSize = size;

    src.buffer = buf;
    src.connect(analyser);
    analyser.connect(offline.destination);
    src.start(0);

    await offline.startRendering();

    const freqData = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqData);

    return spectralCentroid(freqData, sr, size);
  }

  // Simple 2-means clustering on centroid (more stable than median split)
  function kmeans2(values) {
    if (values.length < 2) return { c1: values[0] || 0, c2: values[0] || 0 };

    let min = Infinity, max = -Infinity;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
    let c1 = min, c2 = max;

    for (let iter = 0; iter < 20; iter++) {
      let s1 = 0, n1 = 0, s2 = 0, n2 = 0;

      for (const v of values) {
        if (Math.abs(v - c1) <= Math.abs(v - c2)) { s1 += v; n1++; }
        else { s2 += v; n2++; }
      }

      const nc1 = n1 ? (s1 / n1) : c1;
      const nc2 = n2 ? (s2 / n2) : c2;

      if (Math.abs(nc1 - c1) < 1e-6 && Math.abs(nc2 - c2) < 1e-6) break;
      c1 = nc1; c2 = nc2;
    }

    return { c1, c2 };
  }

  // Beats-per-bar autodetect + refine downbeats to an isochronous bar grid
  function refineDownbeatsByBarGrid(beats) {
    // beats are chronological, each has centroid and preliminary downbeat
    const n = beats.length;
    if (n < 8) return { beatsPerBar: 4, beats };

    // Candidate beatsPerBar between 2 and 12
    const candidates = [];
    for (let bpb = 2; bpb <= 12; bpb++) candidates.push(bpb);

    // Score each bpb by best phase alignment with preliminary downbeats
    const prelim = beats.map(b => b.downbeat ? 1 : 0);

    let best = { bpb: 4, phase: 0, score: -Infinity };
    for (const bpb of candidates) {
      for (let phase = 0; phase < bpb; phase++) {
        let score = 0;
        for (let i = 0; i < n; i++) {
          const gridDown = ((i - phase) % bpb === 0) ? 1 : 0;
          // Reward agreement, mildly penalize disagreement
          if (gridDown === prelim[i]) score += 2;
          else score -= 1;
        }
        if (score > best.score) best = { bpb, phase, score };
      }
    }

    // Apply best grid
    const out = beats.map((b, i) => ({
      ...b,
      downbeat: ((i - best.phase) % best.bpb === 0) ? 1 : 0
    }));

    return { beatsPerBar: best.bpb, beats: out };
  }

  // Compute BPM per beat
  function computeTempoOutputs(beats) {
    // bpm at beat i = 60 / (t[i] - t[i-1]) for i>=1
    const out = beats.map((b, i) => {
      let bpm = 0;
      if (i > 0) {
        const dt = b.time - beats[i - 1].time;
        bpm = dt > 0 ? (60 / dt) : 0;
      } else {
        bpm = 0;
      }

      // tempoOut rule:
      // - must be 1 decimal place if we output it (e.g., 120.0)
      // - but output 0 if within 1 BPM of the last OUTPUT tempo
      let tempoOut = 0;
      const rounded = bpm ? Number(fmt1(bpm)) : 0;
      
      // compute next beat tempo
      let nextBpm = 0;
      if (i + 1 < beats.length) {
        const dtNext = beats[i + 1].time - b.time;
        nextBpm = dtNext > 0 ? Number(fmt1(60 / dtNext)) : 0;
      }
      
      // emit only if next beat differs by more than 1 BPM
      if (i === 0 || (rounded && Math.abs(nextBpm - rounded) > 1)) {
        tempoOut = rounded;
      }

      return {
        ...b,
        bpm,
        tempoOut
      };
    });

    return out;
  }

  // ---------- WAVEFORM VIEW (zoom + scroll) ----------
function resizeCanvas() {
  // Use actual pixel size for crisp drawing (CSS pixels * devicePixelRatio)
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));

  // Draw using CSS pixel coordinates
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}


  function getViewRange() {
    const samples = state.samples;
    if (!samples) return { start: 0, end: 0 };

    const total = samples.length;
    const zoom = clamp(state.zoom || 1, 1, 50);
    const viewLen = Math.max(1, Math.floor(total / zoom));

    const scroll = clamp(state.scroll || 0, 0, 1);
    const maxStart = Math.max(0, total - viewLen);
    const start = Math.floor(scroll * maxStart);
    const end = Math.min(total, start + viewLen);

    return { start, end };
  }

  function drawWaveformAndOverlay() {
    const samples = state.samples;
    if (!samples) return;

    resizeCanvas();

    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const mid = h / 2;

    const { start, end } = getViewRange();
    const viewLen = Math.max(1, end - start);

    // background clear
    ctx2d.clearRect(0, 0, w, h);

// waveform (min/max envelope per pixel, stable across zoom/scroll)
// Map each pixel column to an exact sample range using proportional mapping.
// This avoids "apparent vertical scaling" caused by missed peaks or bucket drift.
ctx2d.beginPath();
ctx2d.lineWidth = 1;
ctx2d.strokeStyle = "#38bdf8";

const wInt = Math.max(1, Math.floor(w));
for (let x = 0; x < wInt; x++) {
  const a = x / wInt;
  const b = (x + 1) / wInt;

  const i0 = start + Math.floor(a * viewLen);
  const i1 = Math.min(end, start + Math.floor(b * viewLen));

  let min = 1;
  let max = -1;
  for (let i = i0; i < i1; i++) {
    const v = samples[i] || 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const yMin = mid + min * mid;
  const yMax = mid + max * mid;
  ctx2d.moveTo(x + 0.5, yMin);
  ctx2d.lineTo(x + 0.5, yMax);
}
ctx2d.stroke();


    // markers
    state.markerXs = [];
    const beats = state.beats;
    if (!beats || beats.length === 0) return;

    const sr = state.sampleRate;
    const viewStartSec = start / sr;
    const viewEndSec = end / sr;

    for (let bi = 0; bi < beats.length; bi++) {
      const bt = beats[bi].time;
      if (bt < viewStartSec || bt > viewEndSec) continue;

      const x = ((bt - viewStartSec) / (viewEndSec - viewStartSec)) * w;

      ctx2d.beginPath();
      ctx2d.lineWidth = (bi === state.selectedBeatIndex) ? 2 : 1;
      ctx2d.strokeStyle = beats[bi].downbeat ? "#f59e0b" : "#a78bfa"; // downbeat=amber, upbeat=purple
      ctx2d.moveTo(x, 0);
      ctx2d.lineTo(x, h);
      ctx2d.stroke();

      state.markerXs.push({ x, beatIndex: bi });
    }
  }

  function hitTestMarker(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (y < 0 || y > rect.height) return null;

    let best = null;
    let bestDx = 9999;
    for (const m of state.markerXs) {
      const dx = Math.abs(m.x - x);
      if (dx < bestDx) {
        bestDx = dx;
        best = m;
      }
    }
    // tolerance ~6px
    return (best && bestDx <= 6) ? best : null;
  }

  function showTooltip(e, beat) {
    tooltip.style.display = "block";
    tooltip.style.left = `${e.clientX + 12}px`;
    tooltip.style.top = `${e.clientY + 12}px`;

    const t = fmt3(beat.time);
    const c = beat.centroid ? beat.centroid.toFixed(2) : "0.00";
    const d = beat.downbeat ? "Downbeat" : "Upbeat";
    const bpm = beat.bpm ? fmt1(beat.bpm) : "0.0";

    tooltip.innerHTML =
      `<div><b>${d}</b></div>` +
      `<div>t: ${t}s</div>` +
      `<div>centroid: ${c}Hz</div>` +
      `<div>BPM: ${bpm}</div>` +
      (beat.tempoOut ? `<div>tempo out: ${fmt1(beat.tempoOut)}</div>` : `<div>tempo out: 0</div>`);
  }

  function hideTooltip() {
    tooltip.style.display = "none";
  }

  // ---------- OUTPUT LIST ----------
  function renderBeatList() {
    const beats = state.beats || [];
    if (beats.length === 0) {
      output.textContent = "";
      return;
    }

    const lines = [];
    lines.push("beatTable preview:");
    lines.push("{seconds, downbeat, tempo change}");
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      const sec = fmt3(b.time);
      const down = b.downbeat ? 1 : 0;
      const tempoOut = b.tempoOut ? fmt1(b.tempoOut) : "0";
      lines.push(`{${sec},${down},${tempoOut}}`);
    }
    output.textContent = lines.join("\n");
  }

  // ---------- MA3 LUA/XML  ----------
  function formatSecondsFromSeconds(sec) {

    const s = Number(sec).toFixed(3);
    const trimmed = s.replace(/\.?0+$/, "");
    if (trimmed === "") return "0";
    return trimmed.startsWith("0.") ? trimmed.slice(1) : trimmed;
  }

  function buildLuaFromClickBeats(beats, baseFilename) {
    const safeName = (baseFilename || "click-track").replace(/"/g, '\\"');

    // Use \r\n for all line endings in the Lua script
    const firstLine = `local filename = "${safeName}"\r\n\r\n`;
    const comment = `--beatTable is beat in seconds, 1 or 0 if the beat is a down beat or not, and the tempo if the tempo has changed on that beat, otherwise zero\r\n`;
    const start = `local beatTable = {\r\n`;

    const entries = [];
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      const secStr = formatSecondsFromSeconds(b.time);

      // tempoOut: either 0 OR 1-decimal number
      const tempoVal = b.tempoOut ? Number(fmt1(b.tempoOut)) : 0;

      entries.push(`    {${secStr},${b.downbeat ? 1 : 0},${tempoVal}}${i < beats.length - 1 ? "," : ""}`);
    }

    const endTable = `\r\n}\r\n\r\n`;

    // Lua tail: keep identical structure/content to the MIDI app
    const luaTail =
`local firstBeatSeconds = beatTable[1][1]\r\nlocal lastBeatSeconds = beatTable[#beatTable][1]\r\n\r\nlocal function CreateBeatAppearances()\r\n    local beatOneAppNum, beatOtherAppNum\r\n    for i = 1, 9999 do\r\n        if not IsObjectValid(GetObject('Appearance '..i)) then\r\n            if not beatOneAppNum then\r\n                Cmd('Store Appearance '..i..' "BeatGridOnes"')\r\n                Cmd('Set Appearance '..i..' "Color" "0.99,0.99,0.99,1"')\r\n                beatOneAppNum = i\r\n            elseif not beatOtherAppNum then\r\n                Cmd('Store Appearance '..i..' "BeatGridOthers"')\r\n                Cmd('Set Appearance '..i..' "Color" "0,0,0,1"')\r\n                break\r\n            end\r\n        end\r\n    end\r\nend\r\n\r\nlocal function DeleteGridRange(songNum,trackGroup)\r\n    local startRaw = firstBeatSeconds * 16777216\r\n    local endRaw = lastBeatSeconds * 16777216\r\n    local deletionIndexList = {}\r\n    local markerList = ObjectList('Timecode '..songNum..'.'..trackGroup..'.0.1 Thru')\r\n    if #markerList == 0 then return end --early exit if no markers \r\n    -- find all markers in between start and end \r\n    for _, marker in ipairs(markerList) do\r\n        if marker.rawstart < endRaw and marker.rawstart >= startRaw then\r\n            table.insert(deletionIndexList, marker.index)\r\n        end\r\n    end\r\n    if #deletionIndexList == 0 then return end --early exit if no markers \r\n    --delete those markers \r\n    Cmd('CD Timecode '..songNum..'.'..trackGroup..'.0')\r\n    Cmd('Delete '..table.concat(deletionIndexList, \" + \"))\r\n    Cmd('CD Root')\r\nend\r\n\r\n\r\nlocal function CreateBeatGrid(timecodeNum,trackGroup)\r\n    --clear out markers from current timecode track \r\n    DeleteGridRange(timecodeNum,trackGroup)\r\n    local beatOneAppearance = GetObject('Appearance \"BeatGridOnes\"')\r\n    local beatOtherAppearance = GetObject('Appearance \"BeatGridOthers\"')\r\n    --check for beat appearances and make them if they don't exist yet \r\n    if not (beatOneAppearance and beatOtherAppearance) then\r\n        CreateBeatAppearances()\r\n    end\r\n    --create markers \r\n    Cmd('CD Timecode '..timecodeNum..'.'..trackGroup..'.0') --Marker layer \r\n    local progressBarHandle = StartProgress('Creating Beat Grid')\r\n    SetProgressRange(progressBarHandle,1,#beatTable)\r\n    local tcTrack = GetObject('Timecode '..timecodeNum..'.'..trackGroup..'.0')\r\n    for i = 1, #beatTable do\r\n        Cmd('Insert') -- creates new marker at bottom of children list \r\n        local allMarkers = tcTrack:Children()\r\n        local newMarker = allMarkers[#allMarkers] -- 16777216 is 2^24. You'll find that most things under the hood of MA are 24-bit raw. \r\n        newMarker.rawstart = beatTable[i][1] * 16777216\r\n        --make the length of the marker half of a quarter note \r\n        if #beatTable == 1 then \r\n            newMarker.duration = 0.25 -- arbitrary safe default\r\n        elseif i == #beatTable then\r\n            newMarker.duration = (beatTable[i][1] - beatTable[i-1][1]) / 2\r\n        else\r\n            newMarker.duration = (beatTable[i+1][1] - beatTable[i][1]) / 2\r\n        end\r\n        newMarker.appearance = beatTable[i][2] == 1 and beatOneAppearance or beatOtherAppearance\r\n        if beatTable[i][3] ~= 0 then\r\n            newMarker.name = beatTable[i][3]\r\n        end\r\n        IncProgress(progressBarHandle,1)\r\n    end\r\n    Cmd('CD Root')\r\n    StopProgress(progressBarHandle)\r\nend\r\n\r\nfunction DeleteAllMarkers(songNum,trackGroup)\r\n    Cmd('CD Timecode '..songNum..'.'..trackGroup..'.0')\r\n    Cmd('Delete 1 Thru')\r\n    Cmd('CD Root')\r\nend\r\n\r\nlocal function UiBeatGrid()\r\n    local selectedTC = SelectedTimecode()\r\n    local selectedIndex = selectedTC and selectedTC.index or 1\r\n    local defaultCommandButtons = {\r\n        {value = 3, name = \"Cancel\"},\r\n        {value = 2, name = \"OK\"},\r\n        {value = 1, name = \"Clear Grid\"}\r\n    }\r\n    local inputFields = {\r\n        {order = 1, name = \"Timecode Number?\", value = selectedIndex, whiteFilter = \"0123456789\", vkPlugin = \"NumericInput\"},\r\n        {order = 2, name = \"Track Group?\", value = \"1\", whiteFilter = \"0123456789\", vkPlugin = \"NumericInput\"}\r\n    }\r\n    local messageTable = {\r\n        icon = \"object_smart\",\r\n        backColor = \"Window.Plugins\",\r\n        title = \"Tempo Map Importer\",\r\n        message = \"This will apply the tempo map from file: \" .. filename .. \"\\\\r\\\\nAppearances will be found as 'BeatGridOnes' and 'BeatGridOthers'\",\r\n        commands = defaultCommandButtons,\r\n        inputs = inputFields\r\n    }\r\n    local returnTable = MessageBox(messageTable)\r\n    local inputLocation = tonumber(returnTable.inputs[\"Timecode Number?\"])\r\n    local inputTrackGroup = tonumber(returnTable.inputs[\"Track Group?\"]) or 1\r\n    if returnTable.result == 3 then\r\n        --Canceled\r\n        return -- Canceled\r\n    end\r\n    if returnTable.result == 2 then\r\n        if not IsObjectValid(GetObject('Timecode '..inputLocation..'.'..inputTrackGroup)) then\r\n            return Confirm(\"Timecode or Track Group Doesn't Exist\",\"Canceling\",nil,false) \r\n        end\r\n        return CreateBeatGrid(inputLocation,inputTrackGroup)\r\n    end\r\n    if returnTable.result == 1 then\r\n        if Confirm(\"Confirm Deletion\", \"Delete all markers in this track?\", nil, true) then\r\n            return DeleteAllMarkers(inputLocation,inputTrackGroup)\r\n        else return\r\n        end\r\n    end\r\nend\r\n\r\n-- Define what happens when a user presses on the Lua Plugin within MA3 \r\nreturn UiBeatGrid\r\n`;

    return firstLine + comment + start + entries.join("\r\n") + endTable + luaTail;
  }

  // Keep CRLF normalization + UTF-8 safe base64 blocks
  function splitLuaIntoBase64Blocks(luaString, chunkChars = 1024) {
    const blocks = [];
    for (let i = 0; i < luaString.length; i += chunkChars) {
      const chunk = luaString.slice(i, i + chunkChars);
      const utf8Bytes = new TextEncoder().encode(chunk);
      let binary = "";
      for (let j = 0; j < utf8Bytes.length; j++) binary += String.fromCharCode(utf8Bytes[j]);
      blocks.push(btoa(binary));
    }
    return blocks;
  }

  function buildXmlWithLuaBase64(blocks, baseFilename) {
    const totalSize = blocks.reduce((sum, block) => sum + block.length, 0);
    const safeName = (baseFilename || "Untitled") + " Beat Importer";

    let fileContent = `            <FileContent Size="${totalSize}">\n`;
    blocks.forEach(block => {
      fileContent += `                <Block Base64="${block}"/>\n`;
    });
    fileContent += "            </FileContent>";

    return `<?xml version="1.0" encoding="UTF-8"?>
    <GMA3 DataVersion="2.3.1.1">
        <UserPlugin Name="${safeName}" Guid="E8 D2 CD 55 D4 92 10 02 8F EA DF B5 EA 2C DA 1F" Author="PJ Carruth" Version="0.0.0.0">
            <ComponentLua Guid="E8 D2 CD 55 50 D7 10 02 25 FD 30 BF 10 7D 65 1E">
    ${fileContent}
            </ComponentLua>
        </UserPlugin>
    </GMA3>`;
  }

  function downloadXmlFromState() {
    if (!state.beats || state.beats.length === 0) return;

    const lua = buildLuaFromClickBeats(state.beats, state.fileBaseName);
    const blocks = splitLuaIntoBase64Blocks(lua, 1024);
    const xml = buildXmlWithLuaBase64(blocks, state.fileBaseName);

    const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.fileBaseName || "click-track"} Beat Importer.xml`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
  }

  // ---------- EVENTS ----------
function syncScrollSliderToState() {
  // Keep scroll slider consistent with state.scroll (0..1)
  if (!scrollEl) return;
  const v = Math.round(clamp(state.scroll || 0, 0, 1) * 1000);
  scrollEl.value = String(v);
  if (scrollValEl) scrollValEl.textContent = `${Math.round((v / 1000) * 100)}%`;
}

if (zoomEl) {
  zoomEl.addEventListener("input", () => {
    // Preserve the current view center when changing zoom.
    const samples = state.samples;
    if (!samples) return;

    const total = samples.length;
    const prevZoom = clamp(state.zoom || 1, 1, 50);
    const prevViewLen = Math.max(1, Math.floor(total / prevZoom));
    const prevScroll = clamp(state.scroll || 0, 0, 1);
    const prevMaxStart = Math.max(0, total - prevViewLen);
    const prevStart = Math.floor(prevScroll * prevMaxStart);
    const center = prevStart + prevViewLen / 2;

    state.zoom = Number(zoomEl.value) || 1;
    state.zoom = clamp(state.zoom, 1, 50);
    if (zoomValEl) zoomValEl.textContent = `${state.zoom}×`;

    const newViewLen = Math.max(1, Math.floor(total / state.zoom));
    const newMaxStart = Math.max(0, total - newViewLen);
    const newStart = clamp(Math.floor(center - newViewLen / 2), 0, newMaxStart);

    state.scroll = newMaxStart ? (newStart / newMaxStart) : 0;
    syncScrollSliderToState();
    drawWaveformAndOverlay();
  });
}


  scrollEl.addEventListener("input", () => {
    // IMPORTANT: if scrollEl is 0..1000, map to 0..1
    const v = Number(scrollEl.value) || 0;
    state.scroll = clamp(v / 1000, 0, 1);
    if (scrollValEl) scrollValEl.textContent = `${Math.round(state.scroll * 100)}%`;
    drawWaveformAndOverlay();
  });

  window.addEventListener("resize", () => drawWaveformAndOverlay());

  canvas.addEventListener("mousemove", (e) => {
    const hit = hitTestMarker(e.clientX, e.clientY);
    if (!hit) { hideTooltip(); return; }
    const beat = state.beats[hit.beatIndex];
    if (!beat) { hideTooltip(); return; }
    showTooltip(e, beat);
  });

  canvas.addEventListener("mouseleave", () => hideTooltip());

  canvas.addEventListener("click", (e) => {
    const hit = hitTestMarker(e.clientX, e.clientY);
    if (!hit) return;
    state.selectedBeatIndex = hit.beatIndex;
    drawWaveformAndOverlay();
  });

  downloadBtn.addEventListener("click", () => {
    if (downloadBtn.disabled) return;
    downloadXmlFromState();
  });

  processBtn.addEventListener("click", async () => {
    if (!fileInput.files.length) return;

    downloadBtn.disabled = true;
    output.textContent = "Analyzing…";

    try {
      await audioCtx.resume();

      const file = fileInput.files[0];
      state.fileBaseName = baseFileName(file.name);

      const buffer = await decode(file);
      state.audioBuffer = buffer;
      state.sampleRate = buffer.sampleRate;

      // mono: take channel 0
      const samples = buffer.getChannelData(0);
      state.samples = samples;

      // reset view
      state.zoom = zoomEl ? Number(zoomEl.value) : 1;
      state.scroll = 0;
      scrollEl.value = "0";
      if (zoomValEl) zoomValEl.textContent = `${state.zoom}×`;
      if (scrollValEl) scrollValEl.textContent = "0%";
      state.selectedBeatIndex = -1;

      // 1) detect click times
      const clickTimes = detectClicks(samples, state.sampleRate);

      // 2) analyze centroid per click
      const events = [];
      for (const t of clickTimes) {
        const centroid = await analyzeCentroid(samples, state.sampleRate, t);
        events.push({ time: t, centroid });
      }

      // 3) classify downbeats using centroid clustering
      const centroids = events.map(e => e.centroid);
      const { c1, c2 } = kmeans2(centroids);

      // assign to closest centroid
      let group1 = 0, group2 = 0;
      const prelim = events.map(e => {
        const d1 = Math.abs(e.centroid - c1);
        const d2 = Math.abs(e.centroid - c2);
        const g = (d1 <= d2) ? 1 : 2;
        if (g === 1) group1++; else group2++;
        return { ...e, group: g };
      });

      // fewer occurrences is likely the downbeat tone
      const downGroup = group1 <= group2 ? 1 : 2;
      let beats = prelim
        .sort((a, b) => a.time - b.time)
        .map(e => ({
          time: e.time,
          centroid: e.centroid,
          downbeat: (e.group === downGroup) ? 1 : 0
        }));

      // 4) beats-per-bar autodetect + refine to a stable grid
      const refined = refineDownbeatsByBarGrid(beats);
      beats = refined.beats;

      // 5) tempo outputs per your rule
      beats = computeTempoOutputs(beats);

      // store
      state.beats = beats;

      // draw + output list
      drawWaveformAndOverlay();
      renderBeatList();

      downloadBtn.disabled = (state.beats.length === 0);
    } catch (err) {
      console.error(err);
      output.textContent = `Error: ${err?.message || String(err)}`;
      state.beats = [];
      downloadBtn.disabled = true;
    }
  });

})();
