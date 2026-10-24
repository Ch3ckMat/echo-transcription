// Worker de transcription — exécute Whisper (Transformers.js) hors du fil principal.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

// Pas de modèles locaux : tout vient du hub Hugging Face (CORS activé).
env.allowLocalModels = false;

// Dans certains contextes (iframe sandbox), l'API Cache est bloquée :
// on la désactive alors pour éviter un échec silencieux du chargement.
if (typeof caches !== 'undefined') {
  try {
    await caches.open('echo-cache-probe');
  } catch {
    env.useBrowserCache = false;
  }
} else {
  env.useBrowserCache = false;
}

const state = {
  instance: null,
  modelId: null,
  device: null,
};

// Sur WebGPU, l'encodeur de Whisper est sensible à la quantification :
// fp32 pour l'encodeur, q4 pour le décodeur. Sur WASM (CPU), q8 partout.
const DEVICE_DTYPES = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: 'q8',
};

async function createPipeline(modelId, device) {
  return pipeline('automatic-speech-recognition', modelId, {
    device,
    dtype: DEVICE_DTYPES[device] ?? 'q8',
    progress_callback: (data) => self.postMessage({ type: 'progress', data }),
  });
}

async function load(modelId, requestedDevice) {
  const needsNew =
    state.instance === null || state.modelId !== modelId || state.device !== requestedDevice;

  let device = requestedDevice;
  if (needsNew) {
    if (state.instance !== null) {
      await state.instance.dispose();
      state.instance = null;
    }
    try {
      state.instance = await createPipeline(modelId, device);
    } catch (err) {
      // Repli : si WebGPU échoue (pilote, mémoire…), on retente en WASM.
      if (device === 'webgpu') {
        self.postMessage({
          type: 'info',
          message: 'WebGPU indisponible, bascule vers le processeur (WASM).',
        });
        device = 'wasm';
        state.instance = await createPipeline(modelId, device);
      } else {
        throw err;
      }
    }
    state.modelId = modelId;
    state.device = device;
  }
  return device;
}

self.addEventListener('message', async (event) => {
  const message = event.data;

  try {
    if (message.type === 'load') {
      const deviceUsed = await load(message.modelId, message.device);
      self.postMessage({ type: 'ready', device: deviceUsed });
      return;
    }

    if (message.type === 'transcribe') {
      if (state.instance === null) throw new Error('Le modèle n’est pas chargé.');

      const output = await state.instance(message.audio, {
        // Fenêtre glissante : découpage en segments de 30 s avec un
        // recouvrement de 5 s pour ne rien perdre ni dupliquer.
        chunk_length_s: 30,
        stride_length_s: 5,
        language: message.language || null,
        task: 'transcribe',
      });

      const text = (output?.text ?? '').trim();
      self.postMessage({ type: 'result', text });
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err?.message || 'Une erreur inattendue s’est produite.',
    });
  }
});
