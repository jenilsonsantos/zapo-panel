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
  const token = crypto.randomBytes(48).toString('base64url')
  await db.query('INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))', [hashToken(token), user.id])
  res.cookie(COOKIE, token, options()).json({ ok: true, user: { name: user.name, email: user.email, role: user.role } })
}

// Cadastro público: cada pessoa cria o próprio tenant e torna-se sua administradora.
export async function register(req, res, next) {
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
    socket.data.user = user
    next()
  } catch { next(new Error('Não autenticado')) }
}
