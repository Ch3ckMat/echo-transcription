// Écho — logique principale : dépôt du fichier, décodage audio, pilotage du worker.
const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  dropzoneButton: $('dropzone-button'),
  fileInput: $('file-input'),
  fileCard: $('file-card'),
  fileName: $('file-name'),
  fileSize: $('file-size'),
  fileDuration: $('file-duration'),
  fileRemove: $('file-remove'),
  audioPlayer: $('audio-player'),
  languageSelect: $('language-select'),
  modelSelect: $('model-select'),
  transcribeButton: $('transcribe-button'),
  status: $('status'),
  statusSpinner: $('status-spinner'),
  statusText: $('status-text'),
  statusEngine: $('status-engine'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  error: $('error'),
  errorText: $('error-text'),
  resultCard: $('result-card'),
  resultTextarea: $('result-textarea'),
  resultCount: $('result-count'),
  copyButton: $('copy-button'),
  copyButtonLabel: $('copy-button-label'),
  downloadButton: $('download-button'),
};

const MODELS = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
};

const state = {
  file: null,
  audioData: null, // Float32Array 16 kHz mono
  duration: 0,
  worker: null,
  busy: false,
  elapsedTimer: null,
  elapsedStart: 0,
};

/* ————— Utilitaires ————— */

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

function showError(message) {
  els.errorText.textContent = message;
  els.error.hidden = false;
}

function clearError() {
  els.error.hidden = true;
  els.errorText.textContent = '';
}

function setStatus(text, { engine = '', showProgress = false, showSpinner = true } = {}) {
  els.status.hidden = false;
  els.statusText.textContent = text;
  els.statusEngine.textContent = engine;
  els.statusSpinner.hidden = !showSpinner;
  els.progress.hidden = !showProgress;
  if (!showProgress) els.progressBar.style.width = '0%';
}

function hideStatus() {
  els.status.hidden = true;
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
}

function setBusy(busy) {
  state.busy = busy;
  els.transcribeButton.disabled = busy || !state.file;
  els.fileRemove.disabled = busy;
  els.languageSelect.disabled = busy;
  els.modelSelect.disabled = busy;
}

/* ————— Sélection du fichier ————— */

async function handleFile(file) {
  clearError();
  state.file = file;
  state.audioData = null;
  state.duration = 0;

  els.resultCard.hidden = true;
  els.fileName.textContent = file.name;
  els.fileSize.textContent = formatBytes(file.size);
  els.fileDuration.textContent = 'analyse…';
  els.fileCard.hidden = false;
  els.audioPlayer.src = URL.createObjectURL(file);
  els.transcribeButton.disabled = false;

  // Décodage en PCM mono 16 kHz, format attendu par Whisper.
  try {
    const buffer = await file.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await audioCtx.decodeAudioData(buffer.slice(0));
    audioCtx.close();

    const targetRate = 16000;
    const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const offline = new OfflineAudioContext(1, length, targetRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();

    state.audioData = rendered.getChannelData(0);
    state.duration = decoded.duration;
    els.fileDuration.textContent = formatDuration(state.duration);
  } catch (err) {
    resetFile();
    showError(
      "Impossible de lire ce fichier audio. Formats acceptés : MP3, WAV, OGG, M4A, FLAC, WEBM. Si le fichier est lisible, essayez un autre format."
    );
  }
}

function resetFile() {
  if (state.busy) return;
  state.file = null;
  state.audioData = null;
  state.duration = 0;
  els.fileCard.hidden = true;
  els.audioPlayer.pause();
  els.audioPlayer.removeAttribute('src');
  els.transcribeButton.disabled = true;
  els.resultCard.hidden = true;
  hideStatus();
  clearError();
}

/* ————— Dépôt par glisser-déposer ————— */

['dragenter', 'dragover'].forEach((type) => {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((type) => {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove('dragover');
  });
});
els.dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

els.dropzoneButton.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (file) handleFile(file);
  els.fileInput.value = '';
});
els.fileRemove.addEventListener('click', resetFile);

/* ————— Transcription ————— */

function ensureWorker() {
  if (state.worker) return state.worker;
  const worker = new Worker('worker.js', { type: 'module' });
  worker.addEventListener('message', onWorkerMessage);
  state.worker = worker;
  return worker;
}

const fileProgress = new Map();

function updateDownloadProgress() {
  let loaded = 0;
  let total = 0;
  for (const { loaded: l, total: t } of fileProgress.values()) {
    loaded += l;
    total += t;
  }
  if (total > 0) {
    const percent = Math.min(100, Math.round((loaded / total) * 100));
    els.progressBar.style.width = `${percent}%`;
    setStatus(
      `Téléchargement du modèle… ${percent} % (${formatBytes(loaded)} / ${formatBytes(total)})`,
      { showProgress: true }
    );
  }
}

function startElapsedTimer() {
  state.elapsedStart = Date.now();
  setStatus('Transcription en cours… 0 s', { engine: els.statusEngine.textContent });
  state.elapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - state.elapsedStart) / 1000);
    setStatus(`Transcription en cours… ${elapsed} s`, {
      engine: els.statusEngine.textContent,
    });
  }, 1000);
}

function onWorkerMessage(event) {
  const message = event.data;

  if (message.type === 'progress') {
    const d = message.data;
    if (d.status === 'progress' && d.total > 0) {
      fileProgress.set(d.file, { loaded: d.loaded, total: d.total });
      updateDownloadProgress();
    }
    return;
  }

  if (message.type === 'info') {
    els.statusEngine.textContent = 'WASM';
    return;
  }

  if (message.type === 'ready') {
    fileProgress.clear();
    els.statusEngine.textContent = message.device === 'webgpu' ? 'WebGPU' : 'WASM';
    startElapsedTimer();
    if (typeof state.pendingSend === 'function') {
      const send = state.pendingSend;
      state.pendingSend = null;
      send();
    }
    return;
  }

  if (message.type === 'result') {
    hideStatus();
    setBusy(false);
    if (!message.text) {
      showError("Aucune parole n'a été détectée dans ce fichier. Essayez un enregistrement plus proche de la voix, ou vérifiez la langue sélectionnée.");
    } else {
      els.resultTextarea.value = message.text;
      els.resultCard.hidden = false;
      updateCount();
      els.resultTextarea.focus();
    }
    return;
  }

  if (message.type === 'error') {
    hideStatus();
    setBusy(false);
    showError(`La transcription a échoué : ${message.message}`);
  }
}

function updateCount() {
  const text = els.resultTextarea.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  els.resultCount.textContent = `${words} mot${words > 1 ? 's' : ''} · ${text.length} caractères`;
}

async function transcribe() {
  if (!state.file || !state.audioData || state.busy) return;
  clearError();
  setBusy(true);
  els.resultCard.hidden = true;

  const modelId = MODELS[els.modelSelect.value] ?? MODELS.base;
  const language = els.languageSelect.value;
  const requestedDevice = (await navigator.gpu?.requestAdapter()) ? 'webgpu' : 'wasm';

  setStatus('Préparation du modèle…', { showProgress: true });
  fileProgress.clear();

  const worker = ensureWorker();
  // L'audio n'est envoyé qu'une fois le modèle prêt (voir « ready » dans onWorkerMessage).
  state.pendingSend = () => {
    const audio = state.audioData;
    worker.postMessage({ type: 'transcribe', audio, language }, [audio.buffer]);
  };
  worker.postMessage({ type: 'load', modelId, device: requestedDevice });
}

els.transcribeButton.addEventListener('click', transcribe);

/* ————— Résultat : copie et téléchargement ————— */

els.resultTextarea.addEventListener('input', updateCount);

els.copyButton.addEventListener('click', async () => {
  const text = els.resultTextarea.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Repli pour les contextes sans Clipboard API (iframe non sécurisée…)
    els.resultTextarea.select();
    document.execCommand('copy');
    els.resultTextarea.setSelectionRange(0, 0);
  }
  els.copyButtonLabel.textContent = 'Copié';
  setTimeout(() => {
    els.copyButtonLabel.textContent = 'Copier';
  }, 2000);
});

els.downloadButton.addEventListener('click', () => {
  const text = els.resultTextarea.value;
  if (!text) return;
  const base = (state.file?.name || 'transcription').replace(/\.[^.]+$/, '');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${base}.txt`;
  link.click();
  URL.revokeObjectURL(url);
});
