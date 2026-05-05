# STM32H7 — Phase 1 brief (Velxio × Claude)

Snapshot dell'inizio del lavoro a quattro mani fatto sul branch `stm32-attempt`,
sessione iniziale del 28 aprile 2026 (`651b93a2-ff32-4b1c-ba79-7c7386ad6146`).
Documento storico, tenuto qui per ricostruire **perché** Phase 1 esiste in
questa forma. Per lo *stato* corrente delle scelte tecniche vedi
[`STM32H7_MANUAL_TEST.md`](STM32H7_MANUAL_TEST.md); per il riepilogo del
delivery vedi il tag git `claude/phase1-stm32h7`.

---

## 1. Prompt originale (Nunzio → Claude)

> quello che vorrei che tu facessi su questo repo è studiare la
> fattibilita' di aggiungere una nuova architettura basata su stm32H743 con
> 32Mbyte di sdram esterna su FMC e con LCD RGB 888 su LTDC e un display
> RGB 1024x600 come componente, oltre la seriale, micropython etc.

## 2. Chiarimenti sul perimetro (in risposta a 4 domande iniziali)

> 1. una board esatta di cui ti darò tutte le info,
> 2. il display è un RGB888 1024×600 su LTDC,
> 3. prima micropython ma io ho già pronto il codice C poiché ho contribuito al
>    progetto lv_micropython ed ho un repository git pronto:
>    [Copper-And-Code/lv_micropython](https://github.com/Copper-And-Code/lv_micropython) +
>    [Copper-And-Code/lv_binding_micropython](https://github.com/Copper-And-Code/lv_binding_micropython),
> 4. sì, è accettabile inizialmente aggiungere Renode.

## 3. Roadmap Phase 1 concordata

```
Fase 1 — Renode + UART REPL                     (≈2 settimane)
  ├── renode_manager.py (clone di qemu_manager.py)
  ├── .repl per la board specifica (STM32H743 core + clock + GPIO + USART)
  ├── BoardKind 'stm32-h7-core-v13' + asset board (SVG/JSON)
  ├── Bridge frontend Stm32H7Bridge.ts (WS + serial + GPIO)
  ├── Firmware loading via 'sysbus LoadELF'
  └── REPL MicroPython funzionante via Serial Monitor

Fase 2 — FMC SDRAM 32MB                          (3–5 giorni)
  ├── sdramBank1 in stm32h743.repl
  └── Verifica: LVGL alloca draw_buf in SDRAM senza fault

Fase 3 — LTDC framebuffer streaming              (3 settimane, rischio alto)
  ├── Verifica modello LTDC di Renode
  ├── Poller LTDC CFBAR/CFBLR + read SDRAM
  ├── Encoder backend → WebSocket → canvas frontend
  └── Test 1024×600 con LVGL reale

(Touch input, GPIO esterni, electrical sim — fasi successive)
```

Sostanziali differenze rispetto alla pianificazione iniziale, dopo il chiarimento:
- ❌ niente toolchain Arduino / STM32duino: tutto MicroPython
- ❌ nessun driver LTDC da scrivere (LVGL `flush_cb` di lv_binding già pronto)
- ❌ nessun pattern velxio-element tipo ILI9341 (era SPI command-stream; LTDC
  vuole un canale framebuffer raw)
- ✅ Effort totale rivisto da 9-11 a **6-8 settimane uomo**

## 4. Cosa è stato consegnato in Phase 1

Riferimento al tag annotato `claude/phase1-stm32h7` (commit
[`3a86ed2`](../../../commit/3a86ed2)). In sintesi:

- Board STM32H7_CORE V13 + .repl + RenodeManager backend
- UART REPL bidirezionale + raw-paste injection di `main.py` dall'editor
- GPIO bridge (poll porte A/B/C + OnGPIO injection da canvas)
- LTDC streaming pipeline 1024×600 RGB565, validato end-to-end con
  HAL CMSIS + LVGL
- Touch input via mailbox SDRAM (PointerEvents → `inject_touch` → indev LVGL)
- Cross-board interconnect routing per GPIO STM32H7
- Patch a lv_micropython (`VERSION="VELXIO"` + GT911 skip in Renode)

**Limite portato in Phase 2:**
- Throughput poll framebuffer 1.2 MB tramite Renode TCP monitor è limitato
  a 5–60 s/frame sotto carico — mitigazioni candidate documentate in
  [`STM32H7_MANUAL_TEST.md` §8.5](STM32H7_MANUAL_TEST.md#85-limiti-noti-di-throughput).

## 5. Memorie progetto associate

Le memorie persistenti di Claude relative a questo lavoro (visibili al solo
utente, sotto `~/.claude/projects/-opt-github-velxio/memory/`):

- `project_stm32h743_initiative.md` — descrizione iniziale del progetto
- `project_stm32h743_core_hardware.md` — memory map, clock, SDRAM, LTDC, GT911,
  V10 vs V13
- `project_renode_bringup.md` — fix `.repl` per il boot del firmware H7
- `project_renode_ltdc_quirks.md` — offset LTDC corretti per RM0433
- `project_renode_ltdc_hal_quirk.md` — HAL CMSIS + LVGL: il "quirk" era un bug
  di offset nel backend
- `project_velxio_dual_board_picker.md` — `BoardPickerModal` + `ComponentPickerModal`
- `project_renode_pty_echo_loop.md` — `pty.openpty()` ECHO+ICANON loopa l'UART
- `user_profile.md` — Nunzio: contributor lv_micropython, expertise STM32H7+LVGL+FMC+LTDC

## 6. Sessioni di lavoro

| Sessione                                         | Data         | Focus                                        |
|--------------------------------------------------|--------------|----------------------------------------------|
| `651b93a2-ff32-4b1c-ba79-7c7386ad6146`           | 28 apr 2026  | Bring-up Renode + UART + SDRAM + LTDC         |
| `c08efcef-fdec-419c-ad4e-7ab3592ad333`           | 30 apr 2026  | LTDC pipeline + GPIO bridge + cross-board     |
| `4814dd7a-a7c5-4f17-b172-3859dd411919`           | 5 mag 2026   | LVGL completo + touch input + Phase 1 close   |
