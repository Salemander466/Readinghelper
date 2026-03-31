import json
import logging
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .alignment import get_word_timings
from .config import settings
from .models import (
    ExtractTextPayload,
    ExtractTextResponse,
    HealthResponse,
    TTSChunkRequest,
    TTSChunkResponse,
    UploadedPdfResponse,
)
from .tts_client import TTSClientError, build_cache_key, synthesize_to_path


logger = logging.getLogger('uvicorn.error')


def _ensure_dirs() -> None:
    for folder in [settings.temp_dir, settings.upload_dir, settings.audio_cache_dir]:
        Path(folder).mkdir(parents=True, exist_ok=True)


_ensure_dirs()

app = FastAPI(title='Reading Helper - PDF Read Aloud')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

app.mount('/static', StaticFiles(directory='frontend'), name='static')


@app.get('/', include_in_schema=False)
async def index():
    return FileResponse('frontend/index.html')


@app.get('/health', response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status='ok', tts_base_url=settings.tts_server_base_url, tts_route=settings.tts_speech_route)


@app.post('/upload-pdf', response_model=UploadedPdfResponse)
async def upload_pdf(file: UploadFile = File(...)) -> UploadedPdfResponse:
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail='Only PDF uploads are supported.')

    file_id = str(uuid.uuid4())
    ext = Path(file.filename).suffix or '.pdf'
    out_path = Path(settings.upload_dir) / f'{file_id}{ext}'

    content = await file.read()
    out_path.write_bytes(content)
    logger.info('Uploaded PDF file_id=%s filename=%s size_bytes=%s', file_id, file.filename, len(content))

    return UploadedPdfResponse(
        file_id=file_id,
        filename=file.filename,
        size_bytes=len(content),
        content_type=file.content_type or 'application/pdf',
    )


@app.post('/extract-text', response_model=ExtractTextResponse)
async def extract_text(payload: ExtractTextPayload) -> ExtractTextResponse:
    page_count = len(payload.pages)
    paragraph_count = 0
    sentence_count = 0
    word_count = 0
    notes: list[str] = []

    for page in payload.pages:
        paragraphs = page.get('paragraphs', [])
        if not paragraphs:
            notes.append(f"Page {page.get('page', '?')} has no selectable text. OCR may be required.")
        paragraph_count += len(paragraphs)

        for para in paragraphs:
            sentences = para.get('sentences', [])
            sentence_count += len(sentences)
            for sentence in sentences:
                words = sentence.get('words', [])
                word_count += len(words)

    manifest_path = Path(settings.temp_dir) / f"{payload.file_id}_structure.json"
    manifest_path.write_text(json.dumps(payload.model_dump(), ensure_ascii=False, indent=2), encoding='utf-8')
    logger.info(
        'Extracted text file_id=%s pages=%s paragraphs=%s sentences=%s words=%s',
        payload.file_id,
        page_count,
        paragraph_count,
        sentence_count,
        word_count,
    )

    return ExtractTextResponse(
        file_id=payload.file_id,
        page_count=page_count,
        paragraph_count=paragraph_count,
        sentence_count=sentence_count,
        word_count=word_count,
        notes=notes,
    )


@app.post('/tts-chunk', response_model=TTSChunkResponse)
async def tts_chunk(payload: TTSChunkRequest) -> TTSChunkResponse:
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail='Chunk text cannot be empty.')

    clamped_speed = min(max(payload.speed, settings.min_speed), settings.max_speed)
    voice = payload.voice or settings.tts_voice
    fmt = settings.tts_audio_format

    key = build_cache_key(payload.text, clamped_speed, voice, fmt)
    audio_path = Path(settings.audio_cache_dir) / f'{key}.{fmt}'
    logger.info(
        'TTS chunk requested file_id=%s chunk_id=%s speed=%.2f voice=%s text_chars=%s',
        payload.file_id,
        payload.chunk_id,
        clamped_speed,
        voice,
        len(payload.text),
    )

    cached = audio_path.exists()
    if not cached:
        try:
            await synthesize_to_path(payload.text, clamped_speed, voice, audio_path)
        except TTSClientError as exc:
            logger.exception('TTS synthesis failed chunk_id=%s', payload.chunk_id)
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    else:
        logger.info('TTS chunk cache hit chunk_id=%s audio_path=%s', payload.chunk_id, audio_path.name)

    word_timings = get_word_timings(payload.text, audio_path)
    logger.info(
        'TTS chunk ready chunk_id=%s cached=%s audio_path=%s timings=%s',
        payload.chunk_id,
        cached,
        audio_path.name,
        len(word_timings or []),
    )
    return TTSChunkResponse(
        chunk_id=payload.chunk_id,
        cached=cached,
        audio_url=f'/audio/{audio_path.name}',
        mime_type=f'audio/{fmt}',
        model=settings.tts_model,
        word_timings=word_timings,
    )


@app.get('/audio/{filename}')
async def get_audio(filename: str):
    path = Path(settings.audio_cache_dir) / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail='Audio chunk not found.')
    logger.info('Serving audio filename=%s', filename)
    return FileResponse(path)
