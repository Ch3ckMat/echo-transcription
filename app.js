// Écho — logique principale : dépôt des fichiers, décodage audio, pilotage du moteur.
const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $('dropzone'),
  dropzoneButton: $('dropzone-button'),
  fileInput: $('file-input'),
  fileListCard: $('file-list-card'),
  fileList: $('file-list'),
  languageSelect: $('language-select'),
  modelSelect: $('model-select'),
  transcribeButton: $('transcribe-button'),
  transcribeLabel: $('transcribe-label'),
  status: $('status'),
  statusSpinner: $('status-spinner'),
  statusText: $('status-text'),
  statusEngine: $('status-engine'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  error: $('error'),
  errorText: $('error-text'),
  results: $('results'),
  resultsTitle: $('results-title'),
  resultCards: $('result-cards'),
  downloadAllButton: $('download-all-button'),
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
  files: [], // { id, file, audioData, duration, status, result, error, objectUrl }
  // status : 'decoding' | 'ready' | 'running' | 'done' | 'error'
  engine: null,
  engineReady: false,
  engineFatal: false,
  pendingSend: null,
  pendingLoad: null,
  pendingResults: new Map(), // id du fichier -> resolve(result|{error})
  busy: false,
  elapsedTimer: null,
  elapsedStart: 0,
  runLabel: '',
};
let fileId = 0;

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

/* ————— Liste de fichiers ————— */

function fileItem(id) {
  return state.files.find((f) => f.id === id);
}

function badgeFor(item) {
  if (item.status === 'decoding') return { text: 'Analyse…', cls: 'badge-pending' };
  if (item.status === 'running') return { text: 'En cours', cls: 'badge-running' };
  if (item.status === 'done') return { text: 'Terminé', cls: 'badge-done' };
  if (item.status === 'error') return { text: 'Erreur', cls: 'badge-error' };
  return { text: 'En attente', cls: 'badge-pending' };
}

function buildRow(item) {
  const li = document.createElement('li');
  li.className = 'file-item';
  li.dataset.id = item.id;
  li.innerHTML = `
    <div class="file-head">
      <svg class="file-icon" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
      </svg>
      <div class="file-meta">
        <p class="file-name"></p>
        <p class="file-details"><span class="file-size"></span> · <span class="file-duration"></span></p>
      </div>
      <span class="badge"></span>
      <button type="button" class="btn btn-ghost btn-icon file-play" aria-label="Écouter le fichier" data-testid="button-play">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
      </button>
      <button type="button" class="btn btn-ghost btn-icon file-remove" aria-label="Retirer le fichier" data-testid="button-remove-file">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <audio controls class="audio-player" hidden data-testid="audio-player"></audio>`;
  // Le nom du fichier vient de l'utilisateur : textContent, jamais innerHTML.
  li.querySelector('.file-name').textContent = item.file.name;
  li.querySelector('.file-size').textContent = formatBytes(item.file.size);
  return li;
}

function renderFileList() {
  els.fileList.replaceChildren(...state.files.map(buildRow));
  for (const li of els.fileList.children) {
    const item = fileItem(Number(li.dataset.id));
    if (!item) continue;
    const badge = badgeFor(item);
    const badgeEl = li.querySelector('.badge');
    badgeEl.textContent = badge.text;
    badgeEl.className = `badge ${badge.cls}`;
    const durationEl = li.querySelector('.file-duration');
    if (item.status === 'error') {
      durationEl.textContent = item.error ?? 'erreur';
      durationEl.classList.add('file-details-error');
    } else {
      durationEl.textContent =
        item.duration === null ? 'analyse…' : formatDuration(item.duration);
      durationEl.classList.remove('file-details-error');
    }
    const removeBtn = li.querySelector('.file-remove');
    removeBtn.disabled = state.busy || item.status === 'running';
    const playBtn = li.querySelector('.file-play');
    playBtn.disabled = state.busy || item.objectUrl === null;
    if (item.objectUrl !== null) {
      li.querySelector('audio').src = item.objectUrl;
    }
  }
  els.fileListCard.hidden = state.files.length === 0;
}

/* ————— Décodage audio ————— */

// Décodage en PCM mono 16 kHz, format attendu par Whisper.
async function decodeItem(item) {
  try {
    const buffer = await item.file.arrayBuffer();
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

    item.audioData = rendered.getChannelData(0);
    item.duration = decoded.duration;
    item.status = 'ready';
  } catch (err) {
    item.status = 'error';
    item.error = 'fichier audio illisible';
  }
}

async function addFiles(list) {
  clearError();
  const toDecode = [];
  for (const file of list) {
    const item = {
      id: ++fileId,
      file,
      audioData: null,
      duration: null,
      status: 'decoding',
      result: null,
      error: null,
      objectUrl: URL.createObjectURL(file),
    };
    state.files.push(item);
    toDecode.push(item);
  }
  renderFileList();
  updateControls();
  // Décodage séquentiel : évite d'ouvrir plusieurs AudioContext en parallèle.
  for (const item of toDecode) {
    if (!state.files.includes(item)) continue; // retiré pendant l'analyse
    await decodeItem(item);
    renderFileList();
    updateControls();
  }
  const failed = toDecode.filter((f) => f.status === 'error');
  if (failed.length > 0) {
    showError(
      `${failed.length === 1 ? 'Ce fichier est' : 'Ces fichiers sont'} illisible(s) : ` +
        `${failed.map((f) => f.file.name).join(', ')}. Formats acceptés : MP3, WAV, OGG, M4A, FLAC, WEBM.`
    );
  }
}

function removeItem(item) {
  if (state.busy || item.status === 'running') return;
  state.files = state.files.filter((f) => f !== item);
  if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  renderFileList();
  renderResults();
  updateControls();
}

function updateControls() {
  // Un fichier est transcribable dès que son décodage a réussi (audioData
  // présent) — même si une tentative de transcription a échoué (réessayable).
  const transcribable = state.files.some((f) => f.audioData !== null);
  // Pendant le décodage d'une sélection, on attend : lancer maintenant
  // traiterait les fichiers déjà décodés et ignorerait les autres.
  const decoding = state.files.some((f) => f.status === 'decoding');
  els.transcribeButton.disabled = state.busy || decoding || !transcribable;
  els.languageSelect.disabled = state.busy;
  els.modelSelect.disabled = state.busy;
  if (!state.busy && !decoding) {
    const pending = state.files.filter(
      (f) => f.audioData !== null && f.result === null && f.status !== 'decoding'
    ).length;
    const total = state.files.filter((f) => f.audioData !== null).length;
    els.transcribeLabel.textContent =
      pending === 0 && total > 0
        ? 'Retranscrire tout'
        : pending > 1
          ? `Transcrire ${pending} fichiers`
          : 'Transcrire l\'audio';
  }
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
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length > 0) addFiles(files);
});

els.dropzoneButton.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const files = [...(els.fileInput.files ?? [])];
  if (files.length > 0) addFiles(files);
  els.fileInput.value = '';
});

// Interactions sur la liste (écouter / retirer), par délégation.
els.fileList.addEventListener('click', (event) => {
  const li = event.target.closest('.file-item');
  if (!li) return;
  const item = fileItem(Number(li.dataset.id));
  if (!item) return;

  if (event.target.closest('.file-remove') && !state.busy) {
    removeItem(item);
    return;
  }
  if (event.target.closest('.file-play')) {
    const audio = li.querySelector('audio');
    // On met en pause les autres lecteurs avant d'afficher celui-ci.
    for (const other of els.fileList.querySelectorAll('audio')) {
      if (other !== audio) {
        other.pause();
        other.hidden = true;
      }
    }
    audio.hidden = !audio.hidden;
    if (!audio.hidden) audio.play().catch(() => {});
  }
});

/* ————— Moteur de transcription ————— */
// Deux modes, même protocole de messages :
//  1. Web Worker (cas général : l'interface reste fluide pendant le calcul) ;
//  2. Fil principal (repli), car certains contextes intégrés — aperçus
//     sandboxés — bloquent la création de workers (SecurityError).

const fileProgress = new Map();
// Dès qu'un événement « progress_total » (agrégé) est arrivé, on ignore les
// estimations par fichier, moins fiables, pour ne pas faire reculer la barre.
let hasTotalProgress = false;

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

function resolveAllPending(error) {
  for (const resolve of state.pendingResults.values()) resolve({ error });
  state.pendingResults.clear();
}

function onEngineMessage(message) {
  if (message.type === 'progress') {
    const d = message.data;
    // « progress_total » agrège tous les fichiers du modèle : c'est la
    // mesure la plus fiable, on l'utilise en priorité.
    if (d.status === 'progress_total' && d.total > 0) {
      hasTotalProgress = true;
      const percent = Math.min(100, Math.round((d.loaded / d.total) * 100));
      els.progressBar.style.width = `${percent}%`;
      setStatus(
        `Téléchargement du modèle… ${percent} % (${formatBytes(d.loaded)} / ${formatBytes(d.total)})`,
        { showProgress: true }
      );
    } else if (d.status === 'progress' && d.total > 0 && !hasTotalProgress) {
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
    state.engineReady = true;
    if (typeof state.pendingSend === 'function') {
      const send = state.pendingSend;
      state.pendingSend = null;
      send();
    }
    return;
  }

  if (message.type === 'result') {
    const resolve = state.pendingResults.get(message.id);
    if (resolve) {
      state.pendingResults.delete(message.id);
      resolve({ text: message.text });
    }
    return;
  }

  if (message.type === 'error') {
    const resolve = state.pendingResults.get(message.id);
    if (resolve) {
      state.pendingResults.delete(message.id);
      resolve({ error: message.message });
      return;
    }
    // Échec du chargement du modèle (pas d'id de fichier) : on débloque
    // l'attente de « load » pour ne pas laisser la file bloquée indéfiniment.
    if (state.pendingLoad) state.pendingLoad();
    return;
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
        // Worker interrompu en cours d'exécution : on débloque toutes les attentes.
        state.engineFatal = true;
        state.engineReady = false;
        state.engine = null; // worker cassé : ne pas le réutiliser au prochain essai
        resolveAllPending('Le moteur de transcription a été interrompu.');
        if (state.pendingLoad) {
          state.pendingLoad();
        } else if (typeof state.pendingSend === 'function') {
          const send = state.pendingSend;
          state.pendingSend = null;
          send();
        }
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
          notify({ type: 'result', id: message.id, text: (output?.text ?? '').trim() });
        }
      } catch (err) {
        notify({
          type: 'error',
          id: message.id ?? null,
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

/* ————— Transcription (files en séquence) ————— */

function transcribeOne(engine, item, language) {
  return new Promise((resolve) => {
    if (state.engineFatal) {
      resolve({ error: 'Le moteur de transcription a été interrompu.' });
      return;
    }
    state.pendingResults.set(item.id, resolve);
    // Sur le worker, le tampon est transféré (détaché) : on envoie une copie
    // pour pouvoir relancer une transcription sans recharger le fichier.
    if (engine.inline) {
      engine.post({ type: 'transcribe', id: item.id, audio: item.audioData, language });
    } else {
      const audio = item.audioData.slice();
      engine.post({ type: 'transcribe', id: item.id, audio, language }, [audio.buffer]);
    }
  });
}

async function transcribe() {
  // Cible : les fichiers décodés sans résultat (y compris ceux dont une
  // tentative a échoué — ils restent réessayables) ; sinon tous (retranscription).
  let targets = state.files.filter((f) => f.audioData !== null && f.result === null);
  if (targets.length === 0) targets = state.files.filter((f) => f.audioData !== null);
  if (targets.length === 0) return;

  clearError();
  state.busy = true;
  state.engineFatal = false;
  state.engineReady = false;
  updateControls();
  renderFileList();

  const modelId = MODELS[els.modelSelect.value] ?? MODELS.base;
  const language = els.languageSelect.value;
  // Détection GPU protégée : en cas d'échec de requestAdapter(), on reste en WASM.
  let requestedDevice = 'wasm';
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) requestedDevice = 'webgpu';
  } catch {
    // Périphérique GPU non disponible → WASM.
  }

  setStatus('Préparation du modèle…', { showProgress: true });
  fileProgress.clear();
  hasTotalProgress = false;

  let engine;
  try {
    engine = await getEngine();
  } catch (err) {
    hideStatus();
    state.busy = false;
    updateControls();
    showError(
      "Le moteur de transcription n'a pas pu démarrer. Vérifiez votre connexion (le modèle se télécharge depuis un CDN), puis rechargez la page."
    );
    return;
  }

  // L'audio n'est envoyé qu'une fois le modèle prêt (voir « ready » dans onEngineMessage).
  // Un échec du chargement (réseau, mémoire) débloque cette promesse avec false.
  const loaded = await new Promise((resolve) => {
    const done = (ok) => {
      state.pendingLoad = null;
      state.pendingSend = null;
      resolve(ok);
    };
    state.pendingLoad = () => done(false);
    state.pendingSend = () => done(true);
    engine.post({ type: 'load', modelId, device: requestedDevice });
  });
  if (!loaded || state.engineFatal) {
    state.engine = null; // moteur cassé : on le recréera au prochain essai
    state.busy = false;
    updateControls();
    hideStatus();
    showError(
      "Le modèle n'a pas pu être chargé. Vérifiez votre connexion, puis relancez la transcription."
    );
    return;
  }

  const total = targets.length;
  const failures = [];
  state.elapsedStart = Date.now();

  try {
    for (let i = 0; i < total; i++) {
      const item = targets[i];
      item.status = 'running';
      renderFileList();
      state.runLabel = `Transcription ${i + 1}/${total} — ${item.file.name}`;
      if (state.elapsedTimer) clearInterval(state.elapsedTimer);
      state.elapsedTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - state.elapsedStart) / 1000);
        setStatus(`${state.runLabel} · ${elapsed} s`, { engine: els.statusEngine.textContent });
      }, 1000);
      setStatus(`${state.runLabel} · 0 s`, { engine: els.statusEngine.textContent });

      const res = await transcribeOne(engine, item, language);

      if (res.error) {
        item.status = 'error';
        item.error = res.error;
        failures.push(item);
      } else if (!res.text) {
        item.status = 'error';
        item.error = 'aucune parole détectée';
        failures.push(item);
      } else {
        item.result = res.text;
        item.status = 'done';
        // Retranscription réussie : la carte existante affiche l'ancien texte,
        // on remplace son contenu par le nouveau résultat (uniquement pour
        // ce fichier — les éditions des autres cartes sont préservées).
        const card = els.resultCards.querySelector(`[data-id="${item.id}"]`);
        if (card) {
          const textarea = card.querySelector('textarea');
          textarea.value = item.result;
          updateCount(card);
        }
      }
      renderFileList();
      renderResults();
      updateControls();
    }
  } finally {
    hideStatus();
    state.busy = false;
    updateControls();
    renderFileList();
  }

  if (failures.length > 0) {
    showError(
      `${failures.length} fichier${failures.length > 1 ? 's' : ''} n'a${
        failures.length > 1 ? 've' : ''
      } pas pu être transcrit${failures.length > 1 ? 's' : ''} : ` +
        `${failures.map((f) => f.file.name).join(', ')}. ` +
        `Cause la plus fréquente : aucune parole détectée (vérifiez la langue sélectionnée).`
    );
  }
}

els.transcribeButton.addEventListener('click', transcribe);

/* ————— Résultats : cartes, copie et téléchargement ————— */

function resultCardFor(item) {
  let card = els.resultCards.querySelector(`[data-id="${item.id}"]`);
  if (card) return card;

  card = document.createElement('article');
  card.className = 'card result-card';
  card.dataset.id = item.id;
  card.innerHTML = `
    <div class="result-head">
      <div class="result-head-meta">
        <h3 class="result-title"></h3>
        <p class="result-count" data-testid="text-count"></p>
      </div>
    </div>
    <textarea class="result-textarea" rows="8" spellcheck="false" data-testid="textarea-result" aria-label="Texte transcrit, modifiable"></textarea>
    <div class="result-actions">
      <button type="button" class="btn btn-primary" data-action="copy" data-testid="button-copy">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        <span class="copy-label">Copier</span>
      </button>
      <button type="button" class="btn" data-action="download" data-testid="button-download">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Télécharger (.txt)
      </button>
    </div>`;
  // Nom de fichier fourni par l'utilisateur : textContent uniquement.
  card.querySelector('.result-title').textContent = item.file.name;
  card.querySelector('textarea').value = item.result ?? '';
  card.querySelector('textarea').addEventListener('input', () => updateCount(card));
  updateCount(card);
  return card;
}

function updateCount(card) {
  const text = card.querySelector('textarea').value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  card.querySelector('.result-count').textContent =
    `${words} mot${words > 1 ? 's' : ''} · ${text.length} caractères`;
}

function renderResults() {
  const items = state.files.filter((f) => f.result !== null);
  // Retire les cartes des fichiers supprimés ou sans résultat.
  for (const card of [...els.resultCards.children]) {
    if (!items.some((f) => f.id === Number(card.dataset.id))) card.remove();
  }
  // Ajoute / réordonne : l'ordre des cartes suit l'ordre des fichiers.
  let prev = null;
  for (const item of items) {
    const card = resultCardFor(item);
    if (prev) prev.after(card);
    else els.resultCards.prepend(card);
    prev = card;
  }
  els.results.hidden = items.length === 0;
  els.resultsTitle.textContent = `${items.length} transcription${items.length > 1 ? 's' : ''}`;
}

els.resultCards.addEventListener('input', (event) => {
  const card = event.target.closest('.result-card');
  if (card) updateCount(card);
});

function downloadItem(item) {
  const card = els.resultCards.querySelector(`[data-id="${item.id}"]`);
  const text = card ? card.querySelector('textarea').value : (item.result ?? '');
  if (!text) return;
  const base = (item.file.name || 'transcription').replace(/\.[^.]+$/, '');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${base}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}

els.resultCards.addEventListener('click', async (event) => {
  const card = event.target.closest('.result-card');
  if (!card) return;
  const item = fileItem(Number(card.dataset.id));
  if (!item) return;

  if (event.target.closest('[data-action="download"]')) {
    downloadItem(item);
    return;
  }

  if (event.target.closest('[data-action="copy"]')) {
    const textarea = card.querySelector('textarea');
    const label = card.querySelector('.copy-label');
    if (!textarea.value) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(textarea.value);
      copied = true;
    } catch {
      // Repli pour les contextes sans Clipboard API (iframe sandbox…)
      textarea.select();
      copied = document.execCommand('copy');
    }
    if (copied) {
      label.textContent = 'Copié';
    } else {
      // Copie automatique bloquée : on sélectionne tout et on guide l'utilisateur.
      textarea.select();
      label.textContent = 'Copie bloquée';
      showError(
        'La copie automatique est bloquée par ce navigateur. Le texte est sélectionné : utilisez Ctrl+C (ou Cmd+C).'
      );
    }
    setTimeout(() => {
      label.textContent = 'Copier';
    }, 2000);
  }
});

els.downloadAllButton.addEventListener('click', async () => {
  const items = state.files.filter((f) => f.result !== null);
  if (items.length === 0) return;
  els.downloadAllButton.disabled = true;
  for (const item of items) {
    downloadItem(item);
    // Petit délai entre les téléchargements pour ne pas saturer le navigateur.
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  els.downloadAllButton.disabled = false;
});
