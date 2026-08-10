import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db, id, hashToken, findSession } from './database.js'

const COOKIE = 'zapo_session'
const SEVEN_DAYS = 7 * 24 * 60 * 60

function cookieValue(header = '', name) {
  return header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

function options(maxAge = SEVEN_DAYS) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge }
}

export async function loadUser(req, res, next) {
  try {
    const raw = cookieValue(req.headers.cookie, COOKIE)
    req.user = await findSession(raw)
    next()
  } catch (error) { next(error) }
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Autenticação obrigatória.' })
  next()
}

export function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ error: 'Acesso restrito ao administrador.' })
  next()
}

export async function login(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const [rows] = await db.query('SELECT id, name, email, password_hash, role, active FROM users WHERE email = ? LIMIT 1', [email])
  const user = rows[0]
  if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' })
  }
  if (user.role === 'super_admin') {
    return res.status(403).json({ error: 'Esta é uma conta de administrador. Use /admin/login.' })
  }
  const token = crypto.randomBytes(48).toString('base64url')
  await db.query('INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))', [hashToken(token), user.id])
  res.cookie(COOKIE, token, options()).json({ ok: true, user: { name: user.name, email: user.email, role: user.role } })
}

// Login isolado do backoffice. Uma conta de empresa nunca ganha acesso ao /admin.
export async function adminLogin(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const [rows] = await db.query('SELECT id, name, email, password_hash, role, active FROM users WHERE email = ? LIMIT 1', [email])
  const user = rows[0]
  if (!user || !user.active || user.role !== 'super_admin' || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Credenciais de administrador inválidas.' })
  }
  const token = crypto.randomBytes(48).toString('base64url')
  await db.query('INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))', [hashToken(token), user.id])
  res.cookie(COOKIE, token, options()).json({ ok: true, user: { name: user.name, email: user.email, role: user.role } })
}

// Cadastro público: cada pessoa cria o próprio tenant e torna-se sua administradora.
export async function register(req, res, next) {
  if (req.user) return res.status(403).json({ error: 'Encerre a sessão atual antes de criar outra conta.' })
  const name = String(req.body?.name || '').trim().slice(0, 120)
  const company = String(req.body?.company || '').trim().slice(0, 120)
  const requestedSlug = String(req.body?.slug || '').trim().toLowerCase()
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!name || !company || !/^[a-z0-9-]{3,80}$/.test(requestedSlug) || !/^\S+@\S+\.\S+$/.test(email) || password.length < 14) {
    return res.status(400).json({ error: 'Preencha todos os campos. A senha precisa ter pelo menos 14 caracteres.' })
  }
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const tenantId = id(); const userId = id()
    await connection.query('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)', [tenantId, company, requestedSlug])
    await connection.query('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)', [userId, name, email, await bcrypt.hash(password, 12), 'tenant_admin'])
    await connection.query('INSERT INTO tenant_users (tenant_id, user_id, role) VALUES (?, ?, ?)', [tenantId, userId, 'owner'])
    await connection.query('INSERT INTO whatsapp_connections (id, tenant_id, name, session_key) VALUES (?, ?, ?, ?)', [id(), tenantId, 'Conexão principal', `tenant-${tenantId}`])
    const token = crypto.randomBytes(48).toString('base64url')
    await connection.query('INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))', [hashToken(token), userId])
    await connection.commit()
    res.cookie(COOKIE, token, options()).status(201).json({ ok: true, user: { name, email, role: 'tenant_admin' } })
  } catch (error) {
    await connection.rollback()
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Este e-mail ou identificador de empresa já está em uso.' })
    next(error)
  } finally { connection.release() }
}

// Mudanças de credenciais exigem a senha atual para proteger uma sessão deixada aberta.
export async function updateAccount(req, res, next) {
  const name = String(req.body?.name || '').trim().slice(0, 120)
  const email = String(req.body?.email || '').trim().toLowerCase()
  const currentPassword = String(req.body?.currentPassword || '')
  const newPassword = String(req.body?.newPassword || '')
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !currentPassword) {
    return res.status(400).json({ error: 'Informe nome, e-mail válido e sua senha atual.' })
  }
  if (newPassword && newPassword.length < 14) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 14 caracteres.' })
  try {
    const [rows] = await db.query('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [req.user.id])
    if (!rows[0] || !(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      return res.status(401).json({ error: 'A senha atual está incorreta.' })
    }
    const params = [name, email]
    let query = 'UPDATE users SET name = ?, email = ?'
    if (newPassword) { query += ', password_hash = ?'; params.push(await bcrypt.hash(newPassword, 12)) }
    query += ' WHERE id = ?'; params.push(req.user.id)
    await db.query(query, params)
    res.json({ ok: true, user: { name, email, role: req.user.role } })
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Este e-mail já está em uso.' })
    next(error)
  }
}

export async function logout(req, res) {
  const raw = cookieValue(req.headers.cookie, COOKIE)
  if (raw) await db.query('DELETE FROM app_sessions WHERE token_hash = ?', [hashToken(raw)])
  res.clearCookie(COOKIE, options(0)).json({ ok: true })
}

export async function socketUser(socket, next) {
  try {
    const raw = cookieValue(socket.request.headers.cookie, COOKIE)
    const user = await findSession(raw)
    if (!user) return next(new Error('Não autenticado'))
    if (user.role === 'super_admin') return next(new Error('Administrador não acessa o painel operacional'))
    // O cliente WhatsApp legado é singleton. Nunca o exponha para tenants até
    // o gerenciador de clientes isolados por tenant estar ativo.
    return next(new Error('A conexão WhatsApp da empresa ainda não foi provisionada'))
  } catch { next(new Error('Não autenticado')) }
}
