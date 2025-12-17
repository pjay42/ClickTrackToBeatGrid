const audioCtx = new AudioContext();
const fileInput = document.getElementById("fileInput");
const analyzeBtn = document.getElementById("analyze");
const canvas = document.getElementById("waveform");
const ctx = canvas.getContext("2d");
const output = document.getElementById("output");

analyzeBtn.addEventListener("click", async () => {
  if (!fileInput.files.length) return;

  // REQUIRED for Chrome / Safari
  await audioCtx.resume();

  const file = fileInput.files[0];
  const buffer = await decode(file);
  const samples = buffer.getChannelData(0);
  const sr = buffer.sampleRate;

  resizeCanvas();
  drawWaveform(samples);

  const clicks = detectClicks(samples, sr);

  const analyzed = [];
  for (const time of clicks) {
    const freq = await analyzeFFT(samples, sr, time);
    analyzed.push({ time, freq });
  }

  const { downbeats, beats } = classify(analyzed);
  const tempoChanges = detectTempo(clicks);

  output.textContent = JSON.stringify(
    { downbeats, beats, tempoChanges },
    null,
    2
  );
});

async function decode(file) {
  const data = await file.arrayBuffer();
  return audioCtx.decodeAudioData(data);
}
