# 🎬 Watermark Bot — Telegram бот продажи ватермарок

Оплата: **Telegram Stars ⭐** и **TON 💎**

## 📦 Установка

```bash
npm install
cp .env.example .env
# Заполни .env своими данными
npm start
```

## ⚙️ Переменные .env

| Переменная | Описание |
|---|---|
| `BOT_TOKEN` | Токен от @BotFather |
| `ADMIN_PASSWORD` | Пароль для входа в админку |
| `TON_WALLET` | Твой TON-кошелёк для приёма оплаты |
| `TON_API_KEY` | API-ключ TON Center (бесплатно) |

### Как получить TON_API_KEY:
1. Зайди на [toncenter.com](https://toncenter.com)
2. Нажми **Get API Key**
3. Вставь ключ в `.env`

### Как включить Stars:
В @BotFather: `Payments → Stars`

---

## 🛍 Процесс покупки

### Stars ⭐
1. Пользователь выбирает товар → «Купить за N Stars»
2. Telegram показывает инвойс → оплата
3. Бот отправляет MP4-файл

### TON 💎
1. Пользователь выбирает товар → «Купить за N TON»
2. Бот показывает кошелёк и **уникальный комментарий**
3. Пользователь переводит TON с комментарием
4. Нажимает «Я оплатил — проверить»
5. Бот проверяет транзакцию через TON Center API
6. Отправляет MP4-файл

---

## 🔐 Админ-панель (`/admin`)

- Добавление товаров — теперь 6 шагов (цена Stars + цена TON)
- Редактирование: название, описание, цена Stars, цена TON, файл, превью
- Статистика включает кол-во ожидающих TON-платежей

---

## 📁 Структура

```
watermark-bot/
├── bot.js       # Основной файл
├── db.js        # SQLite база данных
├── package.json
├── .env         # Секреты
└── data.db      # База (создаётся автоматически)
```

## 🚀 Деплой (VPS)

```bash
npm install -g pm2
pm2 start bot.js --name watermark-bot
pm2 startup && pm2 save
```
