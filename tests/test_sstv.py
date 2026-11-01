import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np
from PIL import Image

from sstv import MODES, SAMPLE_RATE, VIS_HEADER_MS, encode, prepare_image


class EncoderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.source = self.folder / 'input.png'
        Image.new('RGB', (40, 30), (255, 0, 0)).save(self.source)

    def test_mode_timings_and_wave_headers(self):
        for mode_name, mode in MODES.items():
            with self.subTest(mode=mode_name):
                target = self.folder / f'{mode_name}.wav'
                checkpoints = []
                duration = encode(self.source, target, mode_name, checkpoints.append)
                self.assertEqual(checkpoints[-1], 100)
                self.assertAlmostEqual(duration, (VIS_HEADER_MS + mode.height * mode.line_ms) / 1000, delta=0.01)
                with wave.open(str(target)) as wav:
                    self.assertEqual(wav.getnchannels(), 1)
                    self.assertEqual(wav.getsampwidth(), 2)
                    self.assertEqual(wav.getframerate(), SAMPLE_RATE)
                    self.assertEqual(wav.getnframes(), round(duration * SAMPLE_RATE))

    def test_vis_start_bit_and_mode_bits(self):
        for mode_name, mode in MODES.items():
            with self.subTest(mode=mode_name):
                target = self.folder / f'vis-{mode_name}.wav'
                encode(self.source, target, mode_name)
                with wave.open(str(target)) as wav:
                    data = np.frombuffer(wav.readframes(round(.910 * SAMPLE_RATE)), dtype='<i2')
                def freq_ms(start_ms, duration_ms=30):
                    segment = data[round(start_ms * SAMPLE_RATE / 1000):round((start_ms+duration_ms) * SAMPLE_RATE / 1000)]
                    crossings = np.count_nonzero(np.diff(np.signbit(segment)))
                    return crossings * SAMPLE_RATE / (2 * len(segment))
                self.assertAlmostEqual(freq_ms(610), 1200, delta=20)
                for bit in range(7):
                    expected = 1100 if (mode.vis >> bit) & 1 else 1300
                    self.assertAlmostEqual(freq_ms(640+30*bit), expected, delta=20)

    def test_png_alpha_and_letterboxing(self):
        Image.new('RGBA', (20, 20), (255, 0, 0, 0)).save(self.source)
        output = prepare_image(self.source, MODES['robot36'])
        self.assertEqual(output.shape, (240, 320, 3))
        self.assertGreater(float(output[120, 160, 0]), 245)
        self.assertLess(float(output[120, 5, 0]), 5)

    def test_invalid_input_does_not_overwrite_target(self):
        target = self.folder / 'existing.wav'
        target.write_bytes(b'untouched')
        self.source.write_bytes(b'not a png')
        with self.assertRaises(OSError):
            encode(self.source, target)
        self.assertEqual(target.read_bytes(), b'untouched')

    def test_input_cannot_be_output(self):
        with self.assertRaises(ValueError):
            encode(self.source, self.source)


if __name__ == '__main__':
    unittest.main()
