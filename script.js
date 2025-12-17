const audioCtx = new AudioContext();
const fileInput = document.getElementById('fileInput');
const processBtn = document.getElementById('processBtn');
const canvas = document.getElementById('waveform');
const output = document.getElementById('output');
const ctx = canvas.getContext('2d');

processBtn.onclick = async () => {
const file = fileInput.files[0];
if (!file) return;

const buffer = await loadAudio(file);
const samples = buffer.getChannelData(0);

drawWaveform(samples);

const clicks = detectClicks(samples, buffer.sampleRate);
const enriched = clicks.map(t => ({
time: t,
freq: analyzeFrequency(samples, buffer.sampleRate, t)
}));

const classified = classifyBeats(enriched);
const tempoChanges = detectTempoChanges(clicks);

output.textContent = JSON.stringify({
downbeats: classified.downbeats,
beats: classified.beats,
tempoChanges
}, null, 2);
};

async function loadAudio(file) {
const data = await file.arrayBuffer();
return audioCtx.decodeAudioData(data);
}

function detectClicks(samples, sr) {
const threshold = 0.4;
const minGap = 0.05;
const clicks = [];
let last = -1;

for (let i = 0; i < samples.length; i++) {
const amp = Math.abs(samples[i]);
const time = i / sr;
if (amp > threshold && time - last > minGap) {
clicks.push(time);
last = time;
}
}
return clicks;
}

function analyzeFrequency(samples, sr, time) {
const size = 2048;
const start = Math.floor(time * sr);
let max = 0;
let index = 0;

for (let i = 0; i < size; i++) {
const v = Math.abs(samples[start + i] || 0);
if (v > max) {
max = v;
index = i;
}
}
return index * (sr / size);
}

function classifyBeats(data) {
const freqs = data.map(d => d.freq).sort((a,b)=>a-b);
const mid = freqs[Math.floor(freqs.length/2)];
const low = [], high = [];

data.forEach(d => (d.freq < mid ? low : high).push(d));

return low.length < high.length
? { downbeats: low, beats: high }
: { downbeats: high, beats: low };
}

function detectTempoChanges(times, tol = 1) {
let last = null;
}