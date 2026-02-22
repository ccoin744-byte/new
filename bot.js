import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import db from './db.js';

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ─── Хелперы авторизации ──────────────────────────────────────────────────────
function isAdmin(userId) {
  return !!db.prepare('SELECT 1 FROM admin_sessions WHERE user_id = ?').get(userId);
}
function authorizeAdmin(userId) {
  db.prepare(`
    INSERT INTO admin_sessions (user_id) VALUES (?)
    ON CONFLICT(user_id) DO UPDATE SET authorized_at = CURRENT_TIMESTAMP
  `).run(userId);
}
function revokeAdmin(userId) {
  db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(userId);
}

// ─── Состояния ───────────────────────────────────────────────────────────────
const waitingPassword = new Set();
const addingProduct = new Map();

// ─── /start ──────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  await ctx.reply(
    `👋 Привет, <b>${ctx.from.first_name}</b>!\n\n` +
    `🎬 Здесь ты можешь купить <b>ватермарки для видео</b> (MP4-файлы) за Telegram Stars ⭐\n\n` +
    `Нажми кнопку ниже, чтобы посмотреть каталог:`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🛍 Открыть каталог', 'catalog'),
    }
  );
});

// ─── /admin — запрашивает пароль ─────────────────────────────────────────────
bot.command('admin', async (ctx) => {
  if (isAdmin(ctx.from.id)) {
    await showAdminPanel(ctx);
    return;
  }
  waitingPassword.add(ctx.from.id);
  await ctx.reply('🔐 Введи пароль администратора:');
});

// ─── /logout ─────────────────────────────────────────────────────────────────
bot.command('logout', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  revokeAdmin(ctx.from.id);
  await ctx.reply('👋 Ты вышел из режима администратора.');
});

// ─── Каталог ─────────────────────────────────────────────────────────────────
bot.callbackQuery('catalog', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showCatalog(ctx);
});

async function showCatalog(ctx) {
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id DESC').all();
  if (products.length === 0) {
    await ctx.reply('😔 Пока товаров нет. Загляни позже!');
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const p of products) {
    keyboard.text(`${p.name} — ${p.price_stars} ⭐`, `product_${p.id}`).row();
  }
  await ctx.reply(
    `🎬 <b>Каталог ватермарок</b>\n\nВыбери нужный товар:`,
    { parse_mode: 'HTML', reply_markup: keyboard }
  );
}

// ─── Карточка товара ─────────────────────────────────────────────────────────
bot.callbackQuery(/^product_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const productId = parseInt(ctx.match[1]);
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);

  if (!product) {
    await ctx.reply('❌ Товар не найден или снят с продажи.');
    return;
  }

  const keyboard = new InlineKeyboard()
    .text(`⭐ Купить за ${product.price_stars} Stars`, `buy_${productId}`).row()
    .text('‹ Назад к каталогу', 'catalog');

  const caption =
    `🎬 <b>${product.name}</b>\n\n` +
    `${product.description ? product.description + '\n\n' : ''}` +
    `💰 Цена: <b>${product.price_stars} ⭐ Stars</b>`;

  if (product.preview_file_id) {
    await ctx.replyWithVideo(product.preview_file_id, { caption, parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard });
  }
});

// ─── Инвойс Stars ────────────────────────────────────────────────────────────
bot.callbackQuery(/^buy_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const productId = parseInt(ctx.match[1]);
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);

  if (!product) { await ctx.reply('❌ Товар не найден.'); return; }

  await ctx.replyWithInvoice(
    product.name,
    product.description ?? 'Ватермарка для видео (MP4)',
    `product_${productId}`,
    'XTR',
    [{ label: product.name, amount: product.price_stars }]
  );
});

// ─── Pre-checkout ─────────────────────────────────────────────────────────────
bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

// ─── Успешная оплата — отдаём файл сразу ─────────────────────────────────────
bot.on('message:successful_payment', async (ctx) => {
  const payment = ctx.message.successful_payment;
  const productId = parseInt(payment.invoice_payload.replace('product_', ''));
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);

  if (!product) {
    await ctx.reply('⚠️ Оплата прошла, но товар не найден. Напишите администратору.');
    return;
  }

  await ctx.reply(`✅ <b>Оплата прошла!</b> Вот твой файл:`, { parse_mode: 'HTML' });
  await ctx.replyWithDocument(product.file_id, {
    caption: `🎬 <b>${product.name}</b>\n\nПриятного использования!`,
    parse_mode: 'HTML',
  });

  // Уведомляем всех авторизованных админов
  const admins = db.prepare('SELECT user_id FROM admin_sessions').all();
  for (const admin of admins) {
    try {
      await bot.api.sendMessage(
        admin.user_id,
        `💰 <b>Новая покупка!</b>\n\n` +
        `👤 ${ctx.from.first_name}${ctx.from.username ? ' (@' + ctx.from.username + ')' : ''}\n` +
        `🆔 ID: ${ctx.from.id}\n` +
        `🎬 Товар: ${product.name}\n` +
        `⭐ Оплачено: ${payment.total_amount} Stars`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
  }
});

// ─── Обработка текстовых сообщений ───────────────────────────────────────────
bot.on('message:text', async (ctx, next) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Проверка пароля
  if (waitingPassword.has(userId)) {
    waitingPassword.delete(userId);
    if (text === ADMIN_PASSWORD) {
      authorizeAdmin(userId);
      await ctx.reply('✅ <b>Пароль верный!</b>', { parse_mode: 'HTML' });
      await showAdminPanel(ctx);
    } else {
      await ctx.reply('❌ Неверный пароль.');
    }
    return;
  }

  // Пошаговое добавление товара (только для авторизованных)
  if (isAdmin(userId)) {
    const session = addingProduct.get(userId);
    if (session) {
      await handleAddStep(ctx, session, text);
      return;
    }
  }

  await next();
});

// ─── Загрузка файла при добавлении ───────────────────────────────────────────
bot.on(['message:video', 'message:document'], async (ctx, next) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return next();
  const session = addingProduct.get(userId);
  if (!session || session.step !== 'file') return next();

  const fileId = ctx.message.video?.file_id ?? ctx.message.document?.file_id;
  if (!fileId) { await ctx.reply('❌ Пришли именно видео или документ MP4.'); return; }

  const result = db.prepare(
    'INSERT INTO products (name, description, price_stars, file_id) VALUES (?, ?, ?, ?)'
  ).run(session.data.name, session.data.description, session.data.price_stars, fileId);

  addingProduct.delete(userId);

  await ctx.reply(
    `✅ <b>Товар добавлен!</b>\n\n🎬 ${session.data.name}\n💰 ${session.data.price_stars} ⭐\n🆔 ID: ${result.lastInsertRowid}`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📋 К списку', 'admin_list') }
  );
});

async function handleAddStep(ctx, session, text) {
  const userId = ctx.from.id;
  if (session.step === 'name') {
    session.data.name = text;
    session.step = 'description';
    addingProduct.set(userId, session);
    await ctx.reply('Шаг 2/4 — Введи <b>описание</b> (или «-» чтобы пропустить):', { parse_mode: 'HTML' });
  } else if (session.step === 'description') {
    session.data.description = text === '-' ? null : text;
    session.step = 'price';
    addingProduct.set(userId, session);
    await ctx.reply('Шаг 3/4 — Введи <b>цену в Stars</b> (целое число, мин. 1):', { parse_mode: 'HTML' });
  } else if (session.step === 'price') {
    const price = parseInt(text);
    if (isNaN(price) || price < 1) { await ctx.reply('❌ Нужно целое число от 1. Попробуй ещё:'); return; }
    session.data.price_stars = price;
    session.step = 'file';
    addingProduct.set(userId, session);
    await ctx.reply('Шаг 4/4 — Пришли <b>MP4-файл</b> ватермарки:', { parse_mode: 'HTML' });
  }
}

// ─── Показ админ-панели ───────────────────────────────────────────────────────
async function showAdminPanel(ctx) {
  await ctx.reply(
    '🔧 <b>Админ-панель</b>\n\nДля выхода — /logout',
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('➕ Добавить товар', 'admin_add').row()
        .text('📋 Список товаров', 'admin_list').row()
        .text('📊 Статистика', 'admin_stats'),
    }
  );
}

// ─── Враппер: только для авторизованных админов ───────────────────────────────
function adminOnly(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery('⛔ Нет доступа');
    await handler(ctx);
  };
}

// ─── Callback-запросы админки ─────────────────────────────────────────────────
bot.callbackQuery('admin_stats', adminOnly(async (ctx) => {
  await ctx.answerCallbackQuery();
  const active = db.prepare('SELECT COUNT(*) as c FROM products WHERE active = 1').get().c;
  const total = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  await ctx.reply(
    `📊 <b>Статистика</b>\n\n🎬 Активных товаров: <b>${active}</b>\n📦 Всего: <b>${total}</b>`,
    { parse_mode: 'HTML' }
  );
}));

bot.callbackQuery('admin_list', adminOnly(async (ctx) => {
  await ctx.answerCallbackQuery();
  const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  if (products.length === 0) {
    await ctx.reply('Товаров пока нет.', { reply_markup: new InlineKeyboard().text('➕ Добавить', 'admin_add') });
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const p of products) {
    keyboard.text(`${p.active ? '✅' : '❌'} ${p.name} (${p.price_stars}⭐)`, `admin_item_${p.id}`).row();
  }
  await ctx.reply('📋 <b>Все товары:</b>', { parse_mode: 'HTML', reply_markup: keyboard });
}));

bot.callbackQuery(/^admin_item_(\d+)$/, adminOnly(async (ctx) => {
  await ctx.answerCallbackQuery();
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(parseInt(ctx.match[1]));
  if (!p) { await ctx.reply('Товар не найден.'); return; }
  await ctx.reply(
    `🎬 <b>${p.name}</b>\n📝 ${p.description ?? '—'}\n💰 ${p.price_stars} ⭐\nСтатус: ${p.active ? '✅ Активен' : '❌ Скрыт'}`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text(p.active ? '🚫 Скрыть' : '✅ Показать', `admin_toggle_${p.id}`).row()
        .text('🗑 Удалить', `admin_delete_${p.id}`).row()
        .text('‹ Назад', 'admin_list'),
    }
  );
}));

bot.callbackQuery(/^admin_toggle_(\d+)$/, adminOnly(async (ctx) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(parseInt(ctx.match[1]));
  db.prepare('UPDATE products SET active = ? WHERE id = ?').run(p.active ? 0 : 1, p.id);
  await ctx.answerCallbackQuery(p.active ? '🚫 Товар скрыт' : '✅ Товар активирован');
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('‹ К списку', 'admin_list') });
}));

bot.callbackQuery(/^admin_delete_(\d+)$/, adminOnly(async (ctx) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(parseInt(ctx.match[1]));
  await ctx.answerCallbackQuery('🗑 Удалено');
  await ctx.reply('Товар удалён.', { reply_markup: new InlineKeyboard().text('‹ К списку', 'admin_list') });
}));

bot.callbackQuery('admin_add', adminOnly(async (ctx) => {
  await ctx.answerCallbackQuery();
  addingProduct.set(ctx.from.id, { step: 'name', data: {} });
  await ctx.reply('➕ <b>Добавление товара</b>\n\nШаг 1/4 — Введи <b>название</b> ватермарки:', { parse_mode: 'HTML' });
}));

// ─── Запуск ───────────────────────────────────────────────────────────────────
bot.catch((err) => console.error('Bot error:', err));
console.log('🚀 Watermark Bot запущен...');
bot.start();
