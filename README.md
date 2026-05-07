# Тенис Лига Велинград

Уеб приложение за резултати, класиране и планиране на мачове на тенис лига.
Frontend: Alpine.js (без build step). Backend: minimal Node.js (стандартна библиотека, без npm зависимости).

## Структура

```
.
├── index.html          # фронт-енд UI
├── styles.css          # дизайн (premium "court" theme)
├── app.js              # Alpine компонент: state, wizards, API
├── data.js             # seed: играчи и round-robin двойки
├── server.js           # Node HTTP сървър + /api/data
├── Dockerfile          # Coolify-ready
└── .dockerignore
```

## Локално разработване

**Без сървър** (само статични файлове, всичко в `localStorage`):
Отвори `index.html` в браузъра. Автоматично пада в `local` режим — всеки юзер има своя копия.

**Със сървър** (споделени данни):
```bash
ADMIN_PASSWORD=своя-парола node server.js
# отвори http://localhost:3000
```

## Coolify деплой

### Стъпки
1. **Нов Service** в Coolify → Application → Public/Private repo с този проект
2. **Build pack: Dockerfile** (auto-detect от `Dockerfile`-a)
3. **Persistent storage** (КРИТИЧНО за запазване на резултати при redeploy):
   - Source: Volume
   - Mount path: `/data`
   - Coolify ще създаде volume автоматично
4. **Environment variables**:
   - `ADMIN_PASSWORD` = силна парола (задължително — без нея админ записите са спрени)
   - `PORT` = `3000` (по default)
5. **Port**: 3000 (HTTP)
6. **Healthcheck**: `/api/health` (вече дефиниран в `Dockerfile`)
7. Deploy

### Защо това оцелява redeploy

Резултатите и графикът се пазят в `/data/tennis.json` **вътре в Docker volume-a**.
Volume-ът е извън image-a — при rebuild на image-a (нов код), volume-ът остава непокътнат.
Container-ът просто се закача за същия volume → данните си стоят.

⚠️ **Не правете "Delete data" / "Recreate volume"** в Coolify — това трие volume-a.
За миграция: преди това натисни ⬇ Експорт от админ панела (сваля JSON), после след redeploy ⬆ Импорт.

### Backup стратегия

1. **Ръчно**: От админ панела ⬇ Експорт → JSON файл локално
2. **Auto** (препоръчвам): добави cron в Coolify или host машината:
   ```bash
   # ежедневен copy на /data → /backups
   0 3 * * * docker cp <container>:/data/tennis.json /backups/tennis-$(date +\%F).json
   ```
3. По избор: качване към S3/B2 след cron

### Смяна на админ парола

В Coolify → Environment Variables → `ADMIN_PASSWORD` → Save → Restart.
Браузърите, в които админът е логнат, ще трябва да влязат с новата парола.

## API

| Метод | Path | Описание |
|-------|------|----------|
| GET | `/api/data` | Връща `{results, schedule}` (публично) |
| PUT | `/api/data` | Записва нови данни. Изисква `X-Admin-Password` header |
| POST | `/api/auth` | Тества парола. Body: `{password}` |
| GET | `/api/health` | `{ok, hasAdmin}` |

## Backend режими (frontend автоматично избира)

- **`api` режим**: detect-ва се ако `/api/health` отговаря. Чете/пише на сървъра. Локалното копие (localStorage) служи като cache.
- **`local` режим**: ако няма сървър (отваряш файла директно). Всичко само в localStorage. Парола се хешира локално.

Иконата в навигацията остава 🔒/🔓 а индикаторът в админ панела ("Сървър" / "Локално") казва коя е активната.

## Сигурност

- API password-ът се пази plaintext като env var (стандартна практика, добре за самостоятелен deployment).
- Frontend изпраща паролата като `X-Admin-Password` header — над HTTPS е безопасно. **Винаги пускайте сайта зад HTTPS** (Coolify прави това автоматично).
- Няма rate limiting — за публичен deployment добавете reverse proxy (Caddy/Traefik) с rate limit на `/api/`.
- Няма real-time sync между администратори: ако двама пишат едновременно, последният записва побеждава. За тази лига това е приемливо.

## Полезни env vars

| Variable | Default | Описание |
|----------|---------|----------|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | Папка за `tennis.json` |
| `ADMIN_PASSWORD` | (не е сетнат) | Без нея PUT е disabled |
