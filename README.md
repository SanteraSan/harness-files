# harness-files

Сервис инструментов `read_file`, `list_dir` и `record_note` для HARNESS.

Слушает только `127.0.0.1`. Живой конверт — `harness.tool.v2` (`POST /v1/tools/{name}`). Закрытый контракт `harness.tool.v1` остаётся в каталоге `contract/` репозитория HARNESS и на этот провод не ставится.

Секрет — переменная `FILE_SERVICE_TOKEN`. В репозитории его нет: сравнение идёт по SHA-256. `GET /health` секрета не требует.

База — Postgres `harness_files`, тесты — `harness_files_test`. Строка подключения только в окружении.

```bash
npm test
```
