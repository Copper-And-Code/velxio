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
| `VELXIO_STM32_FB_FORMAT`     | auto da `L1PFCR` | Pixel format LTDC (override diagnostico)  |
| `VELXIO_STM32_FB_MAX_WIDTH`  | `0` con binary, `512` senza | Larghezza massima preview LTDC; `0` = full-res |
| `VELXIO_STM32_FB_BINARY`     | `1`         | Usa socket binario Renode per leggere SDRAM; `0` = solo monitor |
| `VELXIO_RENODE_BIN`          | `renode`    | Path al binario Renode                         |
| `VELXIO_RENODE_LOG`          | (off)       | Set per loggare anche stderr di Renode         |

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

Il poller framebuffer full-resolution legge **1.2 MB via Renode monitor TCP**
(che serializza i byte come testo "0xNN, "). Sotto carico GPIO poll + touch
write + Renode CPU emulation, un ciclo completo di poll può richiedere
**5–60 secondi** anziché i 300 ms nominali → la canvas si aggiorna
visibilmente in ritardo rispetto agli eventi handler che pure firano
correttamente nel REPL.

Con `VELXIO_STM32_FB_BINARY=1`, il default è full-resolution
(`VELXIO_STM32_FB_MAX_WIDTH=0`): il socket binario regge 1024×600 RGB565 e
non degrada i font LVGL con campionamento orizzontale. Quando il socket
binario è disabilitato, il default torna a `VELXIO_STM32_FB_MAX_WIDTH=512`:
il framebuffer reale resta 1024×600 e le coordinate touch sono ancora in
pixel reali, ma il trasporto verso il browser legge e spedisce una versione
campionata per evitare il costo del monitor testuale.

Quando `VELXIO_STM32_FB_BINARY=1`, Renode avvia anche un piccolo server TCP
locale (`renode/extensions/velxio_framebuffer_server.py`) che legge
`machine.SystemBus.ReadBytes` e restituisce byte raw con il protocollo
`VXFB/VXFR`. Il backend usa quel socket per `_read_memory`; se non è
disponibile o fallisce, torna automaticamente al monitor testuale.
Lo stesso socket viene usato anche per le scritture touch `WriteDoubleWord`,
serializzate con le letture framebuffer per non corrompere il protocollo.

Dopo il primo frame completo, il backend emette `framebuffer_patch` riga per
riga solo quando il contenuto campionato cambia. Il canvas viene aggiornato
subito alla ricezione della patch, senza aspettare la fine della scansione
successiva del framebuffer intero.

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
