import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'data.db'));

db.pragma('journal_mode = WAL');

// Таблица товаров
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price_stars INTEGER NOT NULL,
    price_ton REAL NOT NULL DEFAULT 0,
    file_id TEXT NOT NULL,
    preview_file_id TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Авторизованные администраторы (сессии по паролю)
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    user_id INTEGER PRIMARY KEY,
    authorized_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Ожидающие TON-платежи
db.exec(`
  CREATE TABLE IF NOT EXISTS ton_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    amount_ton REAL NOT NULL,
    comment TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Миграция: добавить price_ton если колонки нет
try {
  db.exec(`ALTER TABLE products ADD COLUMN price_ton REAL NOT NULL DEFAULT 0`);
} catch (_) {}

export default db;
