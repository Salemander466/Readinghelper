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
  },
  settings: {
    maxChunkChars: 900,
    speed: 1.0,
    wordHighlightEnabled: true,
    pauseWeights: {
      comma: 0.1,
      semicolon: 0.16,
      period: 0.24,
      question: 0.24,
      paragraph: 0.35,
    },
  },
  preloadedChunks: new Map(),
};

const els = {
  pdfInput: document.getElementById("pdfInput"),
  playBtn: document.getElementById("playBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  stopBtn: document.getElementById("stopBtn"),
  prevSentenceBtn: document.getElementById("prevSentenceBtn"),
  nextSentenceBtn: document.getElementById("nextSentenceBtn"),
  speedRange: document.getElementById("speedRange"),
  speedValue: document.getElementById("speedValue"),
  statusLabel: document.getElementById("statusLabel"),
  chunkProgress: document.getElementById("chunkProgress"),
  sentenceProgress: document.getElementById("sentenceProgress"),
  wordProgress: document.getElementById("wordProgress"),
  globalProgressBar: document.getElementById("globalProgressBar"),
  pdfPages: document.getElementById("pdfPages"),
  pdfNotices: document.getElementById("pdfNotices"),
  darkModeBtn: document.getElementById("darkModeBtn"),
  exportTextBtn: document.getElementById("exportTextBtn"),
  wordHighlightToggle: document.getElementById("wordHighlightToggle"),
  currentSentenceText: document.getElementById("currentSentenceText"),
  currentLocationLabel: document.getElementById("currentLocationLabel"),
  documentTitle: document.getElementById("documentTitle"),
  debugLog: document.getElementById("debugLog"),
};

const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

function setStatus(message) {
  els.statusLabel.textContent = message;
}

function debugLog(message, details) {
  const timestamp = new Date().toLocaleTimeString();
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  const line = `[${timestamp}] ${message}${suffix}`;
  console.log(line);

  if (!els.debugLog) return;

  const existing = els.debugLog.textContent === "Waiting for activity..." ? [] : els.debugLog.textContent.split("\n");
  const next = [...existing.slice(-39), line];
  els.debugLog.textContent = next.join("\n");
  els.debugLog.scrollTop = els.debugLog.scrollHeight;
}

function splitSentences(raw) {
  return raw
    .replace(/\s+/g, " ")
    .match(/[^.!?;]+[.!?;]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
}

function tokenizeWords(text) {
  return text.match(/\b[\w'’-]+\b|[.,!?;:()"-]/g) || [];
}

function normalizeToken(token) {
  return token.toLowerCase().replace(/[’]/g, "'").trim();
}

function normalizePageItems(items, pageNumber) {
  const lines = items.map((item) => ({
    text: item.str || "",
    y: Math.round(item.transform?.[5] || 0),
  }));

  const grouped = [];
  for (const line of lines) {
    if (!line.text.trim()) continue;
    const previous = grouped[grouped.length - 1];
    if (!previous || Math.abs(previous.y - line.y) > 8) {
      grouped.push({ y: line.y, text: line.text.trim() });
    } else {
      previous.text += ` ${line.text.trim()}`;
    }
  }

  const paragraphs = [];
  let paragraphIndex = 0;
  grouped.forEach((line, index) => {
    const previous = grouped[index - 1];
    const startsParagraph = index === 0 || Math.abs((previous?.y || 0) - line.y) > 18;
    if (startsParagraph) {
      paragraphs.push({ page: pageNumber, paragraph: paragraphIndex++, text: line.text, sentences: [] });
    } else {
      paragraphs[paragraphs.length - 1].text += ` ${line.text}`;
    }
  });

  return paragraphs.map((paragraph) => {
    const sentences = splitSentences(paragraph.text).map((sentenceText, sentenceIndex) => ({
      sentence: sentenceIndex,
      text: sentenceText,
      words: tokenizeWords(sentenceText).map((word, wordIndex) => ({ word, wordIndex })),
    }));
    return { ...paragraph, sentences };
  });
}

function chooseScale() {
  return window.innerWidth < 900 ? 1.05 : 1.45;
}

function createWordOverlays(items, viewport, layer, pageNumber) {
  const tokens = [];

  items.forEach((item) => {
    const raw = item.str || "";
    const rawTokens = tokenizeWords(raw);
    if (!rawTokens.length || !item.width || !item.height) return;

    const [left, bottom] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const width = item.width * viewport.scale;
    const height = Math.max(8, item.height * viewport.scale);
    const top = bottom - height;

    let cursor = 0;
    for (const tokenText of rawTokens) {
      let startIndex = raw.indexOf(tokenText, cursor);
      if (startIndex === -1) {
        startIndex = cursor;
      }
      const endIndex = startIndex + tokenText.length;
      const relativeLeft = raw.length ? startIndex / raw.length : 0;
      const relativeWidth = raw.length ? Math.max(tokenText.length / raw.length, 0.03) : 0.08;

      const box = document.createElement("button");
      box.type = "button";
      box.className = "word-box";
      box.style.left = `${left + width * relativeLeft}px`;
      box.style.top = `${top}px`;
      box.style.width = `${Math.max(width * relativeWidth, 6)}px`;
      box.style.height = `${height}px`;
      box.dataset.page = pageNumber;
      box.setAttribute("aria-label", `Word on page ${pageNumber}: ${tokenText}`);
      layer.appendChild(box);

      tokens.push({
        text: tokenText,
        page: pageNumber,
        element: box,
      });

      cursor = endIndex;
    }
  });

  return tokens;
}

async function renderPdfPage(page, pageNumber, items) {
  const viewport = page.getViewport({ scale: chooseScale() });
  const pageCard = document.createElement("article");
  pageCard.className = "pdf-page-card";
  pageCard.dataset.page = pageNumber;

  const pageMeta = document.createElement("div");
  pageMeta.className = "page-meta";
  pageMeta.innerHTML = `<strong>Page ${pageNumber}</strong><span>${items.length ? "Text detected" : "Needs OCR"}</span>`;

  const shell = document.createElement("div");
  shell.className = "page-shell";
  shell.style.width = `${viewport.width}px`;
  shell.style.height = `${viewport.height}px`;

  const canvas = document.createElement("canvas");
  canvas.className = "pdf-canvas";
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const highlightLayer = document.createElement("div");
  highlightLayer.className = "highlight-layer";

  shell.appendChild(canvas);
  shell.appendChild(highlightLayer);
  pageCard.appendChild(pageMeta);
  pageCard.appendChild(shell);
  els.pdfPages.appendChild(pageCard);

  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;

  return {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    renderTokens: createWordOverlays(items, viewport, highlightLayer, pageNumber),
    shell,
  };
}

function buildDocumentModel() {
  state.allSentences = [];
  state.allWords = [];

  state.pages.forEach((page) => {
    page.paragraphs.forEach((paragraph) => {
      paragraph.sentences.forEach((sentence) => {
        const globalSentenceIndex = state.allSentences.length;
        const sentenceRecord = {
          globalSentenceIndex,
          page: page.page,
          paragraph: paragraph.paragraph,
          sentence: sentence.sentence,
          text: sentence.text,
          wordIds: [],
        };

        sentence.words.forEach((wordData) => {
          const globalWordIndex = state.allWords.length;
          state.allWords.push({
            text: wordData.word,
            globalWordIndex,
            globalSentenceIndex,
            page: page.page,
            paragraph: paragraph.paragraph,
            sentence: sentence.sentence,
            word: wordData.wordIndex,
            element: null,
          });
          sentenceRecord.wordIds.push(globalWordIndex);
        });

        state.allSentences.push(sentenceRecord);
      });
    });
  });
}

function assignWordBoxes() {
  state.pages.forEach((page) => {
    const pageWords = state.allWords.filter((word) => word.page === page.page);
    const tokens = page.renderTokens || [];
    let tokenCursor = 0;

    for (const word of pageWords) {
      const target = normalizeToken(word.text);
      let matchedToken = null;

      for (let lookAhead = tokenCursor; lookAhead < Math.min(tokens.length, tokenCursor + 8); lookAhead += 1) {
        if (normalizeToken(tokens[lookAhead].text) === target) {
          matchedToken = tokens[lookAhead];
          tokenCursor = lookAhead + 1;
          break;
        }
      }

      if (!matchedToken && tokens[tokenCursor]) {
        matchedToken = tokens[tokenCursor];
        tokenCursor += 1;
      }

      if (!matchedToken) continue;

      word.element = matchedToken.element;
      matchedToken.element.dataset.globalWord = word.globalWordIndex;
      matchedToken.element.dataset.globalSentence = word.globalSentenceIndex;
      matchedToken.element.addEventListener("click", () => startFromWord(word.globalWordIndex));
    }
  });
}

function buildChunkPlan() {
  const chunks = [];
  let chunk = { chunkId: "", text: "", sentenceRefs: [] };

  state.allSentences.forEach((sentence, index) => {
    const candidate = `${chunk.text} ${sentence.text}`.trim();
    if (candidate.length > state.settings.maxChunkChars && chunk.sentenceRefs.length > 0) {
      chunk.chunkId = `chunk-${chunks.length}`;
      chunks.push(chunk);
      chunk = { chunkId: "", text: sentence.text, sentenceRefs: [index] };
    } else {
      chunk.text = candidate;
      chunk.sentenceRefs.push(index);
    }
  });

  if (chunk.sentenceRefs.length) {
    chunk.chunkId = `chunk-${chunks.length}`;
    chunks.push(chunk);
  }

  state.chunkMapBySentenceIndex.clear();
  chunks.forEach((item, chunkIndex) => {
    item.sentenceRefs.forEach((sentenceIndex) => state.chunkMapBySentenceIndex.set(sentenceIndex, chunkIndex));
  });
  state.chunks = chunks;
  debugLog("Built chunk plan", {
    chunks: chunks.length,
    sentences: state.allSentences.length,
    words: state.allWords.length,
  });
}

function clearHighlights() {
  document.querySelectorAll(".word-box.read").forEach((element) => element.classList.remove("read"));
  document.querySelectorAll(".word-box.current-word").forEach((element) => element.classList.remove("current-word"));
  document.querySelectorAll(".word-box.sentence-active").forEach((element) => element.classList.remove("sentence-active"));
}

function updateCurrentSentencePanel(sentenceIndex) {
  const sentence = state.allSentences[sentenceIndex];
  if (!sentence) {
    els.currentLocationLabel.textContent = "Page -, sentence -";
    els.currentSentenceText.textContent = "The active sentence will appear here once playback begins.";
    return;
  }

  els.currentLocationLabel.textContent = `Page ${sentence.page}, sentence ${sentenceIndex + 1}`;
  els.currentSentenceText.textContent = sentence.text;
}

function markPosition(wordGlobalIndex) {
  if (wordGlobalIndex < 0 || wordGlobalIndex >= state.allWords.length) return;

  const target = state.allWords[wordGlobalIndex];
  const currentSentence = state.allSentences[target.globalSentenceIndex];
  clearHighlights();

  state.allWords.forEach((word, index) => {
    if (!word.element) return;
    if (index < wordGlobalIndex) {
      word.element.classList.add("read");
    }
  });

  currentSentence?.wordIds.forEach((wordIndex) => {
    state.allWords[wordIndex]?.element?.classList.add("sentence-active");
  });

  if (state.settings.wordHighlightEnabled) {
    target.element?.classList.add("current-word");
  }

  const scrollTarget = target.element?.closest(".pdf-page-card");
  scrollTarget?.scrollIntoView({ behavior: "smooth", block: "center" });

  state.playback.currentWordGlobalIndex = wordGlobalIndex;
  state.playback.currentSentenceIndex = target.globalSentenceIndex;
  updateCurrentSentencePanel(target.globalSentenceIndex);
  updateProgress();
}

function updateProgress() {
  els.chunkProgress.textContent = `${Math.min(state.playback.currentChunkIndex + 1, state.chunks.length || 0)} / ${state.chunks.length || 0}`;
  els.sentenceProgress.textContent = `${Math.min(state.playback.currentSentenceIndex + 1, state.allSentences.length || 0)} / ${state.allSentences.length || 0}`;
  els.wordProgress.textContent = `${Math.min(state.playback.currentWordGlobalIndex + 1, state.allWords.length || 0)} / ${state.allWords.length || 0}`;

  const percentage = state.allWords.length
    ? Math.min(100, ((state.playback.currentWordGlobalIndex + 1) * 100) / state.allWords.length)
    : 0;
  els.globalProgressBar.style.width = `${percentage}%`;
}

function punctuationPause(word) {
  if (/,/.test(word)) return state.settings.pauseWeights.comma;
  if (/;/.test(word)) return state.settings.pauseWeights.semicolon;
  if (/[.!]/.test(word)) return state.settings.pauseWeights.period;
  if (/\?/.test(word)) return state.settings.pauseWeights.question;
  return 0;
}

function estimateWordTimings(chunk, audioDuration) {
  const words = [];
  chunk.sentenceRefs.forEach((sentenceIndex, localSentenceOrder) => {
    const sentence = state.allSentences[sentenceIndex];
    sentence.wordIds.forEach((globalWordIndex) => {
      words.push(state.allWords[globalWordIndex]);
    });

    if (localSentenceOrder < chunk.sentenceRefs.length - 1) {
      words.push({ text: "¶", pseudoPause: state.settings.pauseWeights.paragraph, isPause: true });
    }
  });

  const weights = words.map((word) => {
    if (word.isPause) return word.pseudoPause;
    const base = Math.max(1, (word.text || "").replace(/[^\w]/g, "").length);
    return base / 9 + punctuationPause(word.text || "");
  });

  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const scale = audioDuration / total;
  let cursor = 0;

  return words.flatMap((word, index) => {
    const duration = weights[index] * scale;
    const start = cursor;
    const end = cursor + duration;
    cursor = end;

    if (word.isPause) return [];
    return [{
      globalWordIndex: word.globalWordIndex,
      word: word.text,
      start,
      end,
    }];
  });
}

async function requestChunkAudio(chunkIndex) {
  const chunk = state.chunks[chunkIndex];
  if (!chunk) return null;
  if (state.preloadedChunks.has(chunkIndex)) return state.preloadedChunks.get(chunkIndex);

  debugLog("Requesting chunk audio", {
    chunkIndex,
    chunkId: chunk.chunkId,
    textLength: chunk.text.length,
  });
  setStatus(`Generating audio for chunk ${chunkIndex + 1} of ${state.chunks.length}...`);
  const response = await fetch("/tts-chunk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: chunk.text,
      chunk_id: chunk.chunkId,
      speed: state.settings.speed,
      file_id: state.fileId,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Unknown TTS error" }));
    debugLog("Chunk audio request failed", {
      chunkIndex,
      status: response.status,
      detail: error.detail || "unknown",
    });
    throw new Error(error.detail || "Failed to create audio chunk");
  }

  const payload = await response.json();
  debugLog("Chunk audio response received", {
    chunkIndex,
    audioUrl: payload.audio_url,
    cached: payload.cached,
    timings: payload.word_timings?.length || 0,
  });
  const preload = {
    chunkIndex,
    chunk,
    audioUrl: payload.audio_url,
    providedWordTimings: payload.word_timings,
  };

  state.preloadedChunks.set(chunkIndex, preload);
  return preload;
}

function preloadNextChunk(chunkIndex) {
  const nextIndex = chunkIndex + 1;
  if (nextIndex < state.chunks.length) {
    requestChunkAudio(nextIndex).catch(() => {});
  }
}

function stopPlayback() {
  debugLog("Stopping playback", {
    chunkIndex: state.playback.currentChunkIndex,
    sentenceIndex: state.playback.currentSentenceIndex,
    wordIndex: state.playback.currentWordGlobalIndex,
  });
  state.playback.isPlaying = false;
  clearInterval(state.playback.timer);
  state.playback.timer = null;

  if (state.playback.currentAudio) {
    state.playback.currentAudio.pause();
    state.playback.currentAudio.currentTime = 0;
    state.playback.currentAudio = null;
  }

  setStatus("Stopped.");
}

function scheduleHighlight(timings, audio, onDone) {
  debugLog("Scheduling highlights", {
    timings: timings.length,
    duration: audio.duration || 0,
  });
  clearInterval(state.playback.timer);
  state.playback.startedAt = performance.now();

  state.playback.timer = setInterval(() => {
    const now = audio.currentTime;
    let activeIndex = timings.findIndex((timing) => now >= timing.start && now < timing.end);
    if (activeIndex === -1 && now >= audio.duration && timings.length) {
      activeIndex = timings.length - 1;
    }
    if (activeIndex >= 0) {
      markPosition(timings[activeIndex].globalWordIndex);
    }
  }, 40);

  audio.onended = () => {
    debugLog("Audio ended", {
      chunkIndex: state.playback.currentChunkIndex,
    });
    clearInterval(state.playback.timer);
    onDone();
  };
}

async function playChunk(chunkIndex) {
  if (chunkIndex >= state.chunks.length) {
    state.playback.isPlaying = false;
    setStatus("Finished document.");
    return;
  }

  debugLog("Starting chunk playback", {
    chunkIndex,
    totalChunks: state.chunks.length,
  });
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
  debugLog("Audio metadata loaded", {
    chunkIndex,
    duration: audio.duration || 0,
  });

  let timings = preload.providedWordTimings;
  if (!timings || !timings.length) {
    timings = estimateWordTimings(preload.chunk, audio.duration || 1);
  }

  if (timings.length) {
    markPosition(timings[0].globalWordIndex);
  }

  setStatus(`Playing chunk ${chunkIndex + 1} of ${state.chunks.length}...`);
  await audio.play().catch((error) => {
    debugLog("Audio playback failed", {
      chunkIndex,
      error: error.message,
    });
    setStatus(`Playback failed: ${error.message}`);
  });
  debugLog("Audio playback started", {
    chunkIndex,
    rate: audio.playbackRate,
  });

  scheduleHighlight(timings, audio, () => playChunk(chunkIndex + 1));
}

async function startPlayback(startSentence = 0) {
  if (!state.chunks.length) {
    setStatus("No content to play. Upload and extract text first.");
    return;
  }

  debugLog("Playback requested", {
    startSentence,
    totalChunks: state.chunks.length,
    totalSentences: state.allSentences.length,
  });
  state.preloadedChunks.clear();
  state.playback.isPlaying = true;
  const chunkIndex = state.chunkMapBySentenceIndex.get(startSentence) || 0;
  debugLog("Resolved start chunk", {
    startSentence,
    chunkIndex,
  });
  await playChunk(chunkIndex);
}

function jumpToSentence(sentenceIndex, autoplay = false) {
  const sentence = state.allSentences[sentenceIndex];
  if (!sentence) return;

  const firstWord = sentence.wordIds[0];
  if (typeof firstWord !== "number") return;

  markPosition(firstWord);
  if (autoplay) {
    stopPlayback();
    startPlayback(sentenceIndex);
  }
}

function startFromWord(wordIndex) {
  const word = state.allWords[wordIndex];
  if (!word) return;
  stopPlayback();
  jumpToSentence(word.globalSentenceIndex, true);
}

async function extractWithPdfJs(file) {
  setStatus("Extracting text and page geometry...");
  els.pdfPages.innerHTML = "";
  els.pdfNotices.innerHTML = "";
  if (els.debugLog) {
    els.debugLog.textContent = "Waiting for activity...";
  }
  debugLog("Beginning PDF extraction", {
    filename: file.name,
    sizeBytes: file.size,
  });
  els.documentTitle.textContent = file.name;
  updateCurrentSentencePanel(-1);
  clearHighlights();

  const data = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  debugLog("PDF loaded", {
    pages: pdf.numPages,
  });

  state.pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const items = textContent.items || [];
    debugLog("Page extracted", {
      pageNumber,
      textItems: items.length,
    });

    if (!items.length) {
      const notice = document.createElement("div");
      notice.className = "notice";
      notice.textContent = `Page ${pageNumber}: no selectable text found. OCR would be required for accurate follow-along highlighting.`;
      els.pdfNotices.appendChild(notice);
    }

    const pageView = await renderPdfPage(page, pageNumber, items);
    const paragraphs = normalizePageItems(items, pageNumber);
    state.pages.push({
      page: pageNumber,
      paragraphs,
      renderTokens: pageView.renderTokens,
      shell: pageView.shell,
      viewportWidth: pageView.viewportWidth,
      viewportHeight: pageView.viewportHeight,
    });
  }

  buildDocumentModel();
  debugLog("Document model built", {
    pages: state.pages.length,
    sentences: state.allSentences.length,
    words: state.allWords.length,
  });
  assignWordBoxes();
  debugLog("Word boxes assigned");
  buildChunkPlan();

  state.playback.currentChunkIndex = 0;
  state.playback.currentSentenceIndex = 0;
  state.playback.currentWordGlobalIndex = 0;
  updateProgress();

  await fetch("/extract-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file_id: state.fileId,
      filename: state.filename,
      pages: state.pages.map((page) => ({
        page: page.page,
        paragraphs: page.paragraphs,
      })),
      metadata: { source: "pdfjs-browser" },
    }),
  }).catch(() => {});

  setStatus(`Mapped ${state.allWords.length} words onto ${state.pages.length} PDF pages.`);
}

async function uploadPdf(file) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch("/upload-pdf", { method: "POST", body: formData });
  if (!response.ok) throw new Error("Upload failed");
  const payload = await response.json();
  state.fileId = payload.file_id;
  state.filename = payload.filename;
}

function exportText() {
  const text = state.allSentences.map((sentence) => sentence.text).join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${(state.filename || "extracted").replace(/\.pdf$/i, "")}.txt`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function bindEvents() {
  els.pdfInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    stopPlayback();
    try {
      setStatus("Uploading PDF...");
      debugLog("Uploading PDF", {
        filename: file.name,
      });
      await uploadPdf(file);
      await extractWithPdfJs(file);
    } catch (error) {
      debugLog("PDF processing failed", {
        error: error.message,
      });
      setStatus(`Error: ${error.message}`);
    }
  });

  els.playBtn.addEventListener("click", async () => {
    debugLog("Play button clicked", {
      currentSentenceIndex: state.playback.currentSentenceIndex,
    });
    try {
      await startPlayback(state.playback.currentSentenceIndex);
    } catch (error) {
      debugLog("Start playback failed", {
        error: error.message,
      });
      setStatus(`Playback error: ${error.message}`);
    }
  });

  els.pauseBtn.addEventListener("click", () => {
    const audio = state.playback.currentAudio;
    if (!audio) return;
    audio.pause();
    debugLog("Playback paused", {
      chunkIndex: state.playback.currentChunkIndex,
      currentTime: audio.currentTime,
    });
    setStatus("Paused.");
  });

  els.resumeBtn.addEventListener("click", async () => {
    const audio = state.playback.currentAudio;
    if (!audio) return;
    await audio.play().catch(() => {});
    debugLog("Playback resumed", {
      chunkIndex: state.playback.currentChunkIndex,
      currentTime: audio.currentTime,
    });
    setStatus(`Playing chunk ${state.playback.currentChunkIndex + 1} of ${state.chunks.length}...`);
  });

  els.stopBtn.addEventListener("click", stopPlayback);

  els.prevSentenceBtn.addEventListener("click", () => {
    const previous = Math.max(0, state.playback.currentSentenceIndex - 1);
    jumpToSentence(previous, false);
  });

  els.nextSentenceBtn.addEventListener("click", () => {
    const next = Math.min(state.allSentences.length - 1, state.playback.currentSentenceIndex + 1);
    jumpToSentence(next, false);
  });

  els.speedRange.addEventListener("input", (event) => {
    const speed = Number(event.target.value);
    state.settings.speed = speed;
    els.speedValue.textContent = `${speed.toFixed(2)}x`;
    if (state.playback.currentAudio) {
      state.playback.currentAudio.playbackRate = speed;
    }
  });

  els.wordHighlightToggle.addEventListener("change", (event) => {
    state.settings.wordHighlightEnabled = event.target.checked;
    if (!event.target.checked) {
      document.querySelectorAll(".word-box.current-word").forEach((element) => element.classList.remove("current-word"));
    } else {
      markPosition(state.playback.currentWordGlobalIndex);
    }
  });

  els.darkModeBtn.addEventListener("click", () => document.body.classList.toggle("dark"));
  els.exportTextBtn.addEventListener("click", exportText);

  document.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      event.preventDefault();
      if (state.playback.currentAudio?.paused) {
        els.resumeBtn.click();
      } else {
        els.pauseBtn.click();
      }
    } else if (event.code === "ArrowRight") {
      els.nextSentenceBtn.click();
    } else if (event.code === "ArrowLeft") {
      els.prevSentenceBtn.click();
    }
  });
}

bindEvents();
updateCurrentSentencePanel(-1);
updateProgress();
