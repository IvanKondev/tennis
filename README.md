# Тенис Лига Велинград

Уеб приложение за резултати, класиране и планиране на мачове на любителска тенис лига „всеки срещу всеки".

- **Frontend**: Alpine.js (без build step)
- **Backend**: Node.js минимален HTTP сървър (стандартна библиотека, **0 npm зависимости**)
- **Persistence**: единичен JSON файл в Docker volume
- **Deploy**: Coolify (или всеки Docker host)

> **TL;DR за бързо ориентиране** — ако трябва да добавиш фийчър: повечето логика е в [`app.js`](#appjs) (Alpine компонент). UI-я е в [`index.html`](#indexhtml). Стилове в [`styles.css`](#stylescss). Сървърът — в [`server.js`](#serverjs). Данните за играчи и round-robin двойки — в [`data.js`](#datajs).

---

## Съдържание

- [Какво представлява](#какво-представлява)
- [Tech stack — защо такъв избор](#tech-stack--защо-такъв-избор)
- [Структура на файловете](#структура-на-файловете)
- [Модел на данните](#модел-на-данните)
- [Frontend архитектура](#frontend-архитектура)
- [Backend архитектура](#backend-архитектура)
- [Auto-refresh](#auto-refresh)
- [Авторизация — admin парола](#авторизация--admin-парола)
- [Темата](#темата)
- [Локално разработване](#локално-разработване)
- [Deploy в Coolify](#deploy-в-coolify)
- [Backup и мигриране на данни](#backup-и-мигриране-на-данни)
- [Често срещани задачи](#често-срещани-задачи)
- [Гочи и капани](#гочи-и-капани)
- [API референция](#api-референция)
- [Roadmap / идеи](#roadmap--идеи)

---

## Какво представлява

20-играч лига с round-robin формат — всеки играе с всеки **по веднъж**, до 2 спечелени сета (2:0, 2:1, 1:2, 0:2). Победителят получава **1 точка**, загубилият — 0.

Приложението прави 5 неща:

1. **Класиране** — подиум на първите 3 + таблица със стандартни стат показатели
2. **Предстоящи** — планирани мачове по дата с relative pill-ове ("Утре", "След 3 дни")
3. **Мачове** — всичките 190 мача, групирани по играч, с филтри
4. **Двубои (H2H)** — глава-в-глава решетка (десктоп) или разгъващи се карти (мобилен)
5. **Админ** — защитена с парола част за въвеждане на резултати и планиране

Един админ въвежда данните; всички останали само гледат. Промените се синхронизират автоматично през [Auto-refresh](#auto-refresh) на всеки ~25 секунди.

---

## Tech stack — защо такъв избор

| Технология | Защо |
|------------|------|
| **Alpine.js 3** | Реактивност без build step. Един `<script>` таг и работи. По-малко complexity от React/Vue, повече от vanilla. ~15KB. Идеално за 5 view-та. |
| **Node стандартна библиотека** (без Express/Fastify) | Сървърът прави 4 endpoint-а. Един файл, нула dependencies. По-малко attack surface, по-бърз deploy. |
| **JSON файл за съхранение** | ~10KB данни, 1-2 записа на ден. SQL/Postgres е over-engineering. Файлът е лесен за бекъп (просто copy). |
| **Docker volume** | Стандартен Docker pattern. Съхранява файла извън image-a — оцелява redeploy. |
| **Self-hosted Alpine + fonts от Google** | Premium шрифтове (Bebas Neue, Inter) от Google Fonts CDN. Alpine е локално за контрол на каширането. |
| **In-memory file cache + gzip + ETag** | Сървърът зарежда статиката в RAM при старт. Refresh-ове връщат 304. Гарантира sub-50ms response time. |

**Какво НЕ ползваме и защо:**
- ❌ React/Vue/Svelte — overkill за 4 view-та
- ❌ TypeScript — допълнителна build стъпка за дребен сайт
- ❌ Tailwind/CSS-in-JS — обичен CSS работи перфектно тук
- ❌ Postgres/SQLite — JSON файл е достатъчен
- ❌ Redis — не правим session-и или caching на ниво заявка

---

## Структура на файловете

```
.
├── index.html       # Frontend UI (HTML + Alpine директиви)
├── styles.css       # Цялата стилизация (тъмна "court" тема)
├── app.js           # Alpine компонент (state, getters, actions)
├── data.js          # Seed данни: PLAYERS + MATCHES_SEED
├── alpine.min.js    # Self-hosted Alpine 3.13.5 (45KB)
├── server.js        # Node HTTP сървър + /api/* endpoint-и
├── seed.json        # Първоначални 39 резултата (за първоначален import)
├── Dockerfile       # Build instructions за production image
├── .dockerignore    # Файлове, които не отиват в image-a
├── .gitignore       # node_modules/data/.env etc.
└── README.md        # Това
```

### `index.html`
Не е статичен — Alpine рендира динамично през `x-data`, `x-for`, `x-if`, `x-show`, `x-text`.

**Структура:**
- `<header>` (херо) — само на standings view
- `<main>`
  - 5 секции (по една за всеки view), повечето wrap-нати в `<template x-if="view === 'X'">` за lazy mounting
- `<nav class="bottom-nav">` — 5 бутона за смяна на view-та
- 4 модала на края: score, schedule (single), wizard, player picker

**Защо `x-if` вместо `x-show` за heavy view-та?**
Heavy DOM (като H2H grid с 1326 reactive израза) се unmount-ва когато не е активен. Това спестява огромно количество reactivity work. Виж [Гочи #4](#гочи-и-капани).

### `styles.css`
- CSS variables в `:root` за цялата палитра (deep emerald + trophy gold + cream)
- Mobile-first → media queries за по-широки екрани
- BEM-ish convention без конкретен стандарт (избягваме дълбоки селектори)
- **Deterministic player colors** чрез CSS custom property `--avatar-hue` (виж [`playerHue()`](#avatars--цвят-за-играч))

### `app.js`
Един Alpine компонент `tennisApp`, регистриран в `alpine:init`.

**Категории секции вътре:**
1. **State** — реактивни property-та: `view`, `results`, `schedule`, `isAdmin`, etc.
2. **Derived state** (computed чрез watcher, не getters) — `matches`, `standings`, `playedMatches`, `scheduledMatches`, `matchByPair`. Виж [Гочи #3](#гочи-и-капани).
3. **Init / load / persist** — backend detection, зареждане, watcher-и
4. **Auto-refresh** — polling, ETag, toast
5. **Admin actions** — setResult, setSchedule, openWizard, etc.
6. **Wizard logic** — multi-step state machine (player → opponent → date → time)
7. **Calendar** — custom калнандарен компонент за wizard step 3
8. **Helpers** — `formatDate`, `initials`, `playerHue`, etc.

### `data.js`
Просто разкрива два глобални:

```js
const PLAYERS = ["Вики", "Емо", ...];   // 20 имена в игрови ред
const MATCHES_SEED = [
  ["Вики", "Емо", null],          // null = неиграт мач
  ["Вики", "Иво", [2, 0]],        // [s1, s2] = резултат
  ...
];
```

**Защо seed в код вместо БД:** играчите и round-robin двойките са фиксирани за сезона. Промяната ги изисква code change. БД ще е overkill за това.

### `server.js`
Минимален Node HTTP сървър — ~150 реда. Прави:
1. **API endpoints** под `/api/*`
2. **Static files** от `public/` (cached в RAM, gzipped, ETag-ed)
3. **Persistent storage** в `/data/tennis.json` (атомарно през `tmp + rename`)

Виж [Backend архитектура](#backend-архитектура) за детайли.

---

## Модел на данните

### Канонична двойка (key)

Всяка двойка играчи има канонично представяне `"P1|P2"` където P1 идва преди P2 в `PLAYERS` масива.

Например `"Вики|Иво"` е валиден key, защото Вики е преди Иво в списъка. `"Иво|Вики"` НЕ е канонично — никога не записваме така.

Това е важно защото при lookup правим `matchByPair[a + '|' + b]` и `matchByPair[b + '|' + a]` за да хванем и двете посоки.

### Persisted state (в `tennis.json`)

```json
{
  "results": {
    "Вики|Иво": [2, 0],
    "Емо|Митко": [1, 2]
  },
  "schedule": {
    "Гого|Сашо": "2026-05-15T18:00"
  }
}
```

- **`results`**: завършени мачове. Стойност е `[s1, s2]` — сетове спечелени от P1 и P2.
- **`schedule`**: планирани, но неиграни мачове. Стойност е ISO datetime локално (без timezone).

Когато се запише резултат за планиран мач, той се **премества** от `schedule` в `results` (т.е. `schedule[key]` се изтрива).

### Frontend `matches` array (derived)

`recomputeDerived()` в `app.js` обединява `MATCHES_SEED` + `results` + `schedule` в единен масив:

```js
{
  num: 5,                  // 1-based ordinal
  key: "Вики|Иво",         // canonical pair key
  p1: "Вики",
  p2: "Иво",
  s1: 2, s2: 0,            // null when unplayed
  played: true,
  winner: "Вики",          // null when unplayed
  loser: "Иво",
  scheduledAt: null        // ISO string when scheduled
}
```

---

## Frontend архитектура

### Alpine компонент

Един единствен компонент `tennisApp` държи всичко. Регистриран глобално в `alpine:init`:

```js
document.addEventListener('alpine:init', () => {
  Alpine.data('tennisApp', () => ({ ...state and methods... }));
});
```

`<body x-data="tennisApp">` — целият документ е под един реактивен root.

### Защо derived state, а не getters

**Грешен подход (стария):**
```js
get matches() { /* пресмята всеки път */ }
```

При H2H рендер `matches` се викаше 1320 пъти, всеки път създавайки 190 нови обекта = 250,000 ненужни операции.

**Правилен подход (сегашния):**
```js
matches: [],   // state property
recomputeDerived() { /* пресмята когато данните се променят */ },

init() {
  this.$watch('results', () => this.recomputeDerived());
  this.$watch('schedule', () => this.recomputeDerived());
}
```

`matches` се пресмята **само** когато `results` или `schedule` се променят (т.е. при админ действие или auto-refresh). При render-и това е просто property read = O(1).

### O(1) `matchBetween`

Допълнителна оптимизация: в `recomputeDerived()` строим `matchByPair` lookup:
```js
const byPair = {};
for (const m of matches) {
  byPair[m.p1 + '|' + m.p2] = m;
  byPair[m.p2 + '|' + m.p1] = m;  // и двете посоки
}
```

После `matchBetween(a, b)` е просто `this.matchByPair[a + '|' + b]`.

### Filter getters (остават getters)

`filteredMatches` и `groupedMatches` зависят от `matchSearch`, `matchFilter`, `matchPlayerFilter` — стойности, които потребителят променя. Те остават getter-и, защото:
- Зависят от user input (и трябва да реактират)
- Не се викат толкова често (един път за списък, не 1000+ пъти за грид клетки)
- Базират се на бързата вече `this.matches` (не пресмятат от нулата)

### View switching

`view` е стойност `'standings' | 'upcoming' | 'matches' | 'grid' | 'admin'`.

Heavy view-та (matches, grid, admin) са wrap-нати в `<template x-if="view === 'X'">`:

```html
<template x-if="view === 'matches'">
  <section class="panel">...</section>
</template>
```

Когато `view` се смени, цялата секция се **unmount-ва** от DOM-a. Не се рендира скрита под `display: none`.

Lighter views (standings, upcoming) използват `x-show` — DOM-ът остава, само се крие.

State in inputs (search box value etc.) се пази в Alpine компонента, не в DOM-a, така че при unmount + remount всичко се възстановява.

### Avatars — цвят за играч

`playerHue(name)` връща стабилен hue (0-360) от името:
```js
playerHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
```

Същото име → винаги същия hue. CSS custom property се ползва в HTML:
```html
<span class="avatar" :style="`--avatar-hue:${playerHue(p)}`" x-text="initials(p)"></span>
```

CSS:
```css
.avatar {
  background: hsl(var(--avatar-hue, 150), 30%, 22%);
  color:      hsl(var(--avatar-hue, 150), 60%, 75%);
  border:     1.5px solid hsl(var(--avatar-hue, 150), 35%, 30%);
}
```

Така Иво винаги е едни цветове, Гого — други, без манyally hardcoded list.

---

## Backend архитектура

### Endpoint-и

| Метод | Path | Auth | Описание |
|-------|------|------|----------|
| GET | `/api/data` | Не | Връща `{results, schedule}` + ETag |
| PUT | `/api/data` | `X-Admin-Password` | Записва нови данни |
| POST | `/api/auth` | Body `{password}` | Проверява парола (без да вкарва логнат state) |
| GET | `/api/health` | Не | `{ok, hasAdmin}` за Docker healthcheck |
| GET | `/*` | Не | Static файлове от `public/` |

### Persistence

Файлът се пише атомарно през temp file + rename:

```js
function writeData(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);  // atomic on the same FS
}
```

Това гарантира че никога няма corrupted partial-write — или старият файл, или новия.

### Static cache

При старт `preloadPublicDir()` чете всички файлове в `public/` в RAM и пресмята ETag (md5 на съдържанието):

```js
const fileCache = new Map();
function loadIntoCache(filePath) {
  const content = fs.readFileSync(filePath);
  const etag = '"' + crypto.createHash('md5').update(content).digest('hex').slice(0, 16) + '"';
  // gzip if compressible & > 1KB
  if (COMPRESSIBLE.has(ext) && content.length > 1024) {
    entry.gzipped = zlib.gzipSync(content, { level: 9 });
  }
  fileCache.set(filePath, { content, etag, ext, gzipped });
}
```

При request:
1. ако `If-None-Match` matches ETag → `304 Not Modified` (нула body)
2. иначе → връща cached content (gzipped ако клиентът поддържа)

Резултат: subsequent loads са ~50ms или по-малко.

### `/api/data` ETag

ETag-ът на dynamic endpoint е `mtime + size` на файла:
```js
function dataETag() {
  const s = fs.statSync(DATA_FILE);
  return '"' + s.mtimeMs.toString(36) + '-' + s.size.toString(36) + '"';
}
```

Едно `fs.statSync` (синхронно прочитане на metadata, ~0.1ms) дава достатъчно информация. Не пресмятаме hash на съдържанието — ненужно.

---

## Auto-refresh

### Защо го искахме

Един админ въвежда резултат на телефона си. Друг потребител гледа сайта на лаптоп. Без auto-refresh другият трябва ръчно да рефрешне за да види промяната. С auto-refresh — вижда я в рамките на 25 секунди автоматично.

### Как работи

**Сървърна страна:** ETag в `/api/data` GET response.

**Клиентска страна:** при start `startAutoRefresh()` стартира `setInterval` всеки 25s. На всеки tick:

1. Проверява условия за прекъсване — ако да, пропуска:
   - `document.hidden` (tab в background)
   - Open modal/wizard/picker (`isUserBusy()`)
   - Текуща save операция

2. Прави `GET /api/data` с `If-None-Match: <последния ETag>`.

3. Ако `304` → нищо (нула трафик).

4. Ако `200` → парсва JSON, сравнява със текущия state, и ако наистина има разлика:
   - Сетва `_fromServer = true`
   - Обновява `this.results` и `this.schedule`
   - След microtask чисти флага
   - Показва toast "✨ Данните са обновени"

### Анти-цикъл

Ако auto-refresh ъпдейтва `this.results`, watcher-ът на `results` би пуснал `persist()` обратно към сървъра (безкраен цикъл). Това се избягва с `_fromServer` флаг:

```js
async persist() {
  if (this._fromServer) return;
  // ...
}
```

Флагът се чисти през `Promise.resolve().then(...)` (микрозадача) — гарантира че всички watcher-и са имали шанс да фират преди да се изчисти.

### Натоварване

За 5 потребители активни 24/7:
- Всеки прави ~3500 заявки/ден
- 99% връщат `304` (~50 байта response)
- ~875KB трафик/ден общо
- ~17,500 `fs.statSync` calls/ден на сървъра — нула CPU практически

---

## Авторизация — admin парола

### API режим (production, Coolify)

- Парола = environment variable `ADMIN_PASSWORD`
- Сървърът проверява `X-Admin-Password` header при всеки `PUT /api/data`
- Frontend пази паролата в `localStorage` като `tennis-admin-pw` (само на устройството на админа)
- При load, ако има saved password → проверява го с `POST /api/auth` → ако валиден, авто-логин

**Защо plaintext в env var, не hash?** Това е стандартна Docker/12-factor практика. Env vars са в защитеното Coolify пространство. Hashing адресира различен заплашителен модел (изтекла БД).

### Local режим (без сървър, отварен файл директно)

- Парола = SHA-256 хеш в `localStorage` като част от `tennis-v1`
- Първо отваряне → "Задай парола"
- Следващо → "Влез"

### Преход между режимите

Frontend autodetect-ва кой режим е активен през `/api/health`:
- Health отговаря → API режим, ползва env paroлата
- Health не отговаря (404 / network error) → Local режим, ползва hash в localStorage

Това позволява **един и същ кодов база** да работи и локално (за development) и deployed (за production).

---

## Темата

Premium "court" — deep emerald background + trophy gold accent + warm cream text. Wimbledon частен клуб vibe.

Цялата палитра е в CSS variables в `:root`:

```css
--bg-0: #0e1c14;       /* основен фон */
--bg-1: #16261c;       /* картов фон */
--accent: #d4af37;     /* злато */
--text: #f3ecd6;       /* кремав */
--win: #7ed386;        /* мента (победа) */
--loss: #e07c8a;       /* розово (загуба) */
--ball: #c8d962;       /* тенис топка */
```

Промяната на темата е въпрос на смяна на тези променливи. Останалите CSS правила ползват само променливите.

---

## Локално разработване

### Бързо отваряне (без сървър)

Просто отвори `index.html` в браузъра. Frontend-ът ще влезе в **Local режим** — данните се пазят в `localStorage`. При първото влизане в Админ ще те пита да зададеш парола.

⚠️ В local режим не получаваш auto-refresh (няма сървър). Различни браузъри имат различен state.

### С Node сървър

```powershell
# В PowerShell от папката на проекта
$env:ADMIN_PASSWORD = "test123"
node server.js

# Отвори http://localhost:3000
```

Сервърът ще създаде `/data` папка локално (опционално задай `$env:DATA_DIR = "./data"` ако не искаш `/data` в root-а).

### Hot reload

Няма — приложението няма build step. Просто:
1. Промени HTML/CSS/JS
2. Refresh браузъра

> **Внимание:** при server-side промяна (`server.js`) трябва да рестартираш Node процеса. Имай предвид че `preloadPublicDir()` чете файловете при старт — тоест ако смениш CSS, рестарт е нужен дори в development. (Или поправи: добави `?nocache=true` query поведение.)

---

## Deploy в Coolify

### 1. Push към Git

Поддържаме всичко в Git репо (вече при `IvanKondev/tennis`). При промени:

```powershell
git add .
git commit -m "описание"
git push
```

### 2. Coolify Application

1. **+ New** → **Resource** → **Application**
2. **Public Repository** (или Private с deploy key)
3. Repository URL, Branch `main`
4. **Build Pack: Dockerfile** (auto-detect)
5. **Port**: `3000`
6. **Persistent Storage** → Add **Volume Mount**:
   - Name: `tennis-data`
   - Source Path: (празно — managed Docker volume)
   - Destination Path: `/data`
7. **Environment Variables**:
   - `ADMIN_PASSWORD` = силна парола
8. **Domain** → задай поддомейн (HTTPS автоматично)
9. **Deploy**

### 3. Auto-deploy on push

В Coolify settings включи "Auto-deploy on push". При всеки `git push` Coolify pull-ва и редеплойва. Volume не се пипа.

---

## Backup и мигриране на данни

### Какво има за бекъп

Само `/data/tennis.json` (~10KB). Всичко останало (код, статика, темата) е в Git.

### Стратегии

**Опция 1: Ръчно през UI** (най-лесно)
- В Админ панела: ⬇ **Експорт** → сваля `tennis-YYYY-MM-DD.json`
- Прави това периодично (седмично/месечно)
- Качи го в Drive/Dropbox/email на себе си

**Опция 2: Container terminal**
```sh
# В Coolify → Terminal на приложението
cat /data/tennis.json
```
Copy-paste-ни съдържанието.

**Опция 3: Възстановяване**
- В Админ → ⬆ **Импорт** → избери JSON файл → потвърди
- ИЛИ в Coolify Terminal:
  ```sh
  curl -sL -o /data/tennis.json <URL_към_бекъп>
  ```

### Първоначално зареждане на данни

Файлът `seed.json` в repo-то съдържа 39-те първоначални резултата. След първи deploy:
- Свали `https://raw.githubusercontent.com/IvanKondev/tennis/main/seed.json`
- ⬆ Импорт

ИЛИ в container terminal:
```sh
wget -O /data/tennis.json https://raw.githubusercontent.com/IvanKondev/tennis/main/seed.json
```

---

## Често срещани задачи

### Добавяне на нов играч

В `data.js`:
1. Добави име в `PLAYERS` масива
2. Добави всички `[ново_име, друг_играч, null]` двойки в `MATCHES_SEED` (внимавай канонично — нов играч идва след всички текущи в списъка, така че `[нов, P]` е правилно)

⚠️ Това е breaking change — изтрива съществуващи resulst keys ако ред в MATCHES_SEED се промени. Прави го само в началото на сезон.

### Смяна на парола

В Coolify → Environment Variables → `ADMIN_PASSWORD` → нова стойност → Save → Restart.

Браузърите със стара парола в localStorage ще бъдат изхвърлени (auth fail на следващото зареждане).

### Промяна на темата

В `styles.css`, секция `:root`. Смени стойностите на CSS variables.

### Промяна на интервала за auto-refresh

В `app.js`, метод `startAutoRefresh()`:
```js
this._pollInterval = setInterval(() => {...}, 25000);  // <- тук, в милисекунди
```

### Добавяне на ново view

1. В HTML: добави нова `<section class="panel">` (или wrap в `<template x-if="view === 'newview'">` ако е heavy)
2. В bottom nav: добави нов `<button>` с `@click="view = 'newview'"`
3. В `app.js`: ако трябва, добави getter/method за derived data

### Добавяне на нов wizard

Текущите wizards (schedule, result) са в един общ Alpine state `wizard`. За нов wizard:
1. Добави `mode: 'newmode'` възможност
2. Добави стъпки в HTML: `<div class="wizard-step" x-show="wizard.step === N && wizard.mode === 'newmode'">`
3. Добави `wizardOpen('newmode')`, `wizardConfirmNewmode()` методи

---

## Гочи и капани

### 1. Канонична двойка ВИНАГИ от `MATCHES_SEED`

При запис на резултат, `match.key` идва от съществуващия match object, който се чете от `matchByPair`. **Никога** не строй ключ от user input. Грешен пример:
```js
// ГРЕШНО - ако P1/P2 са в обратен ред, ще създадеш fantom key
results[`${userP1}|${userP2}`] = [s1, s2];
```

Правилно:
```js
const m = this.matchBetween(userP1, userP2);
this.results[m.key] = [s1, s2];
```

### 2. Чиста реактивност при mutation

Alpine watch-и фират при reassignment, не при mutation. Грешно:
```js
this.results[key] = [2, 0];  // няма да фитне $watch('results')
```

Правилно:
```js
this.results = { ...this.results, [key]: [2, 0] };
```

Виж как е направено в `setResult()`, `setSchedule()` etc.

### 3. Derived state vs getters

Виж [Frontend архитектура](#frontend-архитектура). За често достъпвани изчислени данни — derived state с watcher. За user-input-driven (filter, search) — getter.

### 4. `x-if` vs `x-show`

- `x-show` — DOM остава, само се крие. По-бързо за смяна, но reactive expressions винаги се оценяват.
- `x-if` (на `<template>`) — DOM се mount-ва/unmount-ва. По-бавна смяна, но нула overhead когато не е активно.

Правило: heavy expressions (>50 reactive bindings, или nested loops) → `x-if`. Леки секции → `x-show`.

### 5. Кирилица в Windows пътища

Гитове и Docker понякога имат проблеми с пътища като `d:\Работна\`. Ако скочи странна грешка — премести проекта в път без кирилица.

### 6. Anti-loop на auto-refresh

`_fromServer` флаг трябва да е чист преди следващ user write. Ако нещо чупи в това: проверявай в DevTools дали `persist()` се вика безкрайно.

### 7. Wizard state cleanup

`closeWizard()` НЕ нулира всичко — само `wizard.open = false`. Това е нарочно, за да може юзърът да затвори и да се върне без да губи прогрес. Но при `openWizard()` всичко се reset-ва. Ако виждаш странен state — провери дали `openWizard` се вика преди отваряне.

---

## API референция

### `GET /api/data`
**Auth**: няма
**Headers**: `If-None-Match: <etag>` (опционално)
**Response 200**:
```json
{
  "results": { "Вики|Иво": [2, 0] },
  "schedule": { "Гого|Сашо": "2026-05-15T18:00" }
}
```
Headers: `ETag: "<value>"`, `Cache-Control: no-cache`

**Response 304**: ако ETag matches, празно body.

### `PUT /api/data`
**Auth**: `X-Admin-Password: <admin password>`
**Body**:
```json
{
  "results": { ... },
  "schedule": { ... }
}
```
**Response 200**: `{"ok": true}`
**Response 400**: invalid payload
**Response 401**: bad password

### `POST /api/auth`
**Body**: `{"password": "..."}`
**Response 200**: `{"ok": true}` (валидна парола)
**Response 401**: `{"ok": false}` (грешна или липсваща)

### `GET /api/health`
**Response 200**: `{"ok": true, "hasAdmin": true|false}`

---

## Roadmap / идеи

Неща, които не са имплементирани, но биха били смислени:

- **PWA** — manifest + service worker → "Add to home screen", offline mode, instant subsequent loads
- **Set-by-set резултати** — вместо само `[2, 0]`, пази `[[6,4], [6,2]]` за всеки сет
- **Recent activity feed** — секция "Последни 5 мача" с timestamps. Изисква да добавим `recordedAt` към result entries.
- **Player profile bottom sheet** — тапаш играч → отваря sheet с full stats, без да губиш context
- **`.ics` export** — "Добави в Google Calendar" бутон в Предстоящи
- **Web Push notifications** — "Утре имаш мач срещу X в 18:00"
- **Стрийкове** — "Иво е на 3 поредни победи!"
- **Множествени админи** — сега само един env var. Може да stack-ваме списък.

---

## Лиценз / автор

Private проект за Тенис Лига Велинград. Built by [Иван Кондев](https://github.com/IvanKondev) с помощта на Claude.
