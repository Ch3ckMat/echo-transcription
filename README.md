# Écho — Transcription audio locale

Application web qui transcrit des fichiers audio en texte, **entièrement dans le navigateur**.
Le modèle [Whisper](https://huggingface.co/openai/whisper-base) (OpenAI) s'exécute localement via
[Transformers.js](https://huggingface.co/docs/transformers.js) : aucun envoi de fichier vers un serveur,
aucune clé API nécessaire.

## Fonctionnalités

- Dépôt de **plusieurs fichiers à la fois** (glisser-déposer ou sélection) : file d'attente avec état par fichier (en attente, en cours, terminé, erreur)
- Formats acceptés : MP3, WAV, OGG, M4A, FLAC, WEBM
- Trois qualités de modèle : tiny (~40 Mo), base (~80 Mo, par défaut), small (~250 Mo)
- Langue de l'audio sélectionnable (français par défaut, détection automatique possible)
- Accélération WebGPU automatique avec repli CPU (WASM)
- Fichiers longs gérés par fenêtre glissante (segments de 30 s, recouvrement 5 s)
- Résultats par fichier, modifiables, copie vers le presse-papiers, téléchargement `.txt` individuel ou global (« Tout télécharger »)
- Écoute de chaque fichier directement dans la file d'attente
- Thème clair / sombre automatique
- Exécution dans un Web Worker quand le contexte le permet (interface fluide),
  avec repli sur le fil principal pour les contextes sandboxés (aperçus intégrés)

## Utilisation

Aucune installation : déployez le dossier tel quel sur n'importe quel hébergement
statique (GitHub Pages, Netlify, Vercel, etc.), puis ouvrez `index.html`.

La première utilisation télécharge le modèle depuis le CDN Hugging Face (~40 à 250 Mo
selon la qualité choisie), puis le met en cache navigateur quand celui-ci l'autorise.

## Structure

```
├── index.html   # Interface (français)
├── styles.css   # Styles, thème clair/sombre
├── app.js       # Logique : fichiers, décodage audio 16 kHz, moteur
└── worker.js    # Worker de transcription (Whisper via Transformers.js)
```

## Notes techniques

- L'audio est décodé en PCM mono 16 kHz (`AudioContext` + `OfflineAudioContext`),
  le format attendu par Whisper.
- Sur WebGPU, l'encodeur est chargé en `fp32` et le décodeur en `q4` (l'encodeur de
  Whisper est sensible à la quantisation) ; en WASM, tout est en `q8`.
- Les messages postés à un worker module pendant son évaluation asynchrone peuvent
  être perdus : le worker envoie donc un signal « boot » avant de recevoir des requêtes.

## Licence

Code fourni tel quel, sans garantie. Modèles et bibliothèques soumis à leurs licences
respectives (MIT pour Whisper et Transformers.js).
