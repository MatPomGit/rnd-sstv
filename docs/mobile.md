# Acoustic Lab: modem dźwiękowy na Androida

Aplikacja webowa PWA `mobile/index.html` działa w Chrome na Androidzie, także na Samsungu Galaxy S25 Ultra. Korzysta z głośnika, mikrofonu i pamięci telefonu bez konta i backendu.

## Instalacja i użycie

1. Włącz **Settings → Pages → Build and deployment → GitHub Actions** (jednorazowo).
2. Wejdź na `https://matpomgit.github.io/rnd-sstv/` i użyj w Chrome funkcji „Dodaj do ekranu głównego”.
3. Wybierz SSTV albo modem cyfrowy, wybierz tryb i obraz, wiadomość lub plik. Wygeneruj WAV i użyj „Odtwórz”.
4. Na drugim telefonie wybierz ten sam tryb i zacznij nagrywanie mikrofonu **przed** odtworzeniem. Po zakończeniu zatrzymaj, aby zdekodować. Alternatywnie wczytaj WAV.

## Obsługiwane tryby

- SSTV: Robot12, Robot24, Robot36, B/W8. Kodowanie i eksperymentalne dekodowanie.
- FSK: 1200/2200 Hz.
- MFSK-4: 1000, 1600, 2200, 2800 Hz.
- **ggwave** Audible Fast/Normal i eksperymentalny Ultrasound: zgodne z protokołem ggwave, implementacja [ggwave-js](https://github.com/themonnie/ggwave-js) na licencji MIT (lokalnie w mobile/vendor), z korekcją Reed-Solomon. Tryb ten przesyła tekst do 128 B; obrazy/pliki wysyłaj przez własny OFDM.
- OFDM/DBPSK: 12 podnośnych 900–4200 Hz. Niezależny protokół eksperymentalny.
- Chirp/CSS: modulacja binarna liniowym przebiegiem częstotliwości, eksperymentalna.
- MFSK 17–18,5 kHz: tryb eksperymentalny, może nie działać przez filtry hardware'u.
- Tekst, niewielkie pliki oraz cyfrowe obrazy JPEG, automatycznie kompresowane do limitu 4096 bajtów.
- Odbiór poprzez mikrofon lub wczytany WAV, dekodowanie po nagraniu.
- Nagłówek 1900 Hz 300 ms + 1200 Hz 100 ms. Ramka RDS1 z CRC32 i opcjonalną korekcją Hamming(7,4). Nagłówek zawsze jest chroniony FEC.
- Szczegóły ramki: magic(4), wersja(1), typ(1), FEC(1), rozmiar(2), CRC32(4), payload.

Własny MFSK **nie jest interoperacyjny z ggwave**. Osobna pozycja `ggwave` jest zgodna z interoperacyjnym protokołem. Plik `mobile/vendor/LICENSE.ggwave-js` zawiera pełny tekst licencji portu. Własny OFDM nie jest zgodny z zewnętrznymi modemami. Dobór tych protokołów ma charakter laboratoryjny.

## Sprzęt i bezpieczeństwo

Domyślnie używane jest próbkowanie 48 kHz, ale API Androida może wybrać inne, dekoder uwzględnia próbki rzeczywiste. Browser API żąda wyłączenia echoCancellation/noiseSuppression/autoGainControl, jednak system nie musi respektować żądania. Głośnik i mikrofon nie przenoszą niezawodnie wysokich częstotliwości. Odbiornik wymaga HTTPS i uprawnienia mikrofonu, strona musi pozostać otwarta podczas nagrania. Maksimum nagrania: 180 sekund.

Najpierw przetestuj słyszalny MFSK, dystans około 10–50 cm i umiarkowaną głośność. Ultradźwięków nie traktuj jako gotowego kanału. Nie słuchaj dźwięku testowego z bliskiej odległości przy wysokim poziomie głośności.

PWA działa bez serwera po pierwszym załadowaniu. Dwa telefony wymagane są do niezależnej transmisji akustycznej; jeden telefon może testować pliki WAV.

## Testy

```sh
node --test tests/mobile.test.mjs
```

Testy obejmują roundtrip modemów, FEC/CRC, WAV oraz czas SSTV. Odbiór przez realny mikrofon oraz zgodność analogowego SSTV wymagają pomiarów na sprzęcie. Nie zakładamy niezawodności przed próbami terenowymi.
