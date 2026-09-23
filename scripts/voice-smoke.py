"""Offline decode check with synthetic macOS speech. Does not open a microphone."""
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import time
import whisper

spec = importlib.util.spec_from_file_location('dictation', pathlib.Path(__file__).parents[1] / 'helpers/dictation.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
model_path = pathlib.Path.home() / '.cache/whisper/small.pt'
assert model_path.is_file(), 'The local small model must already exist; this test does not download it.'
with tempfile.TemporaryDirectory(prefix='haven-voice-check-') as directory:
    audio_path = pathlib.Path(directory) / 'synthetic-speech.aiff'
    subprocess.run(['/usr/bin/say', '-o', str(audio_path), 'Your new workspace is ready. Keep every conversation in its own task.'], check=True)
    start = time.monotonic()
    model = whisper.load_model(str(model_path))
    waveform = whisper.load_audio(str(audio_path))
    assert len(waveform) > 8000 and float(abs(waveform).max()) > 0.001, 'macOS did not produce audible synthetic speech.'
    original, text = helper.recognize(model, waveform, {'voiceLanguage': 'en', 'vocabulary': 'Haven, Claude, Codex'})
    assert 'workspace' in text.lower() and 'conversation' in text.lower(), text
    print(json.dumps({'ok': True, 'model': 'local Whisper small', 'text': text, 'load_and_decode_seconds': round(time.monotonic() - start, 1), 'microphone_used': False}))
