# STM32H7 + LTDC + Touch — Test manuale

Guida passo-passo per validare manualmente la pipeline grafica e di
interazione (Renode → backend → WebSocket → canvas frontend → mailbox
touch → LVGL indev) sulla board `stm32-h7-core-v13`.

Tutto è validato sul branch **`stm32-attempt`** del repo `velxio`.

---

## 1. Prerequisiti

### 1.1 Renode 1.16+
```bash
renode --version
```
Se manca:
```bash
wget https://builds.renode.io/renode-latest.linux-portable.tar.gz
tar xf renode-latest.linux-portable.tar.gz -C /opt/
sudo ln -s /opt/renode_*-portable/renode /usr/local/bin/renode
```

### 1.2 Python deps backend
```bash
cd /opt/github/velxio/backend
pip install -r requirements.txt
pip install python-jose[cryptography] passlib[bcrypt]==1.7.4 'bcrypt==4.0.1' email-validator
```

### 1.3 Node deps frontend
```bash
cd /opt/github/velxio/frontend
npm install
```

### 1.4 Firmware MicroPython per STM32H7_CORE
Il path del firmware è hard-coded nel template `.resc` generato da
`renode_manager.py`:
```bash
ls /opt/github/lv_micropython/ports/stm32/build-STM32H7_CORE-VELXIO/firmware.elf
```
Per il **path LVGL touch** (sezione 8) servono tre patch nel repo
`lv_micropython` (sotto `user_modules/lv_binding_micropython/driver/stm32/st_ltdc/`):

- `boards.py` → aggiungere classe `STM32H743_CORE_VELXIO` (clone di V13 con
  tutti i `TP_*_PIN = ""` per saltare il GT911 in Renode)
- `display_conf.py` → branch `elif VERSION == "VELXIO": from boards import STM32H743_CORE_VELXIO as board`
- `st_ltdc_utils.py` → wrappare il blocco touch in `if getattr(board, 'TP_INT_PIN', '') != '':`

Poi rebuild:
```bash
cd /opt/github/lv_micropython/ports/stm32
make BOARD=STM32H7_CORE BOARD_VARIANT=VELXIO -j$(nproc)
```

---

## 2. Test 1 — smoke test backend (consigliato come primo step)

Bypassa WebSocket/uvicorn e parla direttamente con `RenodeManager`.

```bash
cd /opt/github/velxio/backend
pkill -9 -f Renode.dll 2>/dev/null
python3 -u test_stm32_framebuffer.py
```

### Cosa fa
1. Avvia `RenodeManager.start_instance` per la board `stm32-h7-core-v13`.
2. Aspetta il prompt `>>>` di MicroPython sulla USART1 virtuale (≤60 s).
3. Invia in **raw paste mode** (Ctrl-E … Ctrl-D) uno script che programma
   un layer LTDC 32×8 RGB565 a `0xC0000000` con un gradient
   (`v = (i * 73) & 0xffff`).
4. Stampa un dump diagnostico dei registri LTDC via monitor.
5. Aspetta fino a 30 s un evento `framebuffer` dal poller.

### Output atteso (PASS)
```
LTDC primed
>>>   reg GCR     @ 0x50001018 = 0x00000001
  reg L1CR        @ 0x50001084 = 0x00000001
  reg L1CFBAR     @ 0x500010ac = 0xc0000000
  reg L1CFBLR     @ 0x500010b0 = 0x00400043
  reg L1CFBLNR    @ 0x500010b4 = 0x00000008
  reg L1PFCR      @ 0x50001094 = 0x00000002

[framebuffer] width=32 height=8 fmt=rgb565 pitch=64 b64_len=684
  raw bytes=512 first16=000049009200db0024016d01b601ff01
PASS
```

I primi 16 byte devono essere la sequenza `i*73 (mod 65536)` little-endian:
`00 00 | 49 00 | 92 00 | db 00 | 24 01 | 6d 01 | b6 01 | ff 01` ✓

### FAIL: cosa controllare
| Sintomo                                       | Probabile causa                              |
|-----------------------------------------------|----------------------------------------------|
| `FAIL: no REPL prompt within 60s`             | Firmware non avvia: log Renode in stdout    |
| Stampa registri ma `no framebuffer event`     | Il poller non trova il framebuffer — verifica `CFBAR == 0xC0000000` |
| `EXC: ...`                                    | Bug Python lato backend                       |
| Renode si pianta in boot                      | `pkill -9 -f Renode.dll`, riprova            |

---

## 3. Test 2 — backend + frontend, integrazione WebSocket

### 3.1 Avvia il backend
```bash
cd /opt/github/velxio/backend
uvicorn app.main:app --reload --port 8001
```

### 3.2 Avvia il frontend
```bash
cd /opt/github/velxio/frontend
npm run dev
```

### 3.3 Aggiungi la board STM32H7
1. Click su **Add Board** (header simulator, modal `BoardPickerModal`).
2. Seleziona **STM32H743 Cortex-M7 480MHz, 32MB SDRAM, 1024×600 LTDC (Renode)**
   (key `stm32-h7-core-v13`).
3. Drag-and-drop sul canvas.

### 3.4 Avvia la simulazione
1. Click su **Run** (▶) della board.
2. Apri **Serial Monitor**.
3. Aspetta il banner MicroPython e il prompt `>>>` (10–30 s al primo avvio).

### 3.5 Pilota LTDC dal Serial Monitor
Nel Serial Monitor, attiva paste-mode con Ctrl-E e incolla:

```python
import stm
stm.mem32[0x50001094] = 2                       # L1PFCR = RGB565
stm.mem32[0x500010ac] = 0xC0000000              # L1CFBAR
stm.mem32[0x500010b0] = (64 << 16) | 67         # L1CFBLR  pitch=64 line=64+3
stm.mem32[0x500010b4] = 8                       # L1CFBLNR  height=8
stm.mem32[0x50001084] = 1                       # L1CR.LEN = 1
stm.mem32[0x50001024] = 1                       # SRCR.IMR = 1 (commit shadow)
stm.mem32[0x50001018] = 1                       # GCR.LTDCEN = 1
for i in range(256):
    v = (i * 73) & 0xffff
    stm.mem8[0xC0000000 + i*2]     = v & 0xff
    stm.mem8[0xC0000000 + i*2 + 1] = (v >> 8) & 0xff
print("LTDC primed")
```

Premi Ctrl-D per eseguire.

### 3.6 Verifica visiva
Sopra la board sul canvas, riquadro 32×8 con gradient blu/verde/viola.
Pixel singoli visibili grazie a `image-rendering: pixelated`.

### 3.7 Test "vero" con LVGL (richiede patch lv_micropython 1.4)
```python
import lvgl as lv
import display_driver
scr = lv.screen_active()
scr.set_style_bg_color(lv.color_hex(0x404080), 0)
scr.set_style_bg_opa(255, 0)
btn = lv.button(scr); btn.set_size(200, 80); btn.center()
lbl = lv.label(btn); lbl.set_text("Velxio + LVGL"); lbl.center()
disp = lv.display_get_default()
for _ in range(60):
    scr.invalidate(); lv.tick_inc(20); lv.timer_handler(); lv.refr_now(disp)
```

---

## 4. Variabili d'ambiente utili

| Var                          | Default     | Descrizione                                    |
|------------------------------|-------------|------------------------------------------------|
| `VELXIO_STM32_FB_POLL_MS`    | `300`       | Cadenza di polling LTDC (ms)                   |
| `VELXIO_STM32_FB_FAST_POLL_MS` | `80`      | Cadenza LTDC temporanea dopo touch/GPIO        |
| `VELXIO_STM32_FB_FAST_WINDOW_MS` | `1200`  | Durata della finestra fast dopo input utente   |
| `VELXIO_STM32_FB_FORMAT`     | auto da `L1PFCR` | Pixel format LTDC (override diagnostico)  |
| `VELXIO_STM32_FB_MAX_WIDTH`  | `0` con binary, `512` senza | Larghezza massima preview LTDC; `0` = full-res |
| `VELXIO_STM32_FB_BAND_ROWS`  | `16`        | Altezza delle bande full-res usate per diff/patch framebuffer |
| `VELXIO_STM32_FB_BINARY`     | `1`         | Usa socket binario Renode per leggere SDRAM; `0` = solo monitor |
| `RENODE_BIN`                 | `renode`    | Path al binario Renode                         |
| `STM32H7_CORE_FIRMWARE`      | path locale lv_micropython | Path al firmware ELF STM32H7 |
| `VELXIO_REPO_ROOT`           | root repo rilevata dal backend | Root che contiene `renode/` |
| `VELXIO_STM32_PTY`           | `1`         | Abilita symlink PTY per debug esterno (`0` in Docker) |
| `VELXIO_RENODE_LOG`          | (off)       | Set per loggare anche stderr di Renode         |

Il socket binario framebuffer/touch viene ritentato automaticamente dopo
errori transitori. Un fallimento iniziale non disabilita piu' il path binario
per tutta la sessione: il backend usa il monitor testuale come fallback e
riprova il socket dopo un breve backoff.

---

## 5. Memory map STM32H7 LTDC (riferimento)

Offset Layer1 corretti per H743 secondo RM0433 / CMSIS `stm32h743xx.h`:

| Reg          | Offset assoluto | Bit rilevanti                          |
|--------------|-----------------|----------------------------------------|
| `LTDC_GCR`   | `0x50001018`    | `[0]` = LTDCEN                         |
| `LTDC_SRCR`  | `0x50001024`    | `[0]` = IMR (commit shadow)            |
| `LTDC_L1CR`  | `0x50001084`    | `[0]` = LEN (layer enable)             |
| `LTDC_L1PFCR`| `0x50001094`    | `[2:0]` = pixel format (RGB565=2)      |
| `LTDC_L1CFBAR`| `0x500010AC`   | framebuffer base address                |
| `LTDC_L1CFBLR`| `0x500010B0`   | `[28:16]` = pitch, `[12:0]` = line_len_bytes+3 (HAL CMSIS scrive +7) |
| `LTDC_L1CFBLNR`| `0x500010B4`  | `[10:0]` = numero righe                |

> **Nota storica:** versioni precedenti del backend usavano gli offset
> `0x100/0x110/0x12C/0x130/0x134` (presi da Layer2 / CMSIS errato). Renode
> trattava quegli indirizzi come fake memory, dando l'illusione di un
> "quirk LTDC" che in realtà era un bug nostro. Vedi memoria progetto
> `project_renode_ltdc_quirks.md`.

---

## 6. Cleanup

```bash
pkill -9 -f Renode.dll
rm -f /tmp/velxio_renode_*.resc
```

---

## 7. File rilevanti

| Cosa                                      | Path                                                                          |
|-------------------------------------------|-------------------------------------------------------------------------------|
| Smoke test backend (LTDC)                 | `backend/test_stm32_framebuffer.py`                                           |
| Smoke test backend (touch mailbox)        | `backend/test_ltdc_monitor_write.py`                                          |
| WebSocket integration test                | `backend/test_stm32_websocket.py`                                             |
| Poller LTDC                               | `backend/app/services/renode_manager.py` (`_poll_framebuffer_loop`)           |
| Touch mailbox + inject_touch              | `backend/app/services/renode_manager.py` (`TOUCH_MAILBOX`, `inject_touch`)    |
| WS handler `stm32_touch_input`            | `backend/app/api/routes/simulation.py`                                        |
| Bridge frontend                           | `frontend/src/simulation/Stm32H7Bridge.ts`                                    |
| Display canvas + mouse handlers           | `frontend/src/components/simulator/Stm32H7Display.tsx`                        |
| Demo touch (esempio runnable)             | `docs/examples/stm32h7_touch_demo.py`                                         |

---

## 8. Touch input — mailbox SDRAM

### 8.1 Architettura

Renode non emula il touch controller GT911. Il path scelto è una mailbox
SDRAM condivisa fra backend e MicroPython:

```
browser canvas mouse event
        │ (PointerDown/Move/Up)
        ▼
Stm32H7Display.forwardTouch()
        │ map CSS px → display px (1024×600), throttle 30 Hz
        ▼
Stm32H7Bridge.sendTouch(x, y, pressed)
        │ WS frame { type: 'stm32_touch_input', data: {x, y, pressed} }
        ▼
simulation.py route
        │
        ▼
RenodeManager.inject_touch(client_id, x, y, pressed)
        │ 4× sysbus WriteDoubleWord (x, y, seq, pressed - in quest'ordine)
        ▼
SDRAM @ 0xC1F00000
        │
        ▼
read_velxio_touch (custom LVGL indev nel main.py utente)
        │ stm.mem32[0xC1F00000+offset]
        ▼
LVGL processing → widget event
```

### 8.2 Layout mailbox @ `0xC1F00000`

| Offset  | Tipo    | Significato                              |
|---------|---------|------------------------------------------|
| `+0x00` | uint32  | `pressed` (0 = release, 1 = press)       |
| `+0x04` | uint32  | `x` in display pixel (0..1023)           |
| `+0x08` | uint32  | `y` in display pixel (0..599)            |
| `+0x0C` | uint32  | `seqno` (incrementato per write distinta) |

L'indirizzo è in **SDRAM** perché:
- `sramBank1` (FMC `0x60000000`) richiede l'inizializzazione del controller
  FMC bank 1 dal firmware, che lv_micropython non fa: `stm.mem32` da CPU
  hardfaulta o legge garbage.
- SDRAM (`0xC0000000`+) è inizializzata al boot per il framebuffer LVGL,
  quindi è sempre accessibile dalla CPU.
- `0xC1F00000` = 31 MB dentro la SDRAM da 32 MB → ben oltre il pool di
  allocazione LVGL che cresce da `0xC0000000`.

### 8.3 Ordine di scrittura nel backend

`inject_touch` scrive nell'ordine **`x → y → seq → pressed`**, tenendo il
flag `pressed` come ultimo. Questo garantisce che il read non-atomico
lato MicroPython non veda mai uno stato `pressed=1` con coordinate
ancora stantie — evita falsi eventi "press at (0,0)" che LVGL classificherebbe
come drag-da-fuori-widget e che farebbero fallire il click detection.

Inoltre il backend deduplica: se `(x, y, pressed)` è identico al last-seen
per quell'istanza, salta la scrittura → niente flood del monitor durante
hover/static.

### 8.4 Single buffer mode (workaround visivo)

Il `display_driver` di lv_micropython configura LVGL in DIRECT mode con
**due buffer alternati**. LTDC scansiona uno alla volta, mentre LVGL
renderizza nell'altro. Sul real HW lo swap avviene su vsync; in Renode
il poller backend legge il buffer attualmente puntato da CFBAR — che
spesso è quello *non aggiornato*. Risultato: i widget appaiono al boot
ma le modifiche post-evento non si vedono.

Il demo bypassa il problema rifacendo `disp_drv.set_buffers(buf1, None, ...)`
in single-buffer mode subito dopo `import display_driver`. LTDC e LVGL
condividono lo stesso buffer → ogni cambio è immediatamente visibile.

### 8.5 Limiti noti di throughput

Il path preferito e' il socket binario Renode (`VELXIO_STM32_FB_BINARY=1`):
un frame RGB565 full-resolution e' 1024 x 600 x 2 = 1.2 MB raw, letto con
`machine.SystemBus.ReadBytes` e spedito al backend senza serializzazione
testuale. In questa modalita' il default resta full-resolution
(`VELXIO_STM32_FB_MAX_WIDTH=0`) per evitare artefatti sui font LVGL.

Il fallback via monitor TCP resta disponibile ma e' molto piu' lento:
Renode serializza i byte come testo `0xNN,`, quindi 1.2 MB raw diventano
diversi MB di risposta monitor. In fallback conviene lasciare
`VELXIO_STM32_FB_MAX_WIDTH=512` o abbassarlo ancora.

Quando `VELXIO_STM32_FB_BINARY=1`, Renode avvia anche un piccolo server TCP
locale (`renode/extensions/velxio_framebuffer_server.py`) che legge
`machine.SystemBus.ReadBytes` e restituisce byte raw con il protocollo
`VXFB/VXFR`. Il backend usa quel socket per `_read_memory`; se non è
disponibile o fallisce, torna automaticamente al monitor testuale.
Lo stesso server espone anche `VXDW` per `WriteDoubleWord` touch. Il server
serializza gli accessi a `sysbus` con un lock interno, cosi' letture
framebuffer e scritture mailbox concorrenti non corrono una contro l'altra
dentro Renode.

Dopo il primo frame completo, il backend mantiene una cache del framebuffer.
In preview scalata emette `framebuffer_patch` riga per riga quando il contenuto
campionato cambia; in full-resolution legge il framebuffer a bande
configurabili (`VELXIO_STM32_FB_BAND_ROWS`, default 16 righe) e invia solo le
bande mutate. Per il path full-resolution il backend calcola anche il
rettangolo orizzontale minimo cambiato dentro la banda: una label o una barra
non costringono piu' a spedire 1024 pixel per ogni riga toccata. Il canvas
viene aggiornato subito alla ricezione della patch, senza dover ricevere e
decodificare ogni volta un frame 1024x600 completo.
Il fallback a frame completo ora dipende dai byte che le patch invierebbero,
non dal solo numero di righe cambiate: aggiornamenti stretti ma alti, come
cursori o testo verticale, restano patch parziali.
Il frontend accoda le patch arrivate nello stesso intervallo di rendering del
browser e le applica al canvas con `requestAnimationFrame`, evitando piu'
paint consecutivi quando un singolo poll produce vari rettangoli.

La board STM32H7 nel canvas mostra anche una piccola telemetria LTDC in basso
a sinistra dello schermo. I campi sono aggregati circa ogni secondo:

| Campo | Significato |
|-------|-------------|
| `poll` | cicli di scansione LTDC completati nel backend |
| `full` | frame completi inviati al frontend |
| `patch` | patch parziali inviate al frontend |
| `idle` / `Nr` | nessuna riga cambiata oppure numero di righe cambiate |
| `kB` | payload raw inviato prima della codifica base64 |
| `ms` | tempo cumulativo speso nella scansione framebuffer |
| `300ms` | cadenza configurata da `VELXIO_STM32_FB_POLL_MS` |
| formato | pixel format LTDC rilevato, ad esempio `rgb565` o `rgb888` |

Questa telemetria distingue un problema di esempio LVGL (molte righe cambiate
o frame completi frequenti) da un limite del trasporto Renode (pochi update ma
tempo di scansione alto).

Dopo un input touch o GPIO esterno il backend risveglia subito il poller e
usa temporaneamente `VELXIO_STM32_FB_FAST_POLL_MS`. Questo riduce la latenza
percepita click -> widget senza tenere il framebuffer in scansione veloce
quando la UI e' ferma.

Questa ottimizzazione riduce soprattutto WebSocket/base64/decode/canvas paint.
Il backend deve comunque scansionare la SDRAM per scoprire cosa e' cambiato;
la fase successiva per un salto piu' netto e' far pubblicare a LVGL i dirty
rect reali dal `flush_cb`.

Mitigazioni:
- Abbassare `VELXIO_STM32_FB_MAX_WIDTH` (es. `384` o `256`) se serve più
  interattività della preview
- Aumentare `VELXIO_STM32_FB_POLL_MS=2000`+ per ridurre il numero di
  letture concorrenti
- Implementare protocollo dirty-rect (LVGL flush_cb pubblica solo le
  rect modificate, backend legge frammenti)
- Usare un peripheral C# custom in Renode per esporre la SDRAM su un
  socket binario (aggira il monitor)

### 8.6 Demo runnable

Vedi `docs/examples/stm32h7_touch_demo.py`. Per eseguirlo:

```bash
# Terminale 1: avvia backend + frontend, click Run sulla board nel browser
# Terminale 2:
mpremote connect /tmp/velxio-stm32-stm32-h7-core-v13.pty run docs/examples/stm32h7_touch_demo.py
```

Click sul canvas browser → bottone incrementa contatore, slider segue
il drag.

Il driver LTDC Velxio supporta tre modalita' selezionabili dallo script
MicroPython prima di `import display_driver`:

```python
LTDC_RENDER_MODE = "direct_single"  # latenza minore, un framebuffer DIRECT
LTDC_RENDER_MODE = "partial"        # dirty-rect su schermate semplici RGB565
LTDC_PARTIAL_LINES = 200            # altezza dei draw buffer in partial
```

La board usa `partial` come default firmware per il driver comune RGB565,
mentre i demo touch/roundtrip forzano `direct_single` per privilegiare la
reazione click → widget. `advanced_demo.py` ha invece un init LTDC proprio in
RGB888 e resta su `direct` a doppio framebuffer: su quel demo `direct_single`
mostra tearing, mentre il path `partial` RGB888 non e' ancora affidabile.

### 8.7 Demo GPIO + LVGL roundtrip

Vedi `docs/examples/stm32h7_led_button_roundtrip.py`. L'esempio valida il
percorso completo fra canvas, GPIO STM32H7 e LVGL:

- bottone LVGL sul display → `Pin("A9", OUT)` → LED esterno su `PA9`
- pushbutton esterno → `Pin("A0", IN)` → label/bar sul display

Cablaggio consigliato nel canvas:

| Componente | Pin componente | Pin STM32H7 |
|------------|----------------|-------------|
| LED        | anodo          | `PA9`       |
| LED        | catodo         | `GND.1`     |
| Pushbutton | un lato        | `3V3`       |
| Pushbutton | altro lato     | `PA0`       |

Con questo cablaggio il pushbutton e' active-high. La simulazione del
pushbutton sceglie il GPIO reale collegato al componente e usa il rail
presente sull'altro lato per decidere il livello da inviare: `3V3/5V` porta
il GPIO HIGH alla pressione, `GND` lo porta LOW. Questo evita che il componente
scambi un rail per il pin da pilotare.

L'esempio forza un solo render iniziale (`lv.timer_handler()` +
`lv.refr_now()`), senza il vecchio warm-up a decine di refresh. Sul path
Renode/LTDC i refresh ripetuti all'avvio sono visibili e peggiorano la
percezione di latenza.

Esecuzione diretta via PTY:

```bash
mpremote connect /tmp/velxio-stm32-stm32-h7-core-v13.pty run docs/examples/stm32h7_led_button_roundtrip.py
```

### 8.8 Oscilloscopio / logic analyzer

Il pannello **Scope** usa la stessa mappa pin visibile sulla board STM32H7,
non il fallback Arduino. I canali selezionabili sono:

```text
PA9 PA10 PA0 PA3 PA4 PA5 PA6 PA7 PB7 PB15
PB8 PB9 PB10 PB11 PC0 PC1 PC2 PC3 PC13 PC14
```

Internamente questi pin usano la stessa codifica del `PinManager`:
`PA0 = 0`, `PA15 = 15`, `PB0 = 16`, ..., `PC0 = 32`.
Questo e' importante perche' gli eventi Renode arrivano come
`stm32_gpio_change { port, pin, value }`, mentre il resto del frontend lavora
con un singolo numero pin.

Lo scope riceve campioni da due percorsi:

- output firmware STM32H7, tramite `stm32_gpio_change` dal backend Renode
- input esterni generati dal canvas, tramite `setPinState()` dello shim STM32H7

Nel demo roundtrip conviene aggiungere `PA9` e `PA0`: `PA9` mostra il LED
pilotato dal bottone LVGL, `PA0` mostra la pressione del pushbutton esterno.

Limite noto: i timestamp STM32H7 sono basati sul tempo browser relativo alla
creazione della bridge, non su cicli MCU. Lo scope e' quindi utile per
transizioni lente e debug GPIO/logico, non per misure temporali fini o PWM
veloce.

### 8.9 Esecuzione da editor Velxio

Il toolbar dell'editor supporta il workflow locale via File System Access API
su Chrome/Edge:

1. Menu `...` → **Open local file**
2. Seleziona `docs/examples/stm32h7_touch_demo.py` o
   `docs/examples/advanced_demo.py`
3. Verifica che il tab aperto sia quello attivo
4. Premi **Run** sulla board STM32H7

Per MicroPython, Velxio invia come entrypoint il file attivo nel workspace
della board, non sempre `main.py`. Questo permette di aprire piu' esempi e
scegliere cosa eseguire semplicemente cambiando tab.

Il trasferimento del codice verso STM32H7 usa il protocollo **MicroPython
raw-paste**:

- attende banner REPL e prompt
- entra in raw REPL con Ctrl-A
- negozia raw-paste con Ctrl-E `A` Ctrl-A
- rispetta la finestra di ricezione comunicata dal firmware
- invia chunk fino a `512` byte, comunque limitati dal flow-control
- chiude con Ctrl-D

Questo e' piu' affidabile del vecchio invio "a tempo" nel raw REPL: script
lunghi come `advanced_demo.py` mantengono indentazione e boundary di riga.
Se il firmware non supporta raw-paste, il bridge torna al fallback lento a
chunk piccoli.

Il comando **Save local file** salva nello stesso handle locale quando il file
e' stato aperto da disco. Se il file non ha ancora un handle locale, apre un
picker "save as". In caso di errore durante la scrittura, il writer viene
abortito per evitare file parziali.

Il menu contiene anche **Save project file** e **Load project file** per
salvare/caricare localmente l'intero progetto Velxio (`*.velxio.json`):
board, componenti, fili, file group dell'editor e VFS Raspberry Pi. Dopo un
load locale, le board vengono ricreate con nuovi runtime bridge e i file group
vengono normalizzati per mantenere coerenti tab aperti, file attivo ed
entrypoint MicroPython. Sul backend STM32H7, lo shutdown Renode non puo' piu'
cancellare una nuova istanza avviata con lo stesso id mentre una task vecchia
sta finendo la chiusura.
