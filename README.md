<div align="center">

# DarkEngine Nihil Web

**Веб-порт движка Dark Engine на WebAssembly для запуска *Thief* прямо в браузере**

`C/C++` · `WASM 2.0 + SIMD` · `Asyncify` · `WebGL 2.0` · `OpenAL Web Audio` · `IndexedDB / IDBFS`

[**Открыть веб-лаунчер →**](https://princessbublgum03-alt.github.io/darkengine-nihil-web/)

</div>

---

<div align="center">

### Что это и зачем

**DarkEngine Nihil Web** переносит восстановленное C/C++ ядро **Dark Engine** в браузер (ПК, смартфоны, планшеты) в виде автономного WebAssembly-модуля и единого веб-лаунчера.

Цель проекта — запускать **Thief: The Dark Project**, **Thief Gold** и **Thief II: The Metal Age** без установки, эмуляторов и внешних серверов: распаковка архивов, рендеринг, звук и сохранения выполняются **100% локально на устройстве**.

> *Репозиторий не содержит игровых файлов и ассетов. Для запуска требуется ваша собственная копия игры (`.zip`-архив или локальная папка).*

</div>

---

<div align="center">

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

</div>

---

<div align="center">

### Быстрый старт

1. Откройте [**веб-лаунчер**](https://princessbublgum03-alt.github.io/darkengine-nihil-web/) (можно сразу нажать **«Тест управления»**, чтобы проверить HUD без файлов игры).
2. Выберите `.zip`-архив *(быстрее на Android)* или папку с установленной игрой.
3. Дождитесь разовой индексации в кэш браузера и нажмите **«Запустить Thief»** — следующие запуски стартуют мгновенно из IndexedDB.

</div>

```bash
# Проверка синтаксиса и прогон автотестов веб-лаунчера
npm run build

# Локальный сервер предпросмотра на http://localhost:3000
npm run dev
```

---

<div align="center">

### Сборка WASM и деплой

Автоматическая сборка `thief-runner.js` + `thief-runner.wasm` и публикация на GitHub Pages настроены в [`.github/workflows/build-web.yml`](.github/workflows/build-web.yml).

`web/index.html` — автономный лаунчер · `web-launcher.test.mjs` — автотесты · `docs/android.md` — документация Android-порта

</div>
