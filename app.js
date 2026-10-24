// Écho — logique principale : dépôt du fichier, décodage audio, pilotage du moteur.
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

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
// Sur WebGPU, l'encodeur de Whisper est sensible à la quantisation :
// fp32 pour l'encodeur, q4 pour le décodeur. Sur WASM (CPU), q8 partout.
const DEVICE_DTYPES = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: 'q8',
};

const state = {
  file: null,
  audioData: null, // Float32Array 16 kHz mono
  duration: 0,
  engine: null,
  pendingSend: null,
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
  // Quand un fichier est chargé, la zone de dépôt devient redondante :
  // on la masque pour garder le bouton d'action à l'écran.
  els.dropzone.hidden = true;
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
      'Impossible de lire ce fichier audio. Formats acceptés : MP3, WAV, OGG, M4A, FLAC, WEBM. Si le fichier est lisible, essayez un autre format.'
    );
  }
}

function resetFile() {
  if (state.busy) return;
  state.file = null;
  state.audioData = null;
  state.duration = 0;
  els.fileCard.hidden = true;
  els.dropzone.hidden = false;
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

/* ————— Moteur de transcription ————— */
// Deux modes, même protocole de messages :
//  1. Web Worker (cas général : l'interface reste fluide pendant le calcul) ;
//  2. Fil principal (repli), car certains contextes intégrés — aperçus
//     sandboxés — bloquent la création de workers (SecurityError).

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

function onEngineMessage(message) {
  if (message.type === 'progress') {
    const d = message.data;
    // « progress_total » agrège tous les fichiers du modèle : c'est la
    // mesure la plus fiable, on l'utilise en priorité.
    if (d.status === 'progress_total' && d.total > 0) {
      const percent = Math.min(100, Math.round((d.loaded / d.total) * 100));
      els.progressBar.style.width = `${percent}%`;
      setStatus(
        `Téléchargement du modèle… ${percent} % (${formatBytes(d.loaded)} / ${formatBytes(d.total)})`,
        { showProgress: true }
      );
    } else if (d.status === 'progress' && d.total > 0) {
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
    els.statusEngine.textContent =
      message.device === 'webgpu'
        ? 'WebGPU'
        : message.inline
          ? 'CPU · sans worker'
          : 'WASM';
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
      showError(
        "Aucune parole n'a été détectée dans ce fichier. Essayez un enregistrement plus proche de la voix, ou vérifiez la langue sélectionnée."
      );
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

/* Création du moteur : worker d'abord, repli fil principal ensuite. */
async function createEngine() {
  // 1. Web Worker
  try {
    const worker = new Worker('worker.js', { type: 'module' });
    const booted = await new Promise((resolve) => {
      const finish = (ok) => {
        worker.removeEventListener('message', onBoot);
        worker.removeEventListener('error', onFail);
        clearTimeout(timer);
        resolve(ok);
      };
      const onBoot = (e) => e.data?.type === 'boot' && finish(true);
      const onFail = () => finish(false);
      const timer = setTimeout(() => finish(false), 15000);
      worker.addEventListener('message', onBoot);
      worker.addEventListener('error', onFail);
    });
    if (booted) {
      worker.addEventListener('message', (e) => onEngineMessage(e.data));
      worker.addEventListener('error', () => {
        hideStatus();
        setBusy(false);
        state.pendingSend = null;
        showError(
          "Le moteur de transcription a été interrompu. Rechargez la page puis relancez la transcription."
        );
      });
      return {
        post: (message, transfer) => worker.postMessage(message, transfer),
      };
    }
    worker.terminate();
  } catch (e) {
    // Workers indisponibles (contexte sandboxé) → repli ci-dessous.
  }

  // 2. Repli : Transformers.js sur le fil principal
  const mod = await import(TRANSFORMERS_CDN);
  const { pipeline, env } = mod;
  env.allowLocalModels = false;
  // Dans certains contextes (iframe sandbox), l'API Cache est bloquée :
  // on la désactive alors pour éviter un échec silencieux du chargement.
  try {
    await caches.open('echo-cache-probe');
  } catch {
    env.useBrowserCache = false;
  }

  const engineState = { instance: null, modelId: null, device: null };
  const notify = (message) => onEngineMessage(message);

  const createPipeline = (modelId, device) =>
    pipeline('automatic-speech-recognition', modelId, {
      device,
      dtype: DEVICE_DTYPES[device] ?? 'q8',
      progress_callback: (data) => notify({ type: 'progress', data }),
    });

  return {
    inline: true,
    async post(message) {
      try {
        if (message.type === 'load') {
          if (
            engineState.instance === null ||
            engineState.modelId !== message.modelId ||
            engineState.device !== message.device
          ) {
            if (engineState.instance !== null) {
              await engineState.instance.dispose();
            }
            let device = message.device;
            try {
              engineState.instance = await createPipeline(message.modelId, device);
            } catch (err) {
              // Repli : si WebGPU échoue (pilote, mémoire…), on retente en WASM.
              if (device === 'webgpu') {
                notify({
                  type: 'info',
                  message: 'WebGPU indisponible, bascule vers le processeur (WASM).',
                });
                device = 'wasm';
                engineState.instance = await createPipeline(message.modelId, device);
              } else {
                throw err;
              }
            }
            engineState.modelId = message.modelId;
            engineState.device = device;
          }
          notify({ type: 'ready', device: engineState.device, inline: true });
          return;
        }

        if (message.type === 'transcribe') {
          if (engineState.instance === null) throw new Error("Le modèle n'est pas chargé.");
          const output = await engineState.instance(message.audio, {
            // Fenêtre glissante : segments de 30 s avec recouvrement de 5 s
            // pour ne rien perdre ni dupliquer sur les fichiers longs.
            chunk_length_s: 30,
            stride_length_s: 5,
            language: message.language || null,
            task: 'transcribe',
          });
          notify({ type: 'result', text: (output?.text ?? '').trim() });
        }
      } catch (err) {
        notify({
          type: 'error',
          message: err?.message || "Une erreur inattendue s'est produite.",
        });
      }
    },
  };
}

async function getEngine() {
  if (!state.engine) state.engine = await createEngine();
  return state.engine;
}

/* ————— Transcription ————— */

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

  let engine;
  try {
    engine = await getEngine();
  } catch (err) {
    hideStatus();
    setBusy(false);
    showError(
      "Le moteur de transcription n'a pas pu démarrer. Vérifiez votre connexion (le modèle se télécharge depuis un CDN), puis rechargez la page."
    );
    return;
  }

  // L'audio n'est envoyé qu'une fois le modèle prêt (voir « ready » dans onEngineMessage).
  state.pendingSend = () => {
    const audio = state.audioData;
    engine.post({ type: 'transcribe', audio, language }, [audio.buffer]);
  };
  engine.post({ type: 'load', modelId, device: requestedDevice });
}

els.transcribeButton.addEventListener('click', transcribe);

/* ————— Résultat : copie et téléchargement ————— */

els.resultTextarea.addEventListener('input', updateCount);

function updateCount() {
  const text = els.resultTextarea.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  els.resultCount.textContent = `${words} mot${words > 1 ? 's' : ''} · ${text.length} caractères`;
}

els.copyButton.addEventListener('click', async () => {
  const text = els.resultTextarea.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Repli pour les contextes sans Clipboard API (iframe sandbox…)
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
