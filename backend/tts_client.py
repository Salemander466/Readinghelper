import hashlib
from pathlib import Path

import httpx

from .config import settings


class TTSClientError(RuntimeError):
    pass


def _speech_url() -> str:
    base = settings.tts_server_base_url.rstrip('/')
    route = settings.tts_speech_route
    if not route.startswith('/'):
        route = '/' + route
    return base + route


def build_cache_key(text: str, speed: float, voice: str, fmt: str) -> str:
    payload = f"{settings.tts_model}|{voice}|{speed:.3f}|{fmt}|{text}".encode('utf-8')
    return hashlib.sha256(payload).hexdigest()


async def synthesize_to_path(text: str, speed: float, voice: str, dest: Path) -> None:
    url = _speech_url()
    request_payload = {
        'model': settings.tts_model,
        'input': text,
        'voice': voice,
        'response_format': settings.tts_audio_format,
        'speed': speed,
    }

    timeout = httpx.Timeout(settings.tts_timeout_seconds)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=request_payload)
            resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:500]
        raise TTSClientError(f'TTS server rejected request ({exc.response.status_code}): {detail}') from exc
    except httpx.HTTPError as exc:
        raise TTSClientError(f'Unable to reach TTS server at {url}. Error: {exc}') from exc

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(resp.content)
