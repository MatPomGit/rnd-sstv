#!/usr/bin/env python3
"""Encode PNG pictures as Robot SSTV audio; desktop GUI and CLI."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import queue
import tempfile
import threading
import wave
from typing import Callable

import numpy as np
from PIL import Image, ImageOps

SAMPLE_RATE = 48000
VIS_HEADER_MS = 910


@dataclass(frozen=True)
class Mode:
    name: str
    width: int
    height: int
    vis: int
    sync_ms: float
    porch_ms: float
    y_ms: float
    separator_ms: float = 0
    chroma_porch_ms: float = 0
    chroma_ms: float = 0
    chroma: str = 'none'  # none, alternating, both

    @property
    def line_ms(self) -> float:
        if self.chroma == 'none':
            return self.sync_ms + self.y_ms
        blocks = 2 if self.chroma == 'both' else 1
        return (self.sync_ms + self.porch_ms + self.y_ms
                + blocks * (self.separator_ms + self.chroma_porch_ms + self.chroma_ms))


MODES = {
    'robot12': Mode('Robot Color 12', 160, 120, 0, 7, 0, 60, 3, 0, 30, 'alternating'),
    'robot24': Mode('Robot Color 24', 320, 120, 4, 9, 3, 88, 4.5, 1.5, 44, 'both'),
    'robot36': Mode('Robot Color 36', 320, 240, 8, 9, 3, 88, 4.5, 1.5, 44, 'alternating'),
    'bw8': Mode('Robot B/W 8', 160, 120, 2, 10, 0, 56),
}


class Synthesizer:
    """Phase-continuous audio generator, including pixel frequency scans."""

    def __init__(self, wav: wave.Wave_write, sample_rate: int = SAMPLE_RATE):
        self.wav = wav
        self.sample_rate = sample_rate
        self.phase = 0.0
        self.samples = 0

    def emit(self, hz: float | np.ndarray, milliseconds: float) -> None:
        count = round(milliseconds * self.sample_rate / 1000)
        if count <= 0:
            return
        if np.isscalar(hz):
            frequencies = np.full(count, float(hz), dtype=np.float64)
        else:
            values = np.asarray(hz, dtype=np.float64)
            indices = np.minimum(np.arange(count) * len(values) // count, len(values) - 1)
            frequencies = values[indices]
        increments = frequencies * (2 * np.pi / self.sample_rate)
        phases = self.phase + np.cumsum(increments) - increments
        pcm = np.rint(0.80 * 32767 * np.sin(phases)).astype('<i2')
        self.wav.writeframesraw(pcm.tobytes())
        self.phase = float((self.phase + increments.sum()) % (2 * np.pi))
        self.samples += count

    def pixels(self, values: np.ndarray, milliseconds: float) -> None:
        self.emit(1500 + 800 * np.clip(values, 0, 255) / 255, milliseconds)


def prepare_image(path: Path, mode: Mode) -> np.ndarray:
    """Letterbox instead of stretching or cropping; composite PNG alpha on white."""
    with Image.open(path) as source:
        if source.format != 'PNG':
            raise ValueError('Plik wejściowy musi być obrazem PNG.')
        rgba = ImageOps.exif_transpose(source).convert('RGBA')
        background = Image.new('RGBA', rgba.size, 'white')
        background.alpha_composite(rgba)
        rgb = ImageOps.pad(background.convert('RGB'), (mode.width, mode.height),
                           method=Image.Resampling.LANCZOS, color='black')
        return np.asarray(rgb.convert('YCbCr'), dtype=np.float64)


def write_vis(synth: Synthesizer, vis: int) -> None:
    synth.emit(1900, 300)
    synth.emit(1200, 10)
    synth.emit(1900, 300)
    synth.emit(1200, 30)
    for bit in range(7):
        synth.emit(1100 if (vis >> bit) & 1 else 1300, 30)
    synth.emit(1100 if vis.bit_count() & 1 else 1300, 30)
    synth.emit(1200, 30)


def encode(source: str | Path, destination: str | Path, mode_name: str = 'robot36',
           on_progress: Callable[[int], None] | None = None) -> float:
    """Create WAV atomically. Return duration including VIS header in seconds."""
    if mode_name not in MODES:
        raise ValueError(f'Nieznany tryb: {mode_name}')
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve():
        raise ValueError('Plik wejściowy i wyjściowy muszą być różne.')
    mode = MODES[mode_name]
    pixels = prepare_image(source, mode)
    y = pixels[:, :, 0]
    cb = pixels[:, :, 1]
    cr = pixels[:, :, 2]
    if mode.chroma == 'alternating':
        cr_pairs = 0.5 * (cr[::2] + cr[1::2])
        cb_pairs = 0.5 * (cb[::2] + cb[1::2])

    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix='.sstv-', suffix='.wav', dir=destination.parent)
    os.close(fd)
    try:
        with wave.open(tmp_name, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            synth = Synthesizer(wav)
            write_vis(synth, mode.vis)
            for row in range(mode.height):
                synth.emit(1200, mode.sync_ms)
                synth.emit(1500, mode.porch_ms)
                synth.pixels(y[row], mode.y_ms)
                if mode.chroma == 'alternating':
                    is_cr = row % 2 == 0
                    synth.emit(1500 if is_cr else 2300, mode.separator_ms)
                    synth.emit(1900, mode.chroma_porch_ms)
                    synth.pixels(cr_pairs[row // 2] if is_cr else cb_pairs[row // 2],
                                 mode.chroma_ms)
                elif mode.chroma == 'both':
                    for chroma, separator in ((cr[row], 1500), (cb[row], 2300)):
                        synth.emit(separator, mode.separator_ms)
                        synth.emit(1900, mode.chroma_porch_ms)
                        synth.pixels(chroma, mode.chroma_ms)
                if on_progress and (row % 8 == 0 or row == mode.height - 1):
                    on_progress(round((row + 1) * 100 / mode.height))
        os.replace(tmp_name, destination)
        return synth.samples / SAMPLE_RATE
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def launch_gui() -> None:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    from PIL import ImageTk

    root = tk.Tk()
    root.title('SSTV Robot | PNG → WAV')
    root.minsize(560, 510)
    root.geometry('640x570')

    src = tk.StringVar()
    dst = tk.StringVar()
    mode = tk.StringVar(value='robot36')
    details = tk.StringVar()
    status = tk.StringVar(value='Wybierz obraz PNG.')
    events: queue.Queue[tuple[str, object]] = queue.Queue()
    preview_image = None

    panel = ttk.Frame(root, padding=16)
    panel.pack(fill='both', expand=True)
    ttk.Label(panel, text='PNG → SSTV WAV', font=('TkDefaultFont', 16, 'bold')).pack(anchor='w')
    ttk.Label(panel, text='Robot12 / Robot24 / Robot36 / B/W8').pack(anchor='w', pady=(0, 10))
    preview = ttk.Label(panel, anchor='center')
    preview.pack(fill='both', expand=True, pady=4)

    def refresh() -> None:
        nonlocal preview_image
        m = MODES[mode.get()]
        details.set(f'{m.width} × {m.height} px  |  VIS {m.vis}  |  ~{m.line_ms * m.height / 1000:.2f} s + VIS')
        if src.get():
            path = Path(src.get())
            dst.set(str(path.with_name(f'{path.stem}_{mode.get()}.wav')))
            try:
                with Image.open(path) as opened:
                    image = ImageOps.contain(opened.convert('RGB'), (560, 250))
                preview_image = ImageTk.PhotoImage(image)
                preview.configure(image=preview_image, text='')
            except (OSError, ValueError) as error:
                preview.configure(image='', text=str(error))

    def choose_file() -> None:
        path = filedialog.askopenfilename(title='Wybierz PNG', filetypes=[('PNG', '*.png')])
        if path:
            src.set(path)
            refresh()
            status.set('Gotowy do konwersji.')

    def choose_output() -> None:
        path = filedialog.asksaveasfilename(title='Zapisz WAV', defaultextension='.wav',
                                            initialfile=Path(dst.get()).name if dst.get() else 'sstv.wav',
                                            filetypes=[('WAV PCM', '*.wav')])
        if path:
            dst.set(path)

    input_row = ttk.Frame(panel)
    input_row.pack(fill='x', pady=5)
    ttk.Entry(input_row, textvariable=src).pack(side='left', fill='x', expand=True)
    ttk.Button(input_row, text='Wybierz PNG', command=choose_file).pack(side='left', padx=(8, 0))
    selection = ttk.Frame(panel)
    selection.pack(fill='x', pady=7)
    ttk.Label(selection, text='Tryb:').pack(side='left')
    modes_box = ttk.Combobox(selection, textvariable=mode, state='readonly', width=15,
                              values=list(MODES.keys()))
    modes_box.pack(side='left', padx=10)
    modes_box.bind('<<ComboboxSelected>>', lambda _event: refresh())
    ttk.Label(selection, textvariable=details).pack(side='left')
    output_row = ttk.Frame(panel)
    output_row.pack(fill='x', pady=5)
    ttk.Entry(output_row, textvariable=dst).pack(side='left', fill='x', expand=True)
    ttk.Button(output_row, text='Zapisz jako…', command=choose_output).pack(side='left', padx=(8, 0))
    progress = ttk.Progressbar(panel, maximum=100)
    progress.pack(fill='x', pady=(16, 4))
    ttk.Label(panel, textvariable=status).pack(anchor='w', pady=4)

    def start() -> None:
        if not src.get() or not dst.get():
            messagebox.showwarning('Brak pliku', 'Wybierz wejściowy PNG i docelowy WAV.')
            return
        try:
            if Path(dst.get()).exists() and not messagebox.askyesno('Nadpisać?', 'Plik WAV już istnieje. Nadpisać?'):
                return
        except OSError as error:
            messagebox.showerror('Błąd ścieżki', str(error))
            return
        save_button.configure(state='disabled')
        progress.configure(value=0)
        status.set('Generowanie sygnału...')

        def worker() -> None:
            try:
                duration = encode(src.get(), dst.get(), mode.get(),
                                  lambda value: events.put(('progress', value)))
                events.put(('done', duration))
            except Exception as error:
                events.put(('error', str(error)))

        threading.Thread(target=worker, daemon=True).start()

    save_button = ttk.Button(panel, text='Generuj WAV', command=start)
    save_button.pack(anchor='e', pady=5)

    def poll() -> None:
        try:
            while True:
                kind, payload = events.get_nowait()
                if kind == 'progress':
                    progress.configure(value=payload)
                    status.set(f'Generowanie: {payload}%')
                else:
                    save_button.configure(state='normal')
                    if kind == 'done':
                        status.set(f'[DONE] Zapisano WAV, czas {float(payload):.2f} s.')
                    else:
                        status.set('Nie udało się zapisać WAV.')
                        messagebox.showerror('Błąd konwersji', str(payload))
        except queue.Empty:
            pass
        root.after(100, poll)

    refresh()
    root.after(100, poll)
    root.mainloop()


def main() -> None:
    parser = argparse.ArgumentParser(description='PNG → Robot SSTV (GUI lub CLI)')
    parser.add_argument('input', type=Path, nargs='?', help='Obraz PNG; brak argumentu otwiera GUI')
    parser.add_argument('-o', '--output', type=Path, help='Plik WAV')
    parser.add_argument('-m', '--mode', choices=MODES, default='robot36')
    parser.add_argument('--gui', action='store_true', help='Uruchom interfejs graficzny')
    args = parser.parse_args()
    if args.gui or args.input is None:
        launch_gui()
        return
    output = args.output or args.input.with_name(f'{args.input.stem}_{args.mode}.wav')
    try:
        duration = encode(args.input, output, args.mode)
    except (OSError, ValueError) as error:
        parser.exit(1, f'[FAIL] {error}\n')
    print(f'[DONE] {output} | {MODES[args.mode].name} | {duration:.3f} s')


if __name__ == '__main__':
    main()
