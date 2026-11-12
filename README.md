# harness-files

Сервис инструментов `read_file`, `list_dir` и `record_note` для HARNESS.

Слушает только `127.0.0.1`. Живой конверт — `harness.tool.v2` (`POST /v1/tools/{name}`). Закрытый контракт `harness.tool.v1` остаётся в каталоге `contract/` репозитория HARNESS и на этот провод не ставится.

Секрет — переменная `FILE_SERVICE_TOKEN`. В репозитории его нет: сравнение идёт по SHA-256. `GET /health` секрета не требует.

База — Postgres `harness_files`, тесты — `harness_files_test`. Строка подключения только в окружении.

```bash
npm test
```

## Включение из хаба

Файл `examples/services.manifest.json` — манифест для хаба. Секрета в нём нет: `auth.env` называет переменную `FILE_SERVICE_TOKEN`. `base_url` — `http://127.0.0.1:8091/`. Сервис на этом порту слушает только `127.0.0.1`, `SERVICE_ID` — `files`.

Пустой `SERVICES_MANIFEST` у хаба оставляет локальные `read_file`, `list_dir` и `record_note`. Чтобы воркер звал этот процесс, в окружении хаба задают путь и сумму, а значение токена — в `FILE_SERVICE_TOKEN` и у хаба, и у сервиса. В репозиторий значение не кладут.

```bash
sha256sum examples/services.manifest.json
```

Имена переменных хаба: `SERVICES_MANIFEST`, `SERVICES_MANIFEST_SHA256`, `FILE_SERVICE_TOKEN`. У сервиса: `DATABASE_URL` (база `harness_files`), `FILE_ROOT`, `FILE_SERVICE_TOKEN`, `FILE_SERVICE_HOST`, `FILE_SERVICE_PORT`. Файлы читает `FILE_ROOT` сервиса.

У сида агента `clerk` в allowlist только `read_file` и `list_dir`. Имя `record_note` модель не вызовет, пока его нет в `tool_allowlist` этой строки.
