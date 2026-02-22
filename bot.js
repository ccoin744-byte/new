import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import db from './db.js';

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD;
const TON_WALLET      = process.env.TON_WALLET;      // твой TON-кошелёк для приёма оплаты
const TON_API_KEY     = process.env.TON_API_KEY;     // ключ от toncenter.com (бесплатный)

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

// ─── TON: генерация уникального комментария ───────────────────────────────────
function makeTonComment(userId, productId) {
  return `WM-${userId}-${productId}-${Date.now().toString(36)}`;
}

// ─── TON: проверка транзакции через TON Center API ────────────────────────────
async function checkTonTx(comment, expectedAmount) {
  try {
    const url = `https://toncenter.com/api/v2/getTransactions?address=${TON_WALLET}&limit=20&api_key=${TON_API_KEY || ''}`;
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.ok || !data.result) return null;

    for (const tx of data.result) {
      const msg = tx.in_msg;
      if (!msg) continue;

      // Проверяем комментарий
      const msgText = msg.message || '';
      if (!msgText.includes(comment)) continue;

      // Проверяем сумму (в нанотонах, 1 TON = 1e9 нанотон)
      const receivedNano = parseInt(msg.value || '0');
      const receivedTon  = receivedNano / 1e9;
      if (receivedTon < expectedAmount * 0.99) continue; // допуск 1%

      return { hash: tx.transaction_id?.hash, amount: receivedTon };
    }
    return null;
  } catch (e) {
    console.error('TON API error:', e);
    return null;
  }
}

// ─── Состояния ───────────────────────────────────────────────────────────────
const waitingPassword  = new Set();
const addingProduct    = new Map(); // userId -> { step, data }
const editingProduct   = new Map(); // userId -> { productId, field }
const waitingTonHash   = new Map(); // userId -> { comment, productId, amount }

// ─── /start ──────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  waitingPassword.delete(ctx.from.id);
  addingProduct.delete(ctx.from.id);
  editingProduct.delete(ctx.from.id);
  waitingTonHash.delete(ctx.from.id);

  await ctx.reply(
    `👋 Привет, <b>${ctx.from.first_name}</b>!\n\n` +
    `🎬 Здесь ты можешь купить <b>ватермарки для видео</b> (MP4-файлы)\n\n` +
    `💳 Оплата: Telegram Stars ⭐ или TON 💎\n\n` +
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
  if (waitingTonHash.has(uid)) {
    waitingTonHash.delete(uid);
    db.prepare('DELETE FROM ton_pending WHERE user_id = ?').run(uid);
    await ctx.reply('❌ Оплата TON отменена.');
  } else if (addingProduct.has(uid))  { addingProduct.delete(uid);  await ctx.reply('❌ Добавление отменено.'); }
  else if (editingProduct.has(uid))   { editingProduct.delete(uid); await ctx.reply('❌ Редактирование отменено.'); }
  else if (waitingPassword.has(uid))  { waitingPassword.delete(uid); await ctx.reply('❌ Отменено.'); }
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
    keyboard.text(`${p.name} — ${p.price_stars}⭐ / ${p.price_ton}💎`, `product_${p.id}`).row();
  }
  await ctx.reply(`🎬 <b>Каталог ватермарок</b>\n\nВыбери нужный товар:`,
    { parse_mode: 'HTML', reply_markup: keyboard });
}

// ─── Карточка товара ──────────────────────────────────────────────────────────
bot.callbackQuery(/^product_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const productId = parseInt(ctx.match[1]);
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) { await ctx.reply('❌ Товар не найден или снят с продажи.'); return; }

  const keyboard = new InlineKeyboard()
    .text(`⭐ Купить за ${product.price_stars} Stars`, `buy_stars_${productId}`).row()
    .text(`💎 Купить за ${product.price_ton} TON`,    `buy_ton_${productId}`).row()
    .text('‹ Назад к каталогу', 'catalog');

  const caption =
    `🎬 <b>${product.name}</b>\n\n` +
    `${product.description ? product.description + '\n\n' : ''}` +
    `💰 Цена:\n` +
    `  ⭐ <b>${product.price_stars} Telegram Stars</b>\n` +
    `  💎 <b>${product.price_ton} TON</b>`;

  if (product.preview_file_id) {
    await ctx.replyWithVideo(product.preview_file_id, { caption, parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard });
  }
});

// ─── Оплата Stars ─────────────────────────────────────────────────────────────
bot.callbackQuery(/^buy_stars_(\d+)$/, async (ctx) => {
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

// ─── Pre-checkout Stars ───────────────────────────────────────────────────────
bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

// ─── Успешная оплата Stars ────────────────────────────────────────────────────
bot.on('message:successful_payment', async (ctx) => {
  const payment = ctx.message.successful_payment;
  const productId = parseInt(payment.invoice_payload.replace('product_', ''));
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) { await ctx.reply('⚠️ Оплата прошла, но товар не найден. Напишите администратору.'); return; }

  await deliverProduct(ctx, product, `⭐ Stars (${payment.total_amount})`);
});

// ─── Оплата TON ───────────────────────────────────────────────────────────────
bot.callbackQuery(/^buy_ton_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const productId = parseInt(ctx.match[1]);
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) { await ctx.reply('❌ Товар не найден.'); return; }

  if (!TON_WALLET) {
    await ctx.reply('❌ Оплата TON пока не настроена. Выбери оплату Stars ⭐');
    return;
  }

  const comment = makeTonComment(ctx.from.id, productId);
  const amount  = product.price_ton;

  // Сохраняем ожидающий платёж
  try {
    db.prepare('DELETE FROM ton_pending WHERE user_id = ?').run(ctx.from.id);
    db.prepare(
      'INSERT INTO ton_pending (user_id, product_id, amount_ton, comment) VALUES (?, ?, ?, ?)'
    ).run(ctx.from.id, productId, amount, comment);
  } catch (_) {}

  waitingTonHash.set(ctx.from.id, { comment, productId, amount });

  await ctx.reply(
    `💎 <b>Оплата через TON</b>\n\n` +
    `Переведи ровно <b>${amount} TON</b> на кошелёк:\n\n` +
    `<code>${TON_WALLET}</code>\n\n` +
    `⚠️ <b>Обязательно</b> укажи в комментарии к переводу:\n` +
    `<code>${comment}</code>\n\n` +
    `После перевода нажми кнопку ниже — бот проверит платёж.\n\n` +
    `<i>/cancel — отменить</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('✅ Я оплатил — проверить', `check_ton_${productId}`).row()
        .text('❌ Отменить', 'catalog'),
    }
  );
});

// ─── Проверка TON-платежа ─────────────────────────────────────────────────────
bot.callbackQuery(/^check_ton_(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery('🔍 Проверяю платёж...');

  const userId    = ctx.from.id;
  const productId = parseInt(ctx.match[1]);
  const pending   = waitingTonHash.get(userId);

  if (!pending || pending.productId !== productId) {
    await ctx.reply('❌ Нет ожидающего платежа. Начни покупку заново через каталог.');
    return;
  }

  await ctx.reply('🔍 Проверяю транзакцию в блокчейне TON...');

  const tx = await checkTonTx(pending.comment, pending.amount);

  if (!tx) {
    await ctx.reply(
      `⏳ <b>Платёж пока не найден</b>\n\n` +
      `Транзакции иногда занимают 1–2 минуты.\n\n` +
      `Убедись что:\n` +
      `• Сумма: <b>${pending.amount} TON</b>\n` +
      `• Комментарий: <code>${pending.comment}</code>\n` +
      `• Кошелёк: <code>${TON_WALLET}</code>\n\n` +
      `Попробуй снова через минуту:`,
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('🔄 Проверить ещё раз', `check_ton_${productId}`).row()
          .text('❌ Отменить', 'catalog'),
      }
    );
    return;
  }

  // Платёж найден — выдаём товар
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) { await ctx.reply('⚠️ Товар не найден. Напишите администратору.'); return; }

  waitingTonHash.delete(userId);
  db.prepare('DELETE FROM ton_pending WHERE user_id = ?').run(userId);

  await deliverProduct(ctx, product, `💎 TON (${tx.amount.toFixed(2)})`);
});

// ─── Выдача товара покупателю ─────────────────────────────────────────────────
async function deliverProduct(ctx, product, paymentMethod) {
  await ctx.reply(
    `✅ <b>Оплата подтверждена!</b>\n` +
    `💳 Способ: ${paymentMethod}\n\n` +
    `Вот твой файл 👇`,
    { parse_mode: 'HTML' }
  );

  await ctx.replyWithDocument(product.file_id, {
    caption: `🎬 <b>${product.name}</b>\n\nПриятного использования!`,
    parse_mode: 'HTML',
  });

  // Уведомление всем авторизованным админам
  const admins = db.prepare('SELECT user_id FROM admin_sessions').all();
  for (const admin of admins) {
    try {
      await bot.api.sendMessage(admin.user_id,
        `💰 <b>Новая покупка!</b>\n\n` +
        `👤 ${ctx.from.first_name}${ctx.from.username ? ' (@' + ctx.from.username + ')' : ''}\n` +
        `🆔 ID: ${ctx.from.id}\n` +
        `🎬 Товар: ${product.name}\n` +
        `💳 Оплата: ${paymentMethod}`,
        { parse_mode: 'HTML' }
      );
    } catch (_) {}
  }
}

// ─── Показ админ-панели ───────────────────────────────────────────────────────
async function showAdminPanel(ctx) {
  const walletStatus = TON_WALLET
    ? `✅ <code>${TON_WALLET.slice(0,8)}...${TON_WALLET.slice(-6)}</code>`
    : '❌ не настроен';

  await ctx.reply(
    `🔧 <b>Админ-панель</b>\n\n` +
    `💎 TON-кошелёк: ${walletStatus}\n\n` +
    `Для выхода — /logout`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('➕ Добавить товар', 'admin_add').row()
        .text('📋 Список товаров', 'admin_list').row()
        .text('📊 Статистика', 'admin_stats'),
    }
  );
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
  const active  = db.prepare('SELECT COUNT(*) as c FROM products WHERE active = 1').get().c;
  const total   = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  const pending = db.prepare('SELECT COUNT(*) as c FROM ton_pending').get().c;
  await ctx.reply(
    `📊 <b>Статистика</b>\n\n` +
    `🎬 Активных товаров: <b>${active}</b>\n` +
    `📦 Всего товаров: <b>${total}</b>\n` +
    `⏳ Ожидают TON-оплаты: <b>${pending}</b>`,
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
    keyboard.text(`${p.active ? '✅' : '❌'} ${p.name} (${p.price_stars}⭐/${p.price_ton}💎)`, `admin_item_${p.id}`).row();
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
    `⭐ Stars: ${p.price_stars}\n` +
    `💎 TON: ${p.price_ton}\n` +
    `🖼 Превью: ${p.preview_file_id ? '✅ есть' : '❌ нет'}\n` +
    `Статус: ${p.active ? '✅ Активен' : '❌ Скрыт'}`;

  const keyboard = new InlineKeyboard()
    .text('✏️ Название',        `edit_name_${p.id}`).row()
    .text('✏️ Описание',        `edit_desc_${p.id}`).row()
    .text('✏️ Цена Stars',      `edit_price_${p.id}`).row()
    .text('✏️ Цена TON',        `edit_ton_${p.id}`).row()
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
  name:    { label: 'название',       hint: 'Введи новое название:',                                                    isFile: false },
  desc:    { label: 'описание',       hint: 'Введи новое описание (или «-» чтобы убрать):',                             isFile: false },
  price:   { label: 'цену Stars',     hint: 'Введи новую цену в Stars (целое число, мин. 1):',                          isFile: false },
  ton:     { label: 'цену TON',       hint: 'Введи новую цену в TON (дробное число, например: 1.5):',                   isFile: false },
  file:    { label: 'основной файл',  hint: 'Пришли новый MP4-файл ватермарки (основной, отправляется после оплаты):',  isFile: true  },
  preview: { label: 'превью-видео',   hint: 'Пришли MP4-видео для превью (показывается в каталоге до покупки):',        isFile: true  },
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
// Шаги: name → description → price_stars → price_ton → file → preview
bot.callbackQuery('admin_add', adminOnly(async (ctx) => {
  await ctx.answerCallbackQuery();
  addingProduct.set(ctx.from.id, { step: 'name', data: {} });
  await ctx.reply(
    '➕ <b>Добавление товара</b>\n\n' +
    'Шаг 1/6 — Введи <b>название</b> ватермарки:\n\n<i>/cancel — отменить</i>',
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
      await ctx.reply('⚠️ Жду файл MP4, а не текст.\n\n<i>/cancel — отменить</i>', { parse_mode: 'HTML' });
      return;
    }

    if (field === 'name') {
      db.prepare('UPDATE products SET name = ? WHERE id = ?').run(text, productId);
      await ctx.reply(`✅ Название обновлено: <b>${text}</b>`, { parse_mode: 'HTML' });
    } else if (field === 'desc') {
      const val = text === '-' ? null : text;
      db.prepare('UPDATE products SET description = ? WHERE id = ?').run(val, productId);
      await ctx.reply('✅ Описание обновлено.');
    } else if (field === 'price') {
      const price = parseInt(text);
      if (isNaN(price) || price < 1) { await ctx.reply('❌ Нужно целое число от 1. Попробуй ещё:'); return; }
      db.prepare('UPDATE products SET price_stars = ? WHERE id = ?').run(price, productId);
      await ctx.reply(`✅ Цена Stars обновлена: <b>${price} ⭐</b>`, { parse_mode: 'HTML' });
    } else if (field === 'ton') {
      const ton = parseFloat(text.replace(',', '.'));
      if (isNaN(ton) || ton <= 0) { await ctx.reply('❌ Введи корректное число (например: 1.5). Попробуй ещё:'); return; }
      db.prepare('UPDATE products SET price_ton = ? WHERE id = ?').run(ton, productId);
      await ctx.reply(`✅ Цена TON обновлена: <b>${ton} 💎</b>`, { parse_mode: 'HTML' });
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
      await ctx.reply('Шаг 2/6 — Введи <b>описание</b> (или «-» чтобы пропустить):', { parse_mode: 'HTML' });

    } else if (session.step === 'description') {
      session.data.description = text === '-' ? null : text;
      session.step = 'price_stars';
      await ctx.reply('Шаг 3/6 — Введи <b>цену в Stars</b> (целое число, мин. 1):', { parse_mode: 'HTML' });

    } else if (session.step === 'price_stars') {
      const price = parseInt(text);
      if (isNaN(price) || price < 1) { await ctx.reply('❌ Нужно целое число от 1. Попробуй ещё:'); return; }
      session.data.price_stars = price;
      session.step = 'price_ton';
      await ctx.reply('Шаг 4/6 — Введи <b>цену в TON</b> (дробное, например: <code>1.5</code>):', { parse_mode: 'HTML' });

    } else if (session.step === 'price_ton') {
      const ton = parseFloat(text.replace(',', '.'));
      if (isNaN(ton) || ton <= 0) { await ctx.reply('❌ Введи корректное число (например: 1.5). Попробуй ещё:'); return; }
      session.data.price_ton = ton;
      session.step = 'file';
      await ctx.reply(
        'Шаг 5/6 — Пришли <b>основной MP4-файл</b> ватермарки:\n\n<i>Этот файл получит покупатель после оплаты</i>',
        { parse_mode: 'HTML' }
      );

    } else if (session.step === 'preview') {
      await ctx.reply('⚠️ Жду MP4-видео для превью.\n\nПришли файл или /skip чтобы пропустить.', { parse_mode: 'HTML' });
    }
    return;
  }

  await next();
});

// ─── /skip — пропустить превью ────────────────────────────────────────────────
bot.command('skip', async (ctx) => {
  const userId = ctx.from.id;
  if (!addingProduct.has(userId)) return;
  const session = addingProduct.get(userId);
  if (session.step !== 'preview') return;
  await saveNewProduct(ctx, session.data, null);
});

// ─── Получение файла (добавление или редактирование) ─────────────────────────
bot.on(['message:video', 'message:document'], async (ctx, next) => {
  const userId = ctx.from.id;
  if (!isAdmin(userId)) return next();

  const fileId = ctx.message.video?.file_id ?? ctx.message.document?.file_id;
  if (!fileId) return next();

  // Редактирование файла
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
    } else { return next(); }
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    await showAdminItem(ctx, p);
    return;
  }

  // Добавление нового товара
  if (addingProduct.has(userId)) {
    const session = addingProduct.get(userId);

    if (session.step === 'file') {
      session.data.file_id = fileId;
      session.step = 'preview';
      addingProduct.set(userId, session);
      await ctx.reply(
        'Шаг 6/6 — Пришли <b>превью-видео</b> (MP4):\n\n' +
        '<i>Короткое видео для показа в каталоге.</i>\n\n' +
        '/skip — пропустить',
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (session.step === 'preview') {
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
    'INSERT INTO products (name, description, price_stars, price_ton, file_id, preview_file_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(data.name, data.description ?? null, data.price_stars, data.price_ton ?? 0, data.file_id, previewFileId);

  addingProduct.delete(userId);

  await ctx.reply(
    `✅ <b>Товар добавлен!</b>\n\n` +
    `🎬 ${data.name}\n` +
    `⭐ Stars: ${data.price_stars}\n` +
    `💎 TON: ${data.price_ton ?? 0}\n` +
    `🖼 Превью: ${previewFileId ? '✅ есть' : '❌ нет'}\n` +
    `🆔 ID: ${result.lastInsertRowid}`,
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📋 К списку', 'admin_list') }
  );
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
bot.catch((err) => console.error('Bot error:', err));
console.log('🚀 Watermark Bot запущен...');
bot.start();
