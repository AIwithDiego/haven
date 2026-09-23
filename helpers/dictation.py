"""Local speech helper. Audio stays in memory. JSON lines over stdin/stdout."""
import sys
import os
import json
import time
import queue
import threading
import contextlib
import re
import uuid

OUTPUT_LOCK = threading.Lock()


def emit(kind, **data):
    with OUTPUT_LOCK:
        print(json.dumps({'type': kind, **data}), flush=True)


def shortcut_key(choice):
    return (63, 'Fn') if choice == 'fn' else (61, 'Right Option')


def substitutions(text, rules):
    replacements = {}
    for rule in rules:
        source = rule.get('from', '').strip()
        if source:
            replacements.setdefault(source.casefold(), rule.get('to', ''))
    if replacements:
        phrases = sorted(replacements, key=len, reverse=True)
        pattern = r'(?<!\w)(?:' + '|'.join(re.escape(phrase) for phrase in phrases) + r')(?!\w)'
        text = re.sub(pattern, lambda match: replacements[match.group().casefold()], text, flags=re.IGNORECASE)
    text = re.sub(r'[ \t]+([,.;:!?\)\]\}])', r'\1', text)
    text = re.sub(r'([\(\[\{])[ \t]+', r'\1', text)
    return text


def recognize(model, audio, config):
    with contextlib.redirect_stdout(sys.stderr):
        result = model.transcribe(audio, fp16=False, language=config.get('voiceLanguage', 'en'),
                                  initial_prompt=config.get('vocabulary', ''), condition_on_previous_text=False)
    original = result.get('text', '').strip()
    return original, substitutions(original, config.get('substitutions', []))


def paste_into_focus(text, expected_pid):
    import Quartz as Q
    import AppKit as A
    current = A.NSWorkspace.sharedWorkspace().frontmostApplication().processIdentifier()
    if expected_pid and current != expected_pid:
        return False, 'The focused app changed while transcribing. Text is available in Haven.'
    system = Q.AXUIElementCreateSystemWide()
    err, focused = Q.AXUIElementCopyAttributeValue(system, 'AXFocusedUIElement', None)
    if err or not focused:
        return False, 'Cannot verify the focused field. Enable Accessibility or copy the text from Haven.'
    role_error, role = Q.AXUIElementCopyAttributeValue(focused, 'AXRole', None)
    subrole_error, subrole = Q.AXUIElementCopyAttributeValue(focused, 'AXSubrole', None)
    if subrole == 'AXSecureTextField':
        return False, 'Dictation is not inserted into password fields.'
    if role_error or role not in ('AXTextField', 'AXTextArea', 'AXComboBox') or (role != 'AXTextArea' and subrole_error):
        return False, 'Cannot verify that this is a non-password text field. Copy the text from Haven if appropriate.'
    if Q.AXUIElementSetAttributeValue(focused, 'AXSelectedText', text) == 0:
        return True, None
    clipboard = A.NSPasteboard.generalPasteboard()
    saved = []
    for item in clipboard.pasteboardItems() or []:
        clone = A.NSPasteboardItem.alloc().init()
        for type_name in item.types():
            data = item.dataForType_(type_name)
            if data is not None:
                clone.setData_forType_(data, type_name)
        saved.append(clone)
    clipboard.clearContents()
    clipboard.setString_forType_(text, A.NSPasteboardTypeString)
    marker = clipboard.changeCount()
    # Paste from data, never interpolate dictated text into a shell or AppleScript.
    down, up = Q.CGEventCreateKeyboardEvent(None, 9, True), Q.CGEventCreateKeyboardEvent(None, 9, False)
    Q.CGEventSetFlags(down, Q.kCGEventFlagMaskCommand)
    Q.CGEventSetFlags(up, Q.kCGEventFlagMaskCommand)
    Q.CGEventPost(Q.kCGHIDEventTap, down)
    Q.CGEventPost(Q.kCGHIDEventTap, up)
    time.sleep(0.4)
    if clipboard.changeCount() == marker:
        clipboard.clearContents()
        if saved:
            clipboard.writeObjects_(saved)
    return True, None


def verify_model(whisper, name, model_path):
    """Check the cached weights against the SHA256 whisper publishes for this
    model before unpickling them. Never downloads: a mismatch is an error."""
    import hashlib
    url = getattr(whisper, '_MODELS', {}).get(name)
    if not url:
        raise RuntimeError(f'Whisper has no published checksum for the {name} model.')
    expected = url.split('/')[-2]
    digest = hashlib.sha256()
    with open(model_path, 'rb') as file:
        for block in iter(lambda: file.read(1 << 20), b''):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise RuntimeError(f'The local {name} model does not match its published checksum. Delete {model_path} and reinstall it.')


class Dictation:
    def __init__(self, config_path):
        import numpy as np
        import sounddevice as sd
        import Quartz as Q
        import AppKit as A
        self.np, self.sd, self.Q, self.A = np, sd, Q, A
        self.config_path = config_path
        self.commands = queue.Queue()
        self.clips = queue.Queue(maxsize=3)
        self.recording = False
        self.frames = []
        self.stream = None
        self.tap = None
        self.model = None
        self.model_name = None
        self.key_down = False

    def config(self):
        with open(self.config_path) as file:
            return json.load(file)

    def load(self):
        import whisper
        name = self.config().get('voiceModel', 'small')
        if name == self.model_name:
            return
        model_path = os.path.expanduser('~/.cache/whisper/' + name + '.pt')
        if not os.path.isfile(model_path):
            raise RuntimeError(f'The local {name} model is not installed. Choose an installed model in Settings.')
        emit('state', status='loading', message=f'Loading local Whisper {name}…')
        verify_model(whisper, name, model_path)
        with contextlib.redirect_stdout(sys.stderr):
            self.model = whisper.load_model(model_path)
        self.model_name = name

    def start(self):
        if self.recording:
            return
        self.frames = []
        self.clip_id = str(uuid.uuid4())
        self.target_pid = self.A.NSWorkspace.sharedWorkspace().frontmostApplication().processIdentifier()
        self.started = time.monotonic()

        def audio(indata, count, timing, status):
            if status:
                emit('notice', message=str(status))
            if self.recording:
                self.frames.append(indata.copy())
                if time.monotonic() - self.started > 180:
                    self.commands.put({'type': 'stop'})

        stream = self.sd.InputStream(samplerate=16000, channels=1, dtype='float32', callback=audio, blocksize=1024)
        try:
            self.recording = True
            stream.start()
            self.stream = stream
        except Exception:
            self.recording = False
            stream.close()
            raise
        emit('recording', clipId=self.clip_id, pid=self.target_pid)

    def stop(self):
        if not self.recording:
            return
        self.recording = False
        self.stream.stop()
        self.stream.close()
        self.stream = None
        if not self.frames:
            emit('state', status='ready')
            return
        audio = self.np.concatenate(self.frames).flatten()
        if len(audio) < 8000:
            emit('state', status='ready', message='Hold right Option a little longer.')
            return
        peak = float(self.np.abs(audio).max())
        if peak == 0:
            emit('error', message='The microphone returned silence. Check Microphone permission and your input device.')
            return
        try:
            self.clips.put_nowait((audio, self.clip_id, self.target_pid))
            emit('state', status='transcribing', message='Transcribing on your Mac…')
        except queue.Full:
            emit('error', message='Three recordings are waiting. Let transcription finish before recording again.')

    def transcriptions(self):
        while True:
            audio, clip_id, pid = self.clips.get()
            try:
                self.load()
                config = self.config()
                start = time.monotonic()
                original, text = recognize(self.model, audio, config)
                if text:
                    emit('transcript', text=text, original=original, clipId=clip_id, pid=pid, seconds=round(time.monotonic() - start, 1))
                else:
                    emit('notice', message='No speech detected.')
                emit('state', status='recording' if self.recording else 'ready')
            except Exception as error:
                emit('error', message=str(error))
            finally:
                self.clips.task_done()

    def worker(self):
        while True:
            command = self.commands.get()
            try:
                if command['type'] == 'start':
                    self.start()
                elif command['type'] == 'stop':
                    self.stop()
                elif command['type'] == 'paste':
                    ok, error = paste_into_focus(command['text'], command.get('pid'))
                    emit('delivery', ok=ok, message=error)
            except Exception as error:
                emit('error', message=str(error))

    def run(self):
        Q = self.Q
        keycode, key_label = shortcut_key(self.config().get('voiceShortcut', 'right-option'))
        self.load()
        self.sd.query_devices()
        threading.Thread(target=self.worker, daemon=True).start()
        threading.Thread(target=self.transcriptions, daemon=True).start()

        def read_commands():
            for line in sys.stdin:
                try:
                    self.commands.put(json.loads(line))
                except Exception:
                    pass
            os._exit(0)

        threading.Thread(target=read_commands, daemon=True).start()

        def callback(proxy, event_type, event, refcon):
            if event_type in (Q.kCGEventTapDisabledByTimeout, Q.kCGEventTapDisabledByUserInput):
                if self.tap:
                    Q.CGEventTapEnable(self.tap, True)
                    emit('shortcut', shortcutListening=bool(Q.CGEventTapIsEnabled(self.tap)), shortcutPermission='input-monitoring')
                return event
            if Q.CGEventGetIntegerValueField(event, Q.kCGKeyboardEventKeycode) == keycode:
                down = Q.CGEventSourceKeyState(Q.kCGEventSourceStateCombinedSessionState, keycode)
                if down != self.key_down:
                    self.key_down = down
                    self.commands.put({'type': 'start' if down else 'stop'})
            return event

        self.tap = Q.CGEventTapCreate(Q.kCGSessionEventTap, Q.kCGHeadInsertEventTap, Q.kCGEventTapOptionListenOnly,
                                    Q.CGEventMaskBit(Q.kCGEventFlagsChanged), callback, None)
        if not self.tap:
            emit('state', status='ready', shortcutListening=False, shortcutPermission='input-monitoring', message=f'{key_label} is not listening. Allow Input Monitoring for Haven or its Python helper, then retry. Use the microphone button or ⌘⇧Space meanwhile.')
            while True:
                time.sleep(1)
        source = Q.CFMachPortCreateRunLoopSource(None, self.tap, 0)
        Q.CFRunLoopAddSource(Q.CFRunLoopGetCurrent(), source, Q.kCFRunLoopCommonModes)
        Q.CGEventTapEnable(self.tap, True)
        emit('state', status='ready', shortcutListening=bool(Q.CGEventTapIsEnabled(self.tap)), shortcutPermission='input-monitoring')

        def monitor_shortcut():
            previous = None
            while True:
                listening = bool(Q.CGEventTapIsEnabled(self.tap))
                if listening != previous:
                    emit('shortcut', shortcutListening=listening, shortcutPermission='input-monitoring')
                    previous = listening
                time.sleep(1)

        threading.Thread(target=monitor_shortcut, daemon=True).start()
        Q.CFRunLoopRun()


if __name__ == '__main__':
    try:
        Dictation(sys.argv[1]).run()
    except Exception as error:
        emit('error', message=str(error))
        sys.exit(1)
