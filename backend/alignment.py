from pathlib import Path


def get_word_timings(text: str, audio_file: Path) -> list[dict] | None:
    """Alignment-ready interface.

    Return a list like:
      [{"word": "Hello", "start": 0.00, "end": 0.18}, ...]
    or None if no aligner is configured.
    """
    _ = (text, audio_file)
    return None
