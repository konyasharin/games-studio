# Studio Board

Локальная доска для игровых проектов. Внутри проекта есть разделы: сюжет, 3D, звук и другие. Каждый персонаж или модель живёт на своей доске с карточками и связями между ними: главный референс → разбивка на части → референсы частей → модели → итоговая модель. Генерацию картинок по кнопке на карточке выполняет фоновый Claude Code во Flow.

## Запуск

```
node supervisor.mjs      # сервер с автоперезапуском, http://127.0.0.1:4777
```

На Windows запуск по ярлыку на рабочем столе: он вызывает `wscript start-hidden.vbs` с иконкой `public/icon.ico`. Скрипт поднимает сервер без окна, если тот ещё не запущен, и открывает доску в браузере. Журнал пишется в `data/server.log`. Очередь работает, только пока сервер запущен: автозапуска нет.

Нужны Node 20+ и Claude Code (`claude`), вошедший в аккаунт. В Chrome должно стоять расширение Claude in Chrome, а сам Chrome должен быть открыт и залогинен во Flow.

## Где лежат данные

- `data/`: список проектов, настройки (`settings.json`: `flowUrl`, `imageModel`, `worker`), очередь задач (`data/jobs/*.json` и журналы `*.log`). Папка не в git.
- `Projects/<папка игры>/studio/`: `project.json` (разделы, доски), `boards/<id>.json` (карточки, связи, контекст для Claude), `notes/<раздел>.html`, `assets/<доска>/<карточка>/` (картинки и модели).

Сервер ищет проекты в папке, которая лежит на уровень выше приложения: `Projects/studio-board` → `Projects`.

## Как работает очередь

1. Кнопка «Сгенерировать» создаёт задачу `data/jobs/<id>.json`.
2. Сервер по одной запускает `claude -p --chrome --permission-mode auto` и передаёт ему `worker-prompt.md` с данными задачи.
3. Claude генерирует во Flow и отправляет картинки прямо со страницы на `POST /api/jobs/<id>/image`. По ходу работы он пишет в журнал (`/log`), в конце вызывает `/complete`.
4. Доска опрашивает сервер раз в 2 секунды и показывает новые варианты.

Если сервер перезапустился, задача в статусе `running` один раз возвращается в очередь. Задача висит не дольше 45 минут.

Виды задач: `images` (картинки, 1–8 штук, 1 вид или лист с 4 сторонами), `split` (Claude предлагает разбивку на части), `note` (вопрос по файлам проекта).

## API (кратко)

`GET/POST /api/projects`, `GET/PATCH /api/projects/:pid`, `GET/PUT /api/projects/:pid/notes/:sid`,
`POST /api/projects/:pid/boards`, `GET/PATCH /api/projects/:pid/boards/:bid`,
`POST|PATCH|DELETE .../cards[/:cid]`, `POST|DELETE .../links[/:lid]`,
`POST .../cards/:cid/files?slot=&name=` (сырые байты; zip распаковывается),
`POST .../cards/:cid/generate`, `GET /api/jobs`, `POST /api/jobs/:id/{cancel,retry,log,image,complete}`,
`GET /files/<путь внутри Projects>`.
