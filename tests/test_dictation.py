import importlib.util
import pathlib
import unittest
import sys
from unittest.mock import patch, Mock
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('dictation', pathlib.Path(__file__).parents[1] / 'helpers/dictation.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VocabularyTest(unittest.TestCase):
    def test_longest_match_wins_without_cascading_and_punctuation_is_tidy(self):
        rules = [{'from': 'cloud', 'to': 'Claude'}, {'from': 'cloud code', 'to': 'Claude Code'}, {'from': 'Claude', 'to': 'wrong'}]
        self.assertEqual(module.substitutions('cloud code , cloud ! ( cloud )\n\nNext.', rules), 'Claude Code, Claude! (Claude)\n\nNext.')

    def test_only_explicit_whole_phrases_are_replaced(self):
        rules = [{'from': 'cloud code', 'to': 'Claude Code'}, {'from': 'hay ven', 'to': 'Haven'}]
        self.assertEqual(module.substitutions('Cloud Code, meet hay ven. The cloud stays.', rules), 'Claude Code, meet Haven. The cloud stays.')

    def test_replacements_are_literal_and_preserve_spacing(self):
        rules = [{'from': 'a+b', 'to': r'\literal$1'}]
        self.assertEqual(module.substitutions('a+b\n\na+b', rules), '\\literal$1\n\n\\literal$1')


class ShortcutTest(unittest.TestCase):
    def test_failed_event_tap_reports_not_listening_even_with_microphone_ready(self):
        helper = module.Dictation.__new__(module.Dictation)
        helper.load = lambda: None
        helper.config = lambda: {}
        helper.sd = SimpleNamespace(query_devices=lambda: None)
        helper.Q = SimpleNamespace(kCGSessionEventTap=1, kCGHeadInsertEventTap=0,
                                   kCGEventTapOptionListenOnly=1, kCGEventFlagsChanged=12,
                                   CGEventMaskBit=lambda value: value, CGEventTapCreate=lambda *args: None)
        with patch.object(module.threading, 'Thread'), patch.object(module, 'emit') as emit, \
                patch.object(module.time, 'sleep', side_effect=StopIteration):
            with self.assertRaises(StopIteration):
                helper.run()
        states = [call.kwargs for call in emit.call_args_list if call.args[0] == 'state']
        self.assertEqual(states[-1]['status'], 'ready')
        self.assertIs(states[-1].get('shortcutListening'), False)
        self.assertEqual(states[-1].get('shortcutPermission'), 'input-monitoring')


class InsertionTest(unittest.TestCase):
    def test_unknown_focused_field_never_falls_back_to_clipboard_paste(self):
        quartz = SimpleNamespace(AXUIElementCreateSystemWide=lambda: object(),
                                 AXUIElementCopyAttributeValue=lambda *args: (1, None))
        appkit = SimpleNamespace(NSWorkspace=SimpleNamespace(sharedWorkspace=lambda: SimpleNamespace(
            frontmostApplication=lambda: SimpleNamespace(processIdentifier=lambda: 7))),
            NSPasteboard=SimpleNamespace(generalPasteboard=Mock(side_effect=AssertionError('Clipboard accessed'))))
        with patch.dict(sys.modules, {'Quartz': quartz, 'AppKit': appkit}):
            inserted, reason = module.paste_into_focus('Private words', 7)
        self.assertFalse(inserted)
        self.assertIn('verify', reason)
        appkit.NSPasteboard.generalPasteboard.assert_not_called()

class ShortcutChoiceTest(unittest.TestCase):
    def test_fn_and_right_option_are_distinct_supported_keys(self):
        self.assertEqual(module.shortcut_key('fn'), (63, 'Fn'))
        self.assertEqual(module.shortcut_key('right-option'), (61, 'Right Option'))
        self.assertEqual(module.shortcut_key('unknown'), (61, 'Right Option'))


class ModelChecksumTest(unittest.TestCase):
    def test_weights_must_match_the_published_sha256_before_loading(self):
        import hashlib, tempfile, os
        with tempfile.NamedTemporaryFile(delete=False) as file:
            file.write(b'weights')
        try:
            good = hashlib.sha256(b'weights').hexdigest()
            module.verify_model(SimpleNamespace(_MODELS={'small': f'https://x.example/models/{good}/small.pt'}), 'small', file.name)
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                module.verify_model(SimpleNamespace(_MODELS={'small': f'https://x.example/models/{"0" * 64}/small.pt'}), 'small', file.name)
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                module.verify_model(SimpleNamespace(_MODELS={}), 'custom', file.name)
        finally:
            os.unlink(file.name)


if __name__ == '__main__':
    unittest.main()
