# 🎬 Watermark Bot — продажа ватермарок за Telegram Stars

---

## 📦 Установка

```bash
npm install
cp .env.example .env
```

Открой `.env` и заполни:

```
BOT_TOKEN=токен_от_BotFather
ADMIN_PASSWORD=придумай_сложный_пароль
```

**Как получить BOT_TOKEN:** [@BotFather](https://t.me/BotFather) → /newbot

**Включить Stars:** @BotFather → /mybots → твой бот → Payments → Stars

```bash
npm start
```

---

## 🔑 Как войти в админку

1. Напиши боту `/admin`
2. Введи пароль из `.env` (ADMIN_PASSWORD)
3. Готово — пароль запоминается до /logout

Выход: `/logout`

---

## 🔧 Возможности админки

- **➕ Добавить товар** — название → описание → цена в Stars → MP4-файл
- **📋 Список товаров** — скрыть / показать / удалить
- **📊 Статистика** — количество товаров

---

## 🛍 Как работает покупка

1. Пользователь открывает каталог → выбирает товар
2. Нажимает «Купить за N ⭐»
3. Telegram показывает инвойс → оплата
4. Бот мгновенно отправляет MP4-файл
5. Все авторизованные админы получают уведомление о покупке

---

## 📁 Структура

```
watermark-bot/
├── bot.js          # Логика бота
├── db.js           # SQLite база данных
├── package.json
├── .env            # Секреты (не заливать в git!)
├── .env.example    # Шаблон
└── data.db         # База (создаётся автоматически)
```

---

## 🚀 Деплой (VPS)

```bash
npm install -g pm2
pm2 start bot.js --name watermark-bot
pm2 startup && pm2 save
```
