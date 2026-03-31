from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')

    app_host: str = '0.0.0.0'
    app_port: int = 8000

    temp_dir: str = './tmp'
    upload_dir: str = './tmp/uploads'
    audio_cache_dir: str = './tmp/audio_cache'

    tts_server_base_url: str = 'http://127.0.0.1:8001'
    tts_speech_route: str = '/audio/speech'
    tts_model: str = 'mistralai/Voxtral-4B-TTS-2603'
    tts_voice: str = 'alloy'
    tts_audio_format: str = 'mp3'
    tts_timeout_seconds: int = 180

    max_chunk_chars: int = 900
    default_speed: float = 1.0
    min_speed: float = 0.65
    max_speed: float = 1.75

    pause_comma: float = 0.10
    pause_semicolon: float = 0.16
    pause_period: float = 0.24
    pause_question: float = 0.24
    pause_paragraph: float = 0.35


settings = Settings()
