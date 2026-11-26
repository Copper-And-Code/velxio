# STM32H7 future examples

Backlog di esempi futuri per la board STM32H743 CORE V13 in Velxio:
Renode, lv_micropython, LTDC 1024x600, LVGL, touch mailbox e integrazione con
canvas/serial monitor.

## Priorita' iniziale

Questi sono i primi esempi consigliati per coprire debug, affidabilita' e demo
visive:

1. `stm32h7_ltdc_color_bars.py`
2. `stm32h7_touch_raw_viewer.py`
3. `stm32h7_lvgl_widgets_basic.py`
4. `stm32h7_touch_buttons.py`
5. `stm32h7_perf_touch_latency.py`
6. `stm32h7_hmi_panel.py`

## Esempi base

| File proposto | Scopo |
| --- | --- |
| `stm32h7_blink.py` | LED onboard PB1, test minimo GPIO. |
| `stm32h7_serial_counter.py` | Stampa periodica su REPL/Serial Monitor. |
| `stm32h7_gpio_output_demo.py` | Toggle su PA/PB/PC esposti, utile con LED esterni. |
| `stm32h7_gpio_input_button.py` | Pulsante esterno su un pin GPIO, con debounce software. |
| `stm32h7_led_button_roundtrip.py` | Input touch o GPIO che aggiorna LED e label LVGL. |

## Display LTDC / framebuffer

| File proposto | Scopo |
| --- | --- |
| `stm32h7_ltdc_color_bars.py` | Barre RGB888/RGB565 per validare colori e formato pixel. |
| `stm32h7_ltdc_gradient.py` | Gradienti e rettangoli per trovare problemi di stride o endianness. |
| `stm32h7_ltdc_partial_update.py` | Aggiornamento di piccole aree per testare performance e artefatti. |
| `stm32h7_ltdc_fps_meter.py` | Contatore FPS/refresh visivo. |
| `stm32h7_ltdc_double_buffer.py` | Confronto single/double/direct buffer. |

## LVGL

| File proposto | Scopo |
| --- | --- |
| `stm32h7_lvgl_widgets_basic.py` | Label, button, slider e checkbox. |
| `stm32h7_lvgl_styles.py` | Temi, font, colori e bordi. |
| `stm32h7_lvgl_layouts.py` | Flex/grid layout responsive su 1024x600. |
| `stm32h7_lvgl_meter.py` | Gauge/meter animato. |
| `stm32h7_lvgl_chart.py` | Grafico realtime con dati sintetici. |
| `stm32h7_lvgl_keyboard_textarea.py` | Textarea con tastiera virtuale. |
| `stm32h7_lvgl_tabview.py` | Piu' schermate con tab. |

## Touch

| File proposto | Scopo |
| --- | --- |
| `stm32h7_touch_raw_viewer.py` | Mostra x/y/pressed/seqno dalla touch mailbox. |
| `stm32h7_touch_calibration.py` | Croci agli angoli per verificare mapping touch/display. |
| `stm32h7_touch_drag.py` | Trascinamento di un oggetto LVGL. |
| `stm32h7_touch_buttons.py` | Matrice di pulsanti per testare latenza e hit-test. |
| `stm32h7_touch_gesture_demo.py` | Swipe, tap e long press se supportati lato LVGL. |

## Integrazione Velxio

| File proposto | Scopo |
| --- | --- |
| `stm32h7_velxio_mailbox_demo.py` | Demo minimale del protocollo touch mailbox. |
| `stm32h7_repl_raw_paste_demo.py` | Test upload veloce via raw paste. |
| `stm32h7_serial_scope_demo.py` | Stampa valori campionati per seriale e scope. |
| `stm32h7_external_led_canvas.py` | Programma e wiring consigliato per LED esterno. |
| `stm32h7_external_button_canvas.py` | Programma e wiring consigliato per bottone esterno. |

## Performance / diagnostica

| File proposto | Scopo |
| --- | --- |
| `stm32h7_perf_touch_latency.py` | Misura il tempo tra touch e update widget. |
| `stm32h7_perf_label_update.py` | Aggiorna label/contatori a frequenze diverse. |
| `stm32h7_perf_fill_rect.py` | Stress test di aree colorate. |
| `stm32h7_perf_many_widgets.py` | Molti widget LVGL per capire il limite pratico. |
| `stm32h7_memory_probe.py` | Stampa SDRAM/free memory/LVGL heap se disponibile. |

## Demo applicative

| File proposto | Scopo |
| --- | --- |
| `stm32h7_dashboard.py` | Dashboard industriale con indicatori, chart e pulsanti. |
| `stm32h7_hmi_panel.py` | Pannello HMI con start/stop, stato macchina e allarmi. |
| `stm32h7_settings_ui.py` | Schermata impostazioni con slider, dropdown e switch. |
| `stm32h7_data_logger_ui.py` | Lista eventi e grafico realtime. |
| `stm32h7_audio_mixer_mock.py` | Interfaccia mixer con slider multipli, utile per touch. |
