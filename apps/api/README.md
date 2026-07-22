# Budget Flow API

Backend финансового учёта на NestJS, PostgreSQL и Kysely. Базовая валюта — только RUB. Все денежные суммы API передаются целыми числами в копейках: например, `125000` означает 1 250 ₽.

## Требования

- Node.js и pnpm версии, совместимые с корневым `package.json`;
- Docker с Docker Compose;
- свободные порты `5432` для PostgreSQL и `3000` для API (их можно изменить через переменные окружения).

Если меняете `POSTGRES_PORT`, укажите тот же порт после `localhost:` в `DATABASE_URL`.
Например, для `POSTGRES_PORT=55432` строка подключения должна содержать
`localhost:55432`.

## Запуск

Из корня репозитория выполните:

```powershell
pnpm install
pnpm db:up
Copy-Item .env.example .env
pnpm db:migrate
pnpm --filter @budget-flow/api dev
```

`pnpm db:migrate` безопасно запускать повторно: Kysely применяет только ещё не выполненные версионированные миграции. Автоматической синхронизации схемы нет.

Для чистой остановки API завершите процесс `dev`, затем остановите PostgreSQL без удаления данных:

```powershell
pnpm db:down
```

Именованный Docker volume сохраняется. Команда `db:down` не использует `-v`.

## Идентификация запросов

Все маршруты `/finance` требуют заголовок `X-User-Id` с UUID. Это временная идентификация пользователя; аутентификация намеренно не входит в текущий scope и будет добавлена отдельно.

Запросы, создающие денежные операции, дополнительно требуют непустой `Idempotency-Key`. Повтор запроса с тем же ключом и payload возвращает сохранённый результат, а повтор с другим payload — `409 Conflict`.

Ниже используются переменные PowerShell:

```powershell
$baseUrl = 'http://localhost:3000'
$userId = '11111111-1111-4111-8111-111111111111'
```

### Финансовый профиль

`firstPeriodEndsOn` — локальная включительная дата окончания первого расчётного периода.

```powershell
curl.exe -X PUT "$baseUrl/finance/profile" `
  -H "X-User-Id: $userId" `
  -H "Content-Type: application/json" `
  -d '{"cadence":"MONTHLY","firstPeriodEndsOn":"2026-08-31","timezone":"Europe/Moscow"}'
```

### Начальный остаток

```powershell
curl.exe -X POST "$baseUrl/finance/opening-balance" `
  -H "X-User-Id: $userId" `
  -H "Idempotency-Key: opening-balance-1" `
  -H "Content-Type: application/json" `
  -d '{"amountMinor":15000000,"effectiveAt":"2026-07-17T09:00:00.000Z"}'
```

### Текущий баланс

```powershell
curl.exe "$baseUrl/finance/balance" -H "X-User-Id: $userId"
```

### Обычный расход

Расход требует UUID существующей категории. Создание категории само по себе не проводит деньги и не требует `Idempotency-Key`:

```powershell
$category = curl.exe -sS -X POST "$baseUrl/finance/categories" `
  -H "X-User-Id: $userId" `
  -H "Content-Type: application/json" `
  -d '{"name":"Продукты"}' | ConvertFrom-Json

curl.exe -X POST "$baseUrl/finance/expenses" `
  -H "X-User-Id: $userId" `
  -H "Idempotency-Key: expense-1" `
  -H "Content-Type: application/json" `
  -d (ConvertTo-Json @{ amountMinor = 250000; categoryId = $category.id; occurredAt = '2026-07-17T12:00:00.000Z'; description = 'Покупки на неделю' } -Compress)
```

### Принятие предложения переноса

Получите UUID ожидающего предложения из списка, затем переведите всю предложенную сумму (пустой объект) или укажите положительную часть в `amountMinor`:

```powershell
$offers = curl.exe -sS "$baseUrl/finance/settlement-offers" `
  -H "X-User-Id: $userId" | ConvertFrom-Json
$offerId = $offers.items[0].id

curl.exe -X POST "$baseUrl/finance/settlement-offers/$offerId/accept" `
  -H "X-User-Id: $userId" `
  -H "Idempotency-Key: settlement-accept-1" `
  -H "Content-Type: application/json" `
  -d '{"amountMinor":500000}'
```

Чтобы принять всю доступную сумму, замените тело последнего запроса на `{}` и используйте новый `Idempotency-Key`.
