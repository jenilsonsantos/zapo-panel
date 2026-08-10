import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { db, hashToken, findSession } from './database.js'

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
