const state = {
  fileId: null,
  filename: null,
  pages: [],
  allSentences: [],
  allWords: [],
  chunks: [],
  chunkMapBySentenceIndex: new Map(),
  playback: {
    isPlaying: false,
    currentChunkIndex: 0,
    currentSentenceIndex: 0,
    currentWordGlobalIndex: 0,
    currentAudio: null,
    timer: null,
    startedAt: 0,
    pausedAt: 0,
  },
  settings: {
    maxChunkChars: 900,
    speed: 1.0,
    wordHighlightEnabled: true,
    pauseWeights: {
      comma: 0.10,
      semicolon: 0.16,
      period: 0.24,
      question: 0.24,
      paragraph: 0.35,
    },
  },
  preloadedChunks: new Map(),
};

const els = {
  pdfInput: document.getElementById('pdfInput'),
  playBtn: document.getElementById('playBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  stopBtn: document.getElementById('stopBtn'),
  prevSentenceBtn: document.getElementById('prevSentenceBtn'),
  nextSentenceBtn: document.getElementById('nextSentenceBtn'),
  speedRange: document.getElementById('speedRange'),
  speedValue: document.getElementById('speedValue'),
  readingPane: document.getElementById('readingPane'),
  statusLabel: document.getElementById('statusLabel'),
  chunkProgress: document.getElementById('chunkProgress'),
  sentenceProgress: document.getElementById('sentenceProgress'),
  wordProgress: document.getElementById('wordProgress'),
  globalProgressBar: document.getElementById('globalProgressBar'),
  pdfPages: document.getElementById('pdfPages'),
  pdfNotices: document.getElementById('pdfNotices'),
  darkModeBtn: document.getElementById('darkModeBtn'),
  exportTextBtn: document.getElementById('exportTextBtn'),
  wordHighlightToggle: document.getElementById('wordHighlightToggle'),
};

const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

function setStatus(msg) { els.statusLabel.textContent = msg; }

function splitSentences(raw) {
  return raw
    .replace(/\s+/g, ' ')
    .match(/[^.!?;]+[.!?;]?/g)?.map((s) => s.trim()).filter(Boolean) || [];
}

function tokenizeWords(sentenceText) {
  return sentenceText.match(/\b[\w'’-]+\b|[.,!?;:()"-]/g) || [];
}

function normalizePageItems(items, pageNumber) {
  const lines = items.map((it) => ({ text: it.str || '', y: Math.round(it.transform?.[5] || 0) }));
  const grouped = [];
  for (const line of lines) {
    if (!line.text.trim()) continue;
    const prev = grouped[grouped.length - 1];
    if (!prev || Math.abs(prev.y - line.y) > 8) {
      grouped.push({ y: line.y, text: line.text.trim() });
    } else {
      prev.text += ' ' + line.text.trim();
    }
  }

  const paragraphs = [];
  let paragraphIndex = 0;
  grouped.forEach((line, i) => {
    const newParagraph = i === 0 || (grouped[i - 1] && Math.abs(grouped[i - 1].y - line.y) > 18);
    if (newParagraph) {
      paragraphs.push({ page: pageNumber, paragraph: paragraphIndex++, text: line.text, sentences: [] });
    } else {
      paragraphs[paragraphs.length - 1].text += ' ' + line.text;
    }
  });

  return paragraphs.map((p) => {
    const sentences = splitSentences(p.text).map((sentenceText, sentenceIndex) => {
      const words = tokenizeWords(sentenceText).map((word, wordIndex) => ({ word, wordIndex }));
      return { sentence: sentenceIndex, text: sentenceText, words };
    });
    return { ...p, sentences };
  });
}

function buildChunkPlan() {
  const chunks = [];
  let chunk = { chunkId: '', text: '', sentenceRefs: [] };

  state.allSentences.forEach((sent, idx) => {
    const candidate = (chunk.text + ' ' + sent.text).trim();
    if (candidate.length > state.settings.maxChunkChars && chunk.sentenceRefs.length > 0) {
      chunk.chunkId = `chunk-${chunks.length}`;
      chunks.push(chunk);
      chunk = { chunkId: '', text: sent.text, sentenceRefs: [idx] };
    } else {
      chunk.text = candidate;
      chunk.sentenceRefs.push(idx);
    }
  });

  if (chunk.sentenceRefs.length) {
    chunk.chunkId = `chunk-${chunks.length}`;
    chunks.push(chunk);
  }

  state.chunkMapBySentenceIndex.clear();
  chunks.forEach((c, chunkIndex) => c.sentenceRefs.forEach((sidx) => state.chunkMapBySentenceIndex.set(sidx, chunkIndex)));
  state.chunks = chunks;
}

function renderText() {
  els.readingPane.innerHTML = '';
  state.allWords = [];
  state.allSentences = [];

  state.pages.forEach((page) => {
    page.paragraphs.forEach((para) => {
      const pEl = document.createElement('p');
      pEl.className = 'paragraph';
      pEl.dataset.page = page.page;
      pEl.dataset.paragraph = para.paragraph;

      para.sentences.forEach((sent) => {
        const globalSentenceIndex = state.allSentences.length;
        const sEl = document.createElement('span');
        sEl.className = 'sentence';
        sEl.dataset.page = page.page;
        sEl.dataset.paragraph = para.paragraph;
        sEl.dataset.sentence = sent.sentence;
        sEl.dataset.globalSentence = globalSentenceIndex;

        const sentRecord = {
          globalSentenceIndex,
          page: page.page,
          paragraph: para.paragraph,
          sentence: sent.sentence,
          text: sent.text,
          wordIds: [],
        };

        sent.words.forEach((w, wordIndexInSentence) => {
          const globalWordIndex = state.allWords.length;
          const wEl = document.createElement('span');
          wEl.className = 'word';
          wEl.textContent = w.word + ' ';
          wEl.dataset.page = page.page;
          wEl.dataset.paragraph = para.paragraph;
          wEl.dataset.sentence = sent.sentence;
          wEl.dataset.word = w.wordIndex;
          wEl.dataset.globalWord = globalWordIndex;

          wEl.addEventListener('click', () => startFromWord(globalWordIndex));
          sEl.addEventListener('click', () => jumpToSentence(globalSentenceIndex, true));

          state.allWords.push({
            id: `w-${page.page}-${para.paragraph}-${sent.sentence}-${wordIndexInSentence}`,
            text: w.word,
            globalWordIndex,
            globalSentenceIndex,
            page: page.page,
            paragraph: para.paragraph,
            sentence: sent.sentence,
            word: w.wordIndex,
            element: wEl,
          });
          sentRecord.wordIds.push(globalWordIndex);
          sEl.appendChild(wEl);
        });

        state.allSentences.push(sentRecord);
        pEl.appendChild(sEl);
      });
      els.readingPane.appendChild(pEl);
    });
  });
}

function clearHighlights() {
  document.querySelectorAll('.word.current-word').forEach((el) => el.classList.remove('current-word'));
  document.querySelectorAll('.word.read').forEach((el) => el.classList.remove('read'));
  document.querySelectorAll('.sentence.current-sentence').forEach((el) => el.classList.remove('current-sentence'));
}

function markPosition(wordGlobalIndex) {
  if (wordGlobalIndex < 0 || wordGlobalIndex >= state.allWords.length) return;
  const target = state.allWords[wordGlobalIndex];

  state.allWords.forEach((w, idx) => {
    if (idx < wordGlobalIndex) w.element.classList.add('read');
    else w.element.classList.remove('read');
    if (idx !== wordGlobalIndex) w.element.classList.remove('current-word');
  });

  if (state.settings.wordHighlightEnabled) {
    target.element.classList.add('current-word');
  }

  document.querySelectorAll('.sentence.current-sentence').forEach((el) => el.classList.remove('current-sentence'));
  const sentenceEl = document.querySelector(`[data-global-sentence="${target.globalSentenceIndex}"]`);
  if (sentenceEl) {
    sentenceEl.classList.add('current-sentence');
    sentenceEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    target.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  state.playback.currentWordGlobalIndex = wordGlobalIndex;
  state.playback.currentSentenceIndex = target.globalSentenceIndex;
  updateProgress();
}

function updateProgress() {
  els.chunkProgress.textContent = `${state.playback.currentChunkIndex + 1} / ${state.chunks.length || 0}`;
  els.sentenceProgress.textContent = `${state.playback.currentSentenceIndex + 1} / ${state.allSentences.length || 0}`;
  els.wordProgress.textContent = `${state.playback.currentWordGlobalIndex + 1} / ${state.allWords.length || 0}`;

  const pct = state.allWords.length
    ? Math.min(100, (state.playback.currentWordGlobalIndex + 1) * 100 / state.allWords.length)
    : 0;
  els.globalProgressBar.style.width = `${pct}%`;
}

function punctuationPause(word) {
  if (/,/.test(word)) return state.settings.pauseWeights.comma;
  if (/;/.test(word)) return state.settings.pauseWeights.semicolon;
  if (/[.!]/.test(word)) return state.settings.pauseWeights.period;
  if (/\?/.test(word)) return state.settings.pauseWeights.question;
  return 0;
}

function estimateWordTimings(chunk, audioDuration) {
  const sentenceRefs = chunk.sentenceRefs;
  const words = [];
  sentenceRefs.forEach((sidx, localSentenceOrder) => {
    const sentence = state.allSentences[sidx];
    sentence.wordIds.forEach((gid) => {
      words.push(state.allWords[gid]);
    });
    if (localSentenceOrder < sentenceRefs.length - 1) {
      words.push({ text: '¶', pseudoPause: state.settings.pauseWeights.paragraph, isPause: true });
    }
  });

  const weights = words.map((w) => {
    if (w.isPause) return w.pseudoPause;
    const base = Math.max(1, (w.text || '').replace(/[^\w]/g, '').length);
    return base / 9 + punctuationPause(w.text || '');
  });

  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const scale = audioDuration / total;

  let cursor = 0;
  const output = [];
  words.forEach((w, i) => {
    const dur = weights[i] * scale;
    const start = cursor;
    const end = cursor + dur;
    if (!w.isPause) {
      output.push({
        globalWordIndex: w.globalWordIndex,
        word: w.text,
        start,
        end,
      });
    }
    cursor = end;
  });

  return output;
}

async function requestChunkAudio(chunkIndex) {
  const chunk = state.chunks[chunkIndex];
  if (!chunk) return null;
  if (state.preloadedChunks.has(chunkIndex)) return state.preloadedChunks.get(chunkIndex);

  setStatus(`Generating audio for chunk ${chunkIndex + 1} of ${state.chunks.length}...`);
  const resp = await fetch('/tts-chunk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: chunk.text,
      chunk_id: chunk.chunkId,
      speed: state.settings.speed,
      file_id: state.fileId,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: 'Unknown TTS error' }));
    throw new Error(err.detail || 'Failed to create audio chunk');
  }

  const payload = await resp.json();
  const preload = {
    chunkIndex,
    chunk,
    audioUrl: payload.audio_url,
    providedWordTimings: payload.word_timings,
  };

  state.preloadedChunks.set(chunkIndex, preload);
  return preload;
}

async function preloadNextChunk(chunkIndex) {
  const next = chunkIndex + 1;
  if (next < state.chunks.length) {
    requestChunkAudio(next).catch(() => {});
  }
}

function stopPlayback() {
  const pb = state.playback;
  pb.isPlaying = false;
  clearInterval(pb.timer);
  pb.timer = null;
  if (pb.currentAudio) {
    pb.currentAudio.pause();
    pb.currentAudio.currentTime = 0;
    pb.currentAudio = null;
  }
  setStatus('Stopped.');
}

function scheduleHighlight(timings, audio, onDone) {
  clearInterval(state.playback.timer);
  state.playback.startedAt = performance.now();
  state.playback.timer = setInterval(() => {
    const now = audio.currentTime;
    let i = timings.findIndex((t) => now >= t.start && now < t.end);
    if (i === -1 && now >= audio.duration && timings.length) i = timings.length - 1;
    if (i >= 0) markPosition(timings[i].globalWordIndex);
  }, 40);

  audio.onended = () => {
    clearInterval(state.playback.timer);
    onDone();
  };
}

async function playChunk(chunkIndex) {
  if (chunkIndex >= state.chunks.length) {
    setStatus('Finished document.');
    state.playback.isPlaying = false;
    return;
  }

  state.playback.currentChunkIndex = chunkIndex;
  const preload = await requestChunkAudio(chunkIndex);
  preloadNextChunk(chunkIndex);

  const audio = new Audio(preload.audioUrl);
  audio.playbackRate = state.settings.speed;
  state.playback.currentAudio = audio;

  await new Promise((resolve) => {
    audio.onloadedmetadata = resolve;
    audio.onerror = resolve;
  });

  let timings = preload.providedWordTimings;
  if (!timings || !timings.length) {
    timings = estimateWordTimings(preload.chunk, audio.duration || 1);
  }

  if (timings.length) {
    const first = timings[0].globalWordIndex;
    markPosition(first);
  }

  setStatus(`Playing chunk ${chunkIndex + 1} of ${state.chunks.length}...`);

  await audio.play().catch((err) => {
    setStatus(`Playback failed: ${err.message}`);
  });

  scheduleHighlight(timings, audio, () => playChunk(chunkIndex + 1));
}

async function startPlayback(startSentence = 0) {
  if (!state.chunks.length) {
    setStatus('No content to play. Upload and extract text first.');
    return;
  }
  state.preloadedChunks.clear();
  state.playback.isPlaying = true;
  const chunkIndex = state.chunkMapBySentenceIndex.get(startSentence) || 0;
  await playChunk(chunkIndex);
}

function jumpToSentence(sentenceIndex, autoplay = false) {
  const sent = state.allSentences[sentenceIndex];
  if (!sent) return;

  const firstWord = sent.wordIds[0];
  if (typeof firstWord === 'number') {
    markPosition(firstWord);
    if (autoplay) {
      stopPlayback();
      startPlayback(sentenceIndex);
    }
  }
}

function startFromWord(wordIndex) {
  const word = state.allWords[wordIndex];
  if (!word) return;
  stopPlayback();
  jumpToSentence(word.globalSentenceIndex, true);
}

async function extractWithPdfJs(file) {
  setStatus('Extracting text...');
  els.pdfPages.innerHTML = '';
  els.pdfNotices.innerHTML = '';

  const data = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;

  state.pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    if (!content.items.length) {
      const notice = document.createElement('div');
      notice.className = 'notice';
      notice.textContent = `Page ${p}: no selectable text found. OCR would be required.`;
      els.pdfNotices.appendChild(notice);
    }

    const viewport = page.getViewport({ scale: 0.25 });
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.className = 'pdf-thumb';
    await page.render({ canvasContext: ctx, viewport }).promise;
    els.pdfPages.appendChild(canvas);

    const paragraphs = normalizePageItems(content.items, p);
    state.pages.push({ page: p, paragraphs });
  }

  renderText();
  buildChunkPlan();
  updateProgress();

  await fetch('/extract-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_id: state.fileId,
      filename: state.filename,
      pages: state.pages,
      metadata: { source: 'pdfjs-browser' },
    }),
  }).catch(() => {});

  setStatus(`Extracted ${state.allWords.length} words from ${state.pages.length} pages.`);
}

async function uploadPdf(file) {
  const formData = new FormData();
  formData.append('file', file);
  const resp = await fetch('/upload-pdf', { method: 'POST', body: formData });
  if (!resp.ok) throw new Error('Upload failed');
  const data = await resp.json();
  state.fileId = data.file_id;
  state.filename = data.filename;
}

function exportText() {
  const text = state.allSentences.map((s) => s.text).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.filename || 'extracted').replace(/\.pdf$/i, '')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function bindEvents() {
  els.pdfInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    clearHighlights();
    try {
      setStatus('Uploading PDF...');
      await uploadPdf(file);
      await extractWithPdfJs(file);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  });

  els.playBtn.addEventListener('click', () => startPlayback(state.playback.currentSentenceIndex));
  els.pauseBtn.addEventListener('click', () => {
    const audio = state.playback.currentAudio;
    if (audio) {
      audio.pause();
      setStatus('Paused.');
    }
  });
  els.resumeBtn.addEventListener('click', async () => {
    const audio = state.playback.currentAudio;
    if (audio) {
      await audio.play().catch(() => {});
      setStatus(`Playing chunk ${state.playback.currentChunkIndex + 1} of ${state.chunks.length}...`);
    }
  });
  els.stopBtn.addEventListener('click', stopPlayback);

  els.prevSentenceBtn.addEventListener('click', () => {
    const prev = Math.max(0, state.playback.currentSentenceIndex - 1);
    jumpToSentence(prev, false);
  });
  els.nextSentenceBtn.addEventListener('click', () => {
    const next = Math.min(state.allSentences.length - 1, state.playback.currentSentenceIndex + 1);
    jumpToSentence(next, false);
  });

  els.speedRange.addEventListener('input', (e) => {
    const speed = Number(e.target.value);
    state.settings.speed = speed;
    els.speedValue.textContent = `${speed.toFixed(2)}x`;
    if (state.playback.currentAudio) {
      state.playback.currentAudio.playbackRate = speed;
    }
  });

  els.wordHighlightToggle.addEventListener('change', (e) => {
    state.settings.wordHighlightEnabled = e.target.checked;
    if (!e.target.checked) {
      document.querySelectorAll('.word.current-word').forEach((el) => el.classList.remove('current-word'));
    }
  });

  els.darkModeBtn.addEventListener('click', () => document.body.classList.toggle('dark'));
  els.exportTextBtn.addEventListener('click', exportText);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.playback.currentAudio?.paused) els.resumeBtn.click();
      else els.pauseBtn.click();
    } else if (e.code === 'ArrowRight') {
      els.nextSentenceBtn.click();
    } else if (e.code === 'ArrowLeft') {
      els.prevSentenceBtn.click();
    }
  });
}

bindEvents();
