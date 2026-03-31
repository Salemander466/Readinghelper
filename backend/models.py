from typing import Any

from pydantic import BaseModel, Field


class UploadedPdfResponse(BaseModel):
    file_id: str
    filename: str
    size_bytes: int
    content_type: str


class ExtractTextPayload(BaseModel):
    file_id: str
    filename: str
    pages: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ExtractTextResponse(BaseModel):
    file_id: str
    page_count: int
    paragraph_count: int
    sentence_count: int
    word_count: int
    notes: list[str] = Field(default_factory=list)


class TTSChunkRequest(BaseModel):
    text: str
    chunk_id: str
    speed: float = 1.0
    voice: str | None = None
    file_id: str | None = None


class TTSChunkResponse(BaseModel):
    chunk_id: str
    cached: bool
    audio_url: str
    mime_type: str
    model: str
    word_timings: list[dict[str, Any]] | None = None


class HealthResponse(BaseModel):
    status: str
    tts_base_url: str
    tts_route: str
