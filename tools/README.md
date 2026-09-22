# Horneado de fondos animados a video con loop perfecto

Convierte los fondos SVG animados (`*_bg.html`) en MP4 con loop exacto, para
reemplazar los **Browser Source** de OBS por **Media Source**.

## Por qué

Cada Browser Source levanta una instancia CEF completa (proceso renderer +
helper de GPU): del orden de 150–300 MB de RAM cada uno, más el costo de
repintado. Los gradientes SMIL (`<animate attributeName="stop-color">`) son lo
más caro: un gradiente cuyos stops cambian no se puede cachear ni componer en
GPU, así que se re-rasteriza el path entero en cada frame. Un Media Source con
decodificación por hardware ronda los 40–80 MB y ~0 % de CPU.

## El problema del corte

El loop solo es invisible si el video dura **un múltiplo común exacto de todos
los periodos**. Ojo con dos trampas:

- Con `infinite alternate`, el periodo visual es **2×** la duración declarada.
- Los `dur` de los SMIL meten primos (7, 11, 13) que disparan el mínimo común
  múltiplo.

Periodo real de loop de cada archivo, tal como están hoy:

| Archivo | Periodo real |
|---|---|
| `dark_bg`, `gray_flat_bg` | 5–10 min |
| `red_bg`, `red_blue_bg`, `orange_bg`, `pink_bg`, `index`, `gray_bg` | 30 min |
| `wc2026_bg` | 154 horas |
| `custom_bg` | 1001 horas |

> `index.html` es en realidad la variante azul de la familia, así que se hornea
> como `blue_bg`. Está mapeado en `DEFAULT_FILES` dentro de `bake-bg.mjs`.

Por eso grabar en tiempo real y cortar no funciona.

## La solución

`harmonize.mjs` reajusta cada animación a la duración más cercana que quepa un
número entero de veces en el largo de loop `T`:

```
alternate:      d' = T / (2 · round(T / 2d))
normal / SMIL:  d' = T / round(T / d)
```

Con `T = 240 s` la desviación máxima es 4–6.3 %: imperceptible en un fondo
ambiental, y el loop pasa a ser matemáticamente exacto (el frame 240 s es
idéntico al frame 0, sin crossfade).

Después `bake-bg.mjs` congela los **dos** relojes de animación —
`svg.pauseAnimations()` para SMIL y `Animation.pause()` para las CSS— y hace
*seek* frame a frame. Al no grabar en tiempo real no hay jitter ni frames
perdidos. Los frames van por pipe directo a ffmpeg, sin PNGs intermedios en
disco.

**Los archivos fuente no se tocan.** Toda la armonización se inyecta en runtime,
así que los HTML siguen sirviendo para editar en vivo.

## Uso

```bash
cd tools && npm install          # solo la primera vez (playwright-core)

node tools/bake-bg.mjs                                   # todos, ajustes por defecto
node tools/bake-bg.mjs red_bg.html --shards 6
node tools/bake-bg.mjs --loop 240 --fps 60 --crf 16
```

| Flag | Default | Notas |
|---|---|---|
| `--loop` | `240` | Segundos. Más largo = menos distorsión de ritmo. |
| `--fps` | `60` | |
| `--shards` | `4` | Instancias de Chrome en paralelo. Con 6 núcleos, `6` da ~33 fps. |
| `--crf` | `16` | Menor = más calidad y más peso. |
| `--preset` | `slow` | Preset de x264. |
| `--grain` | off | Grano sutil anti-banding. **Normalmente no hace falta** (ver abajo). |
| `--keep` | off | Conserva los shards y los frames de verificación. |
| `--name` | — | Nombre de salida, si no debe heredar el del archivo. Solo con un target. |
| `--out` | `dist/bg` | |

Salida: `dist/bg/<nombre>_loop240s.mp4`.

### Verificación automática de costura

Al terminar cada fondo se compara el PSNR del salto `último frame → frame 0`
contra el de un paso normal `frame 0 → frame 1`. Si son parecidos, el loop es
continuo; el script lo reporta como `SEAMLESS` o `*** VISIBLE CUT ***`.

### Sobre el banding

Los degradados oscuros muestran mesetas anchas de un mismo valor, pero eso
**ya viene del render de Chrome**, no del H.264: medido sobre `red_bg`, el PNG
nativo tiene 10 valores únicos por scanline y el MP4 tiene 15. El video es fiel
al Browser Source, así que `--grain` solo hace falta si el re-encode de la
plataforma lo empeora.

Para inspeccionar un frame suelto sin codificar:

```bash
node tools/probe-frame.mjs red_bg.html 6.667 salida.png --loop 240
```

## Configuración en OBS

Reemplazar cada Browser Source por un **Media Source**:

- **Local File** → el MP4 correspondiente
- **Loop** ✅
- **Close file when inactive** ❌ — mantiene el decoder caliente y evita el
  parpadeo al cambiar de escena
- **Use hardware decoding when available** ✅ — NVDEC en la RTX 3060
- Para usarlo en varias escenas, **Add Existing Source** en vez de duplicarlo:
  una sola instancia en memoria

## Variantes neutras tintables en OBS

`gray_bg.html` y `gray_flat_bg.html` son la versión blanco/gris de `index.html`,
pensadas para recolorear desde OBS en vez de tener un archivo por color.

**Cómo tintarlas:** filtro **Color Correction** sobre el Media Source, y poner el
color deseado en el campo **Color**. Ese campo multiplica: el blanco toma el
tinte a full y cada capa más oscura queda como un tono más profundo del mismo
color.

**El mapeo tonal.** Desaturar el azul original no sirve: su paleta vive entre
17 % y 34 % de gris, y multiplicar eso daría casi negro. Los cinco niveles
conservan el espaciado L\* exacto del original (19.9 puntos), reubicado para que
el cielo caiga en blanco puro:

| Original | Gris | L\* |
|---|---|---|
| `#0057a8` (cielo) | `#ffffff` | 100.0 |
| `#004c93` | `#f1f1f1` | 95.2 |
| `#00417e` | `#e3e3e3` | 90.3 |
| `#003669` | `#d5d5d5` | 85.3 |
| `#002b54` | `#c7c7c7` | 80.1 |

**Cuál usar:**

- `gray_bg` conserva el drift animado de los degradados, así que respira igual
  que el resto de la familia. Es el equivalente directo del original.
- `gray_flat_bg` le da un nivel sólido a cada forma, así que las capas se
  separan más y los cinco tonos quedan netos pase lo que pase. Pesa menos y es
  lo que necesitás si algún día querés un LUT que mande cada capa a un tono
  distinto.

**Un detalle del multiply:** comprime el rango hacia el color del tinte, así que
el resultado queda algo más plano que el azul original. Si querés recuperar esa
profundidad, subí **Contrast** en el mismo filtro Color Correction.

## Re-hornear `custom_bg` con otra paleta

[`custom_bg.html`](../custom_bg.html) conviene mantenerlo vivo como herramienta
de autoría. Su botón *Copy URL* exporta la paleta como query params, y el baker
los respeta:

```bash
node tools/bake-bg.mjs "custom_bg.html?c=2A398D-E61D25-3CAC3B-2A398D-3CAC3B-E61D25&bg=D1D4D1"
```

El panel de color, el picker y el toast se ocultan automáticamente durante el
horneado.

## Si algún fondo se queda como Browser Source

- Bajar el FPS del source a 30.
- Bajar la resolución del source a 960×540 y dejar que OBS escale: un fondo
  difuso no pierde nada y es 4× menos rasterización.
- Reemplazar los `<animate>` de gradientes por dos capas de gradiente estático
  cruzándose en `opacity`, que sí se compone en GPU.
