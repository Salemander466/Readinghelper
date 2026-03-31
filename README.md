# Reading Helper — PDF Read Aloud with Follow-Along Highlighting

A complete local web app for:
- uploading a PDF,
- extracting selectable text in-browser (PDF.js),
- reading it aloud through a backend TTS endpoint compatible with `mistralai/Voxtral-4B-TTS-2603`,
- highlighting words/sentences live during playback.

## Tech stack
- **Frontend:** HTML, CSS, vanilla JS
- **PDF extraction + preview:** PDF.js (in browser)
- **Backend:** FastAPI (Python)
- **TTS integration:** backend calls local `/audio/speech` compatible endpoint

---

## File tree

```text
Readinghelper/
├── .env.example
├── .gitkeep
├── README.md
├── requirements.txt
├── run.py
├── backend/
│   ├── __init__.py
│   ├── alignment.py
│   ├── app.py
│   ├── config.py
│   ├── models.py
│   └── tts_client.py
├── frontend/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── static/
├── temp_audio/
└── uploads/
```

> Runtime temp paths are configured to `./tmp/*` by default (see `.env.example`).

---

## Features implemented

### Core flow
1. Upload PDF
2. Frontend sends file to backend `POST /upload-pdf`
3. Frontend uses PDF.js to extract text page-by-page
4. Frontend builds normalized structure:
   - pages
   - paragraphs
   - sentences
   - words
5. Frontend renders every word as a `<span class="word">` with stable data attributes:
   - `data-page`
   - `data-paragraph`
   - `data-sentence`
   - `data-word`
   - plus `data-global-word`
6. Frontend sends structured extraction summary to backend `POST /extract-text`
7. On Play, frontend chunks text by sentence boundaries and requests `POST /tts-chunk`
8. Backend caches audio chunks and returns reusable `/audio/{file}` URL
9. Frontend plays chunk and highlights words/sentences progressively
10. Next chunk is preloaded while current chunk plays

### Highlight sync modes
- **Mode A (implemented now): Estimated sync**
  - Uses generated chunk audio duration
  - Distributes timing by word length + punctuation pause weights
  - Supports pauses for commas, semicolons, periods, question marks, and paragraph boundaries

- **Mode B (alignment-ready interface):**
  - Backend exposes `get_word_timings(text, audio_file) -> [{word, start, end}]`
  - Currently returns `None`
  - If a true forced aligner is added later, frontend already prefers provided timings over estimates

### UI/UX
- Two-column desktop layout
  - Left: PDF page thumbnails + OCR notices
  - Right: reading pane with highlighted text
- Mobile responsive fallback
- Controls:
  - Upload
  - Play / Pause / Resume / Stop
  - Previous/Next sentence
  - Speed slider
  - Word highlight toggle
- Progress display:
  - chunk index
  - sentence index
  - word index
  - global progress bar
- Status labels:
  - extracting/generating/playing etc.
- Extras:
  - dark mode toggle
  - click sentence/word to jump and play from there
  - keyboard shortcuts (Space, ←, →)
  - export extracted text

---

## Backend API

- `GET /health`
- `POST /upload-pdf`
- `POST /extract-text`
- `POST /tts-chunk`
- `GET /audio/{filename}`

### `POST /tts-chunk`
Request:
```json
{
  "text": "Chunk text...",
  "chunk_id": "chunk-3",
  "speed": 1.0,
  "voice": "alloy",
  "file_id": "..."
}
```

Response:
```json
{
  "chunk_id": "chunk-3",
  "cached": true,
  "audio_url": "/audio/xxxx.mp3",
  "mime_type": "audio/mp3",
  "model": "mistralai/Voxtral-4B-TTS-2603",
  "word_timings": null
}
```

---

## Local setup

## 1) Python backend

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python run.py
```

Open app at: `http://localhost:8000`

---

## 2) Run a Voxtral-compatible local TTS server

The app expects an endpoint:
- Base URL: `TTS_SERVER_BASE_URL` (default `http://127.0.0.1:8001`)
- Route: `TTS_SPEECH_ROUTE` (default `/audio/speech`)
- OpenAI-style payload fields: `model`, `input`, `voice`, `response_format`, `speed`

### Recommended serving path
Use the Voxtral model card’s recommended local serving path that exposes `/audio/speech` compatibility (OpenAI-style speech API semantics). Configure the app env vars to match that server.

Example environment linkage:
```env
TTS_SERVER_BASE_URL=http://127.0.0.1:8001
TTS_SPEECH_ROUTE=/audio/speech
TTS_MODEL=mistralai/Voxtral-4B-TTS-2603
TTS_VOICE=alloy
TTS_AUDIO_FORMAT=mp3
```

If the TTS server is down/unavailable, the app shows a clear status/error and does not crash.

---

## Configurable settings
All settings are centralized in `backend/config.py` and `.env`:
- TTS server URL / route / model / voice / timeout
- chunk size (`MAX_CHUNK_CHARS`)
- speed range defaults
- pause weights
- temp/upload/cache directories

---

## Limitations & notes

- **PDF.js extraction quality depends on PDF text layer quality.**
  Image-only/scanned pages without embedded text show a notice that OCR is required.
- **Word timing is currently estimated**, not true phoneme-level alignment.
  This is good enough for smooth read-along UX but can drift slightly on difficult punctuation or atypical speech rate.
- **Alignment-ready architecture is included.**
  Add a forced aligner in `backend/alignment.py` and return timings to upgrade precision without major frontend rewrite.

---

## Short technical note

- **PDF.js** is used in the browser for PDF rendering and text extraction.
- **Voxtral TTS** is served through a backend endpoint (`/tts-chunk`) that forwards to a local `/audio/speech` compatible inference service.
- **Exact word-level sync is approximated** right now using duration-based estimation, unless a separate forced-alignment module is plugged in later.

