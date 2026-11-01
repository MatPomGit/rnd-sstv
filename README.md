# rnd-sstv

## Aplikacja na Android (PWA)

**Mobilna aplikacja akustyczna**: [instrukcja](docs/mobile.md) · [kod PWA](mobile/) · [instalacja z GitHub Pages](https://matpomgit.github.io/rnd-sstv/).

Obejmuje nadawanie/odbiór WAV i mikrofon, SSTV Robot, cyfrowy FSK/MFSK/OFDM/chirp, tekst, małe pliki oraz cyfrowe JPEG z CRC32 i Hamming(7,4). Eksperymentalna łączność akustyczna przez **dwa telefony**, bez serwera. Mikrofon wymaga HTTPS; Pages trzeba włączyć w ustawieniach repozytorium. Własny MFSK nie jest kompatybilny z ggwave.

Program w Pythonie do konwersji obrazów PNG na analogowy sygnał SSTV Robot, zapisywany jako WAV 48 kHz / 16-bit / mono. Udostępnia GUI (Tkinter) i CLI.

## Obsługiwane tryby

| Tryb | VIS | Obraz | Czas obrazu | Kolor |
| --- | ---: | ---: | ---: | --- |
| Robot12 | 0 | 160 × 120 | 12,00 s | YCbCr, chrominancja co drugą linię |
| Robot24 | 4 | 320 × 120 | 24,00 s | YCbCr, Cr i Cb w każdej linii |
| Robot36 | 8 | 320 × 240 | 36,00 s | YCbCr, chrominancja co drugą linię |
| Robot B/W8 | 2 | 160 × 120 | 7,92 s | Monochromatyczny |

Do czasu obrazu dochodzi 0,91 s nagłówka VIS. Robot12 ma sekwencję 7 ms synchronizacji, 60 ms luminancji, 3 ms separatora chrominancji i 30 ms chrominancji. Robot24 i Robot36 korzystają z separatorów 1500/2300 Hz i pasma obrazu 1500–2300 Hz.

## Instalacja

Python 3.10+ z Tkinter. Na niektórych dystrybucjach Linux trzeba doinstalować pakiet python3-tk.

    python -m pip install -r requirements.txt
    python sstv.py

W GUI wybierz PNG, tryb transmisji i lokalizację zapisu WAV, następnie Generuj WAV. GUI pokazuje obraz oraz postęp. Skalowanie zachowuje proporcje, w razie potrzeby dodając pasy. Przezroczystość PNG jest kompozytowana na białym tle.

## CLI

    python sstv.py obraz.png -m robot12 -o transmisja.wav
    python sstv.py obraz.png -m robot24
    python sstv.py obraz.png -m robot36
    python sstv.py obraz.png -m bw8

## Testy

    python -m unittest discover -s tests -v

Testy sprawdzają cztery tryby, długość WAV, format PCM, kody VIS, kanał alfa PNG i zachowanie pliku docelowego przy błędzie. Nie zastępują weryfikacji odbioru przez zewnętrzny dekoder SSTV.

## Źródła parametrów

- [OK2MNM, SSTV Handbook, rozdział 4](https://www.sstv-handbook.com/download/sstv-handbook.pdf)
- [libsstv](https://github.com/rimio/libsstv), referencja protokołu (MIT)

Uwaga: emisja radiowa wymaga przestrzegania przepisów dotyczących częstotliwości i uprawnień operatora.
