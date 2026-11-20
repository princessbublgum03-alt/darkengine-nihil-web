<div align="center">

# DarkEngine Nihil Web

**A WebAssembly port of the Dark Engine for playing *Thief* right in your browser**

`C/C++` · `WASM 2.0 + SIMD` · `Asyncify` · `WebGL 2.0` · `OpenAL Web Audio` · `IndexedDB / IDBFS`

[**Open the web launcher →**](https://princessbublgum03-alt.github.io/darkengine-nihil-web/)

</div>

---

<div align="center">

### What it is and why

**DarkEngine Nihil Web** brings the restored C/C++ core of the **Dark Engine** into the browser (desktop, smartphones, tablets) as a self-contained WebAssembly module with a single web launcher.

The goal of the project is to run **Thief: The Dark Project**, **Thief Gold** and **Thief II: The Metal Age** with no installation, emulators or external servers: archive unpacking, rendering, audio and saves are all handled **100% locally on the device**.

> *This repository contains no game files or assets. To run the game you need your own copy (a `.zip` archive or a local folder).*

</div>

---

<div align="center">

### Technical overview

| Subsystem | Implementation |
| :--- | :--- |
| **Core compilation** | Emscripten SDK, CMake + Ninja, Clang `-O3`, WASM 2.0, SIMD, Asyncify (without `-flto`) |
| **Graphics** | SDL2 → OpenGL ES 3 / WebGL 2.0 · adaptive `1:1` aspect ratio with no black bars, scale `0.50×–1.0×`, cap at `30 / 60 / VSync` |
| **Audio** | Emscripten OpenAL built on the Web Audio API with a single-threaded mixer and mobile audio unlocking |
| **Cache and saves** | Streaming `.zip` unpacker → chunked `IndexedDB` cache (working around the 127 MB limit) + persistent saves in `IDBFS` (`/gamedata/saves`) |
| **Input bridge** | Asyncify-safe `JS → C++` queue: touch HUD (3-zone stealth stick, swipe look, gesture mode), desktop (keyboard + Raw Pointer Lock) and gamepads (`Web Gamepad API`) |
| **Scripting** | Built-in Squirrel 3.2 provider (`sq_scripts/*.nut`) and a compatibility layer for legacy `.osm` |
| **Diagnostics** | Two independent log streams with `.log` export: **System logs** (`WASM / GPU / Cache`) and **Input logs** (`Touch / Gestures / HUD / Desktop / Gamepad / Engine`) |

</div>

---

<div align="center">

### Quick start

1. Open the [**web launcher**](https://princessbublgum03-alt.github.io/darkengine-nihil-web/) (you can hit **"Input test"** right away to check the HUD without any game files).
2. Pick a `.zip` archive *(faster on Android)* or a folder with the installed game.
3. Wait for the one-time indexing into the browser cache and press **"Launch Thief"** — subsequent runs start instantly from IndexedDB.

</div>

```bash
# Syntax check and web launcher test run
npm run build

# Local preview server at http://localhost:3000
npm run dev
```

---

<div align="center">

### WASM build and deploy

Automatic build of `thief-runner.js` + `thief-runner.wasm` and publishing to GitHub Pages are set up in [`.github/workflows/build-web.yml`](.github/workflows/build-web.yml).

`web/index.html` — self-contained launcher · `web-launcher.test.mjs` — automated tests · `docs/android.md` — Android port documentation

</div>

---

<details>
<summary><b>Описание на русском языке</b></summary>
<br>

<div align="center">

**Веб-порт движка Dark Engine на WebAssembly для запуска *Thief* прямо в браузере**

[**Открыть веб-лаунчер →**](https://princessbublgum03-alt.github.io/darkengine-nihil-web/)

</div>

### Что это и зачем

**DarkEngine Nihil Web** переносит восстановленное C/C++ ядро **Dark Engine** в браузер (ПК, смартфоны, планшеты) в виде автономного WebAssembly-модуля и единого веб-лаунчера.

Цель проекта — запускать **Thief: The Dark Project**, **Thief Gold** и **Thief II: The Metal Age** без установки, эмуляторов и внешних серверов: распаковка архивов, рендеринг, звук и сохранения выполняются **100% локально на устройстве**.

> *Репозиторий не содержит игровых файлов и ассетов. Для запуска требуется ваша собственная копия игры (`.zip`-архив или локальная папка).*

### Техническое устройство

| Подсистема | Реализация |
| :--- | :--- |
| **Компиляция ядра** | Emscripten SDK, CMake + Ninja, Clang `-O3`, WASM 2.0, SIMD, Asyncify (без `-flto`) |
| **Графика** | SDL2 → OpenGL ES 3 / WebGL 2.0 · адаптивное соотношение сторон `1:1` без чёрных полос, масштаб `0.50×–1.0×`, лимит `30 / 60 / VSync` |
| **Звук** | Emscripten OpenAL на базе Web Audio API с однопоточным микшером и мобильной разблокировкой аудио |
| **Кэш и сохранения** | Потоковый распаковщик `.zip` → чанкованный кэш `IndexedDB` (обход лимита 127 МБ) + постоянные сохранения в `IDBFS` (`/gamedata/saves`) |
| **Мост управления** | Asyncify-безопасная очередь `JS → C++`: сенсорный HUD (3-зонный стелс-стик, обзор свайпом, режим жестов), ПК (клавиатура + Raw Pointer Lock) и геймпады (`Web Gamepad API`) |
| **Скрипты** | Встроенный провайдер Squirrel 3.2 (`sq_scripts/*.nut`) и слой совместимости для legacy `.osm` |
| **Диагностика** | Два независимых журнала с выгрузкой в `.log`: **Логи системы** (`WASM / GPU / Кэш`) и **Логи управления** (`Сенсор / Жесты / HUD / ПК / Геймпад / Движок`) |

### Быстрый старт

1. Откройте [**веб-лаунчер**](https://princessbublgum03-alt.github.io/darkengine-nihil-web/) (можно сразу нажать **«Тест управления»**, чтобы проверить HUD без файлов игры).
2. Выберите `.zip`-архив *(быстрее на Android)* или папку с установленной игрой.
3. Дождитесь разовой индексации в кэш браузера и нажмите **«Запустить Thief»** — следующие запуски стартуют мгновенно из IndexedDB.

### Сборка WASM и деплой

Автоматическая сборка `thief-runner.js` + `thief-runner.wasm` и публикация на GitHub Pages настроены в [`.github/workflows/build-web.yml`](.github/workflows/build-web.yml).

</details>
