import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'

const required = ['MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD']
for (const key of required) {
  if (!process.env[key]) throw new Error(`Variável obrigatória ausente: ${key}`)
}

export const db = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
})

export const id = () => crypto.randomUUID()
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex')

export async function initializeDatabase() {
  await db.query(`CREATE TABLE IF NOT EXISTS tenants (
    id CHAR(36) PRIMARY KEY, name VARCHAR(120) NOT NULL, slug VARCHAR(80) NOT NULL UNIQUE,
    status ENUM('active','suspended') NOT NULL DEFAULT 'active', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, role ENUM('super_admin','tenant_admin','agent') NOT NULL DEFAULT 'agent',
    active TINYINT(1) NOT NULL DEFAULT 1, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await db.query(`CREATE TABLE IF NOT EXISTS tenant_users (
    tenant_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, role ENUM('owner','admin','agent') NOT NULL DEFAULT 'agent',
    PRIMARY KEY (tenant_id, user_id), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await db.query(`CREATE TABLE IF NOT EXISTS app_sessions (
    token_hash CHAR(64) PRIMARY KEY, user_id CHAR(36) NOT NULL, expires_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_expiry (expires_at), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await db.query(`CREATE TABLE IF NOT EXISTS whatsapp_connections (
    id CHAR(36) PRIMARY KEY, tenant_id CHAR(36) NOT NULL, name VARCHAR(120) NOT NULL,
    session_key VARCHAR(120) NOT NULL UNIQUE, status VARCHAR(30) NOT NULL DEFAULT 'new', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await db.query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, actor_user_id CHAR(36) NULL, action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL, entity_id CHAR(36) NULL, details JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_audit_created (created_at),
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

export async function bootstrapSuperAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()
  const password = String(process.env.ADMIN_PASSWORD || '')
  if (!email || password.length < 14) {
    throw new Error('Defina ADMIN_EMAIL e uma ADMIN_PASSWORD com pelo menos 14 caracteres antes de iniciar.')
  }
  const [found] = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email])
  if (found.length) return
  const userId = id()
  await db.query('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [userId, 'Administrador', email, await bcrypt.hash(password, 12), 'super_admin'])
  console.log(`Superadministrador criado: ${email}`)
}

export async function findSession(rawToken) {
  if (!rawToken) return null
  const [rows] = await db.query(`SELECT u.id, u.name, u.email, u.role
    FROM app_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.active = 1 LIMIT 1`, [hashToken(rawToken)])
  return rows[0] || null
}
