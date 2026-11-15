# Оформление страниц разделов

Страница раздела — HTML-фрагмент без `<html>`, `<head>`, `<style>` и `<script>`. Он показывается в редакторе `.editor`, тёмная тема, ширина до 1130 px, на телефоне уже. Классы ниже уже есть в `public/style.css`; новые стили не добавлять, inline `style` только для мелочей (цвет линии в SVG, ширина колонки).

Принципы:
- Сначала суть: герой-блок с одной-двумя фразами, потом оглавление, потом разделы. Читатель должен понять страницу за 30 секунд по заголовкам и карточкам.
- Не полотно: правила, списки, сравнения и роли идут карточками (`.box` в `.grid2/3/4`), процессы — шагами `.flow`, история и этапы — `.timeline`, цифры — `.stats`, решения автора — `.callout.decision`, открытые вопросы — `.callout.warn`, идеи Claude, которые автор не утверждал, — `.callout.idea`.
- Схема там, где связь проще увидеть, чем прочитать: инлайн `<svg class="viz" viewBox="...">` с цветами из палитры (`#e2384d` акцент, `#5a9cf0` синий, `#3fbf86` зелёный, `#e8a33d` янтарь, `#9098aa` приглушённый, `#2c3241` линии, `#e9ecf2` текст, фон `#151820`), шрифт `Inter`, текст в SVG 12–14 px. Подписи не налезают друг на друга.
- Факты только из исходных файлов, ничего не придумывать и не менять смысл. Можно сокращать и группировать, нельзя добавлять. Полный исходный текст кладётся в конец в `<details class="raw"><summary>Полный текст: файл.md</summary>…</details>` (HTML из `~/.claude/md-to-html.py --shift 1`).
- Длинные пути и код в `<code>`; таблицы внутри `<div class="table-wrap">`.

Компоненты:

```html
<div class="doc-hero"><h1>Заголовок</h1><p>Суть в одну-две фразы.</p>
  <div class="tags"><span class="tag accent">ключевое</span><span class="tag">метка</span></div></div>
<nav class="toc"><a href="#id1">Раздел</a> …</nav>
<h2 id="id1">Раздел</h2>
<p class="lead">Вводный абзац покрупнее.</p>
<div class="grid3"><div class="box accent"><div class="k">метка</div><h4>Название</h4><p>Текст</p><ul><li>…</li></ul></div></div>
<!-- варианты .box: accent, blue, green, amber -->
<div class="callout decision"><b>Решено</b>Текст</div>   <!-- также .warn, .idea, без класса = инфо -->
<div class="stats"><div class="stat"><b>5</b><span>команд роя</span></div></div>
<div class="flow"><div class="step"><b>Шаг</b><span>пояснение</span></div><div class="arrow">→</div>…</div>
<ol class="timeline"><li><span class="when">2026-11-14</span>Событие</li></ol>
<dl class="kv"><dt>Ключ</dt><dd>Значение</dd></dl>
<div class="quote">Короткая цитата или лозунг</div>
<div class="table-wrap"><table>…</table></div>
<svg class="viz" viewBox="0 0 900 260">…</svg>
<details class="raw"><summary>Полный текст: docs/x.md</summary>…</details>
```

Медиа из папки проекта: `<img src="/files/<папка игры>/<путь>">`, `<audio controls preload="none" src="/files/...">`. Для картинок-галерей `.gallery` с `<figure><img><figcaption>`.
