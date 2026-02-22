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
const addingProduct   = new Map(); // userId -> { step, data }
const editingProduct  = new Map(); // userId -> { productId, field }

// ─── /start ──────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  waitingPassword.delete(ctx.from.id);
  addingProduct.delete(ctx.from.id);
  editingProduct.delete(ctx.from.id);

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

// ─── /admin ──────────────────────────────────────────────────────────────────
bot.command('admin', async (ctx) => {
  if (isAdmin(ctx.from.id)) { await showAdminPanel(ctx); return; }
  waitingPassword.add(ctx.from.id);
  await ctx.reply('🔐 Введи пароль администратора:');
});

// ─── /logout ─────────────────────────────────────────────────────────────────
bot.command('logout', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  revokeAdmin(ctx.from.id);
  await ctx.reply('👋 Ты вышел из режима администратора.');
});

// ─── /cancel ─────────────────────────────────────────────────────────────────
bot.command('cancel', async (ctx) => {
  const uid = ctx.from.id;
  if (addingProduct.has(uid))   { addingProduct.delete(uid);  await ctx.reply('❌ Добавление отменено.'); }
  else if (editingProduct.has(uid)) { editingProduct.delete(uid); await ctx.reply('❌ Редактирование отменено.'); }
  else if (waitingPassword.has(uid)) { waitingPassword.delete(uid); await ctx.reply('❌ Отменено.'); }
});

// ─── Каталог ─────────────────────────────────────────────────────────────────
bot.callbackQuery('catalog', async (ctx) => {
  await ctx.answerCallbackQuery();
  await showCatalog(ctx);
});

async function showCatalog(ctx) {
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id DESC').all();
  if (products.length === 0) { await ctx.reply('😔 Пока товаров нет. Загляни позже!'); return; }
  const keyboard = new InlineKeyboard();
  for (const p of products) {
    keyboard.text(`${p.name} — ${p.price_stars} ⭐`, `product_${p.id}`).row();
  }
  await ctx.reply(`🎬 <b>Каталог ватермарок</b>\n\nВыбери нужный товар:`,
    { parse_mode: 'HTML', reply_markup: keyboard });
}

// ─── Карточка товара (для пользователя) ──────────────────────────────────────
bot.callbackQuery(/^product_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const productId = parseInt(ctx.match[1]);
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) { await ctx.reply('❌ Товар не найден или снят с продажи.'); return; }

  const keyboard = new InlineKeyboard()
    .text(`⭐ Купить за ${product.price_stars} Stars`, `buy_${productId}`).row()
    .text('‹ Назад к каталогу', 'catalog');

  const caption =
    `🎬 <b>${product.name}</b>\n\n` +
    `${product.description ? product.description + '\n\n' : ''}` +
    `💰 Цена: <b>${product.price_stars} ⭐ Stars</b>`;

  // Если есть превью — показываем его
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

// ─── Успешная оплата ──────────────────────────────────────────────────────────
bot.on('message:successful_payment', async (ctx) => {
  const payment = ctx.message.successful_payment;
  const productId = parseInt(payment.invoice_payload.replace('product_', ''));
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) { await ctx.reply('⚠️ Оплата прошла, но товар не найден. Напишите администратору.'); return; }

  await ctx.reply(`✅ <b>Оплата прошла!</b> Вот твой файл:`, { parse_mode: 'HTML' });
  await ctx.replyWithDocument(product.file_id, {
    caption: `🎬 <b>${product.name}</b>\n\nПриятного использования!`,
    parse_mode: 'HTML',
  });

  const admins = db.prepare('SELECT user_id FROM admin_sessions').all();
  for (const admin of admins) {
    try {
      await bot.api.sendMessage(admin.user_id,
        `💰 <b>Новая покупка!</b>\n\n` +
        `👤 ${ctx.from.first_name}${ctx.from.username ? ' (@' + ctx.from.username + ')' : ''}\n` +
        `🎬 Товар: ${product.name}\n⭐ Оплачено: ${payment.total_amount} Stars`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
  }
});

// ─── Показ админ-панели ───────────────────────────────────────────────────────
async function showAdminPanel(ctx) {
  await ctx.reply('🔧 <b>Админ-панель</b>\n\nДля выхода — /logout', {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text('➕ Добавить товар', 'admin_add').row()
      .text('📋 Список товаров', 'admin_list').row()
      .text('📊 Статистика', 'admin_stats'),
  });
}

// ─── Враппер: только для авторизованных ──────────────────────────────────────
function adminOnly(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery('⛔ Нет доступа');
    await handler(ctx);
  };
}

// ─── Статистика ───────────────────────────────────────────────────────────────
bot.callbackQuery('admin_stats', adminOnly(async (ctx) => {
  await ctx.answerCallbackQuery();
  const active = db.prepare('SELECT COUNT(*) as c FROM products WHERE active = 1').get().c;
  const total  = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  await ctx.reply(
    `📊 <b>Статистика</b>\n\n🎬 Активных товаров: <b>${active}</b>\n📦 Всего: <b>${total}</b>`,
    { parse_mode: 'HTML' }
  );
}));

// ─── Список товаров ───────────────────────────────────────────────────────────
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

// ─── Карточка товара в админке ────────────────────────────────────────────────
bot.callbackQuery(/^admin_item_(\d+)$/, adminOnly(async (ctx) => {
  await ctx.answerCallbackQuery();
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(parseInt(ctx.match[1]));
  if (!p) { await ctx.reply('Товар не найден.'); return; }
  await showAdminItem(ctx, p);
}));

async function showAdminItem(ctx, p) {
  const info =
    `🎬 <b>${p.name}</b>\n` +
    `📝 ${p.description ?? '—'}\n` +
    `💰 ${p.price_stars} ⭐\n` +
    `🖼 Превью: ${p.preview_file_id ? '✅ есть' : '❌ нет'}\n` +
    `Статус: ${p.active ? '✅ Активен' : '❌ Скрыт'}`;

  const keyboard = new InlineKeyboard()
    .text('✏️ Название',        `edit_name_${p.id}`).row()
    .text('✏️ Описание',        `edit_desc_${p.id}`).row()
    .text('✏️ Цена',            `edit_price_${p.id}`).row()
    .text('✏️ Основной файл',   `edit_file_${p.id}`).row()
    .text('✏️ Превью-видео',    `edit_preview_${p.id}`);

  if (p.preview_file_id) {
    keyboard.text('🗑 Удалить превью', `del_preview_${p.id}`);
  }

  keyboard.row()
    .text(p.active ? '🚫 Скрыть' : '✅ Показать', `admin_toggle_${p.id}`)
    .text('🗑 Удалить товар', `admin_delete_${p.id}`).row()
    .text('‹ Назад к списку', 'admin_list');

  await ctx.reply(info, { parse_mode: 'HTML', reply_markup: keyboard });
}

// ─── Редактирование — кнопки ──────────────────────────────────────────────────
const editFields = {
  name:    { label: 'название',      hint: 'Введи новое название:',                                              isFile: false },
  desc:    { label: 'описание',      hint: 'Введи новое описание (или «-» чтобы убрать):',                       isFile: false },
  price:   { label: 'цену',          hint: 'Введи новую цену в Stars (целое число, мин. 1):',                    isFile: false },
  file:    { label: 'основной файл', hint: 'Пришли новый MP4-файл ватермарки (основной, отправляется после оплаты):', isFile: true  },
  preview: { label: 'превью-видео',  hint: 'Пришли MP4-видео для превью (показывается в каталоге перед покупкой):', isFile: true  },
};

for (const field of Object.keys(editFields)) {
  bot.callbackQuery(new RegExp(`^edit_${field}_(\\d+)$`), adminOnly(async (ctx) => {
    await ctx.answerCallbackQuery();
    const productId = parseInt(ctx.match[1]);
    editingProduct.set(ctx.from.id, { productId, field });
    const meta = editFields[field];
    await ctx.reply(
      `✏️ <b>Редактирование: ${meta.label}</b>\n\n${meta.hint}\n\n<i>/cancel — отменить</i>`,
      { parse_mode: 'HTML' }
    );
  }));
}

// Удалить превью
bot.callbackQuery(/^del_preview_(\d+)$/, adminOnly(async (ctx) => {
  await ctx.answerCallbackQuery('🗑 Превью удалено');
  const productId = parseInt(ctx.match[1]);
  db.prepare('UPDATE products SET preview_file_id = NULL WHERE id = ?').run(productId);
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  await ctx.reply('🗑 Превью удалено.');
  await showAdminItem(ctx, p);
}));

// ─── Скрыть / показать / удалить товар ───────────────────────────────────────
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

// ─── Добавление нового товара ─────────────────────────────────────────────────
// Шаги: name → description → price → file (основной) → preview (можно пропустить)
bot.callbackQuery('admin_add', adminOnly(async (ctx) => {
  await ctx.answerCallbackQuery();
  addingProduct.set(ctx.from.id, { step: 'name', data: {} });
  await ctx.reply(
    '➕ <b>Добавление товара</b>\n\n' +
    'Шаг 1/5 — Введи <b>название</b> ватермарки:\n\n<i>/cancel — отменить</i>',
    { parse_mode: 'HTML' }
  );
}));

// ─── Обработка текстовых сообщений ───────────────────────────────────────────
bot.on('message:text', async (ctx, next) => {
  const userId = ctx.from.id;
  const text   = ctx.message.text;

  // Проверка пароля
  if (waitingPassword.has(userId)) {
    waitingPassword.delete(userId);
    if (text === ADMIN_PASSWORD) {
      authorizeAdmin(userId);
      await ctx.reply('✅ <b>Пароль верный!</b>', { parse_mode: 'HTML' });
      await showAdminPanel(ctx);
    } else {
      await ctx.reply('❌ Неверный пароль. Попробуй /admin снова.');
    }
    return;
  }

  if (!isAdmin(userId)) return next();

  // Редактирование поля товара (текстовые поля)
  if (editingProduct.has(userId)) {
    const { productId, field } = editingProduct.get(userId);
    const meta = editFields[field];

    if (meta.isFile) {
      await ctx.reply('⚠️ Жду файл MP4, а не текст. Пришли видео или документ.\n\n<i>/cancel — отменить</i>', { parse_mode: 'HTML' });
      return;
    }

    if (field === 'name') {
      db.prepare('UPDATE products SET name = ? WHERE id = ?').run(text, productId);
      await ctx.reply(`✅ Название обновлено: <b>${text}</b>`, { parse_mode: 'HTML' });
    } else if (field === 'desc') {
      const val = text === '-' ? null : text;
      db.prepare('UPDATE products SET description = ? WHERE id = ?').run(val, productId);
      await ctx.reply(`✅ Описание обновлено.`);
    } else if (field === 'price') {
      const price = parseInt(text);
      if (isNaN(price) || price < 1) { await ctx.reply('❌ Нужно целое число от 1. Попробуй ещё:'); return; }
      db.prepare('UPDATE products SET price_stars = ? WHERE id = ?').run(price, productId);
      await ctx.reply(`✅ Цена обновлена: <b>${price} ⭐</b>`, { parse_mode: 'HTML' });
    }

    editingProduct.delete(userId);
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    await showAdminItem(ctx, p);
    return;
  }

  // Пошаговое добавление товара
  if (addingProduct.has(userId)) {
    const session = addingProduct.get(userId);

    if (session.step === 'name') {
      session.data.name = text;
      session.step = 'description';
      await ctx.reply('Шаг 2/5 — Введи <b>описание</b> товара (или «-» чтобы пропустить):', { parse_mode: 'HTML' });

    } else if (session.step === 'description') {
      session.data.description = text === '-' ? null : text;
      session.step = 'price';
      await ctx.reply('Шаг 3/5 — Введи <b>цену в Stars</b> (целое число, мин. 1):', { parse_mode: 'HTML' });

    } else if (session.step === 'price') {
      const price = parseInt(text);
      if (isNaN(price) || price < 1) { await ctx.reply('❌ Нужно целое число от 1. Попробуй ещё:'); return; }
      session.data.price_stars = price;
      session.step = 'file';
      await ctx.reply(
        'Шаг 4/5 — Пришли <b>основной MP4-файл</b> ватермарки:\n\n' +
        '<i>Этот файл получит покупатель после оплаты</i>',
        { parse_mode: 'HTML' }
      );

    } else if (session.step === 'preview') {
      // Текст на шаге превью — игнорируем, напоминаем
      await ctx.reply(
        '⚠️ Жду MP4-видео для превью.\n\n' +
        'Пришли видео-файл или нажми /skip чтобы пропустить превью.',
        { parse_mode: 'HTML' }
      );
    }
    return;
  }

  await next();
});

// ─── /skip — пропустить шаг превью при добавлении ────────────────────────────
bot.command('skip', async (ctx) => {
  const userId = ctx.from.id;
  if (!addingProduct.has(userId)) return;
  const session = addingProduct.get(userId);
  if (session.step !== 'preview') return;

  // Сохраняем без превью
  await saveNewProduct(ctx, session.data, null);
});

// ─── Получение файла (добавление или редактирование) ─────────────────────────
bot.on(['message:video', 'message:document'], async (ctx, next) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return next();

  const fileId = ctx.message.video?.file_id ?? ctx.message.document?.file_id;
  if (!fileId) return next();

  // Редактирование файла существующего товара
  if (editingProduct.has(userId)) {
    const { productId, field } = editingProduct.get(userId);

    if (field === 'file') {
      db.prepare('UPDATE products SET file_id = ? WHERE id = ?').run(fileId, productId);
      editingProduct.delete(userId);
      await ctx.reply('✅ Основной файл заменён!');
    } else if (field === 'preview') {
      db.prepare('UPDATE products SET preview_file_id = ? WHERE id = ?').run(fileId, productId);
      editingProduct.delete(userId);
      await ctx.reply('✅ Превью обновлено!');
    } else {
      return next();
    }

    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    await showAdminItem(ctx, p);
    return;
  }

  // Добавление нового товара
  if (addingProduct.has(userId)) {
    const session = addingProduct.get(userId);

    if (session.step === 'file') {
      // Сохраняем основной файл, переходим к превью
      session.data.file_id = fileId;
      session.step = 'preview';
      addingProduct.set(userId, session);
      await ctx.reply(
        'Шаг 5/5 — Пришли <b>превью-видео</b> (MP4):\n\n' +
        '<i>Это короткое видео будет показано в каталоге до покупки.</i>\n\n' +
        '/skip — пропустить превью',
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (session.step === 'preview') {
      // Сохраняем с превью
      await saveNewProduct(ctx, session.data, fileId);
      return;
    }
  }

  await next();
});

// ─── Сохранение нового товара ─────────────────────────────────────────────────
async function saveNewProduct(ctx, data, previewFileId) {
  const userId = ctx.from.id;
  const result = db.prepare(
    'INSERT INTO products (name, description, price_stars, file_id, preview_file_id) VALUES (?, ?, ?, ?, ?)'
  ).run(data.name, data.description ?? null, data.price_stars, data.file_id, previewFileId);

  addingProduct.delete(userId);

  await ctx.reply(
    `✅ <b>Товар добавлен!</b>\n\n` +
    `🎬 ${data.name}\n` +
    `📝 ${data.description ?? '—'}\n` +
    `💰 ${data.price_stars} ⭐\n` +
    `🖼 Превью: ${previewFileId ? '✅ есть' : '❌ нет'}\n` +
    `🆔 ID: ${result.lastInsertRowid}`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📋 К списку', 'admin_list') }
  );
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
bot.catch((err) => console.error('Bot error:', err));
console.log('🚀 Watermark Bot запущен...');
bot.start();
