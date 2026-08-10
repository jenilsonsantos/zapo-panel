// server.js — servidor web do painel zapo-panel
// Junta três peças: Express (serve a página), Socket.IO (conversa em tempo real
// com o navegador) e o WhatsApp (via iniciarWhatsapp do whatsapp.js).

import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { Server } from 'socket.io'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { iniciarWhatsapp } from './whatsapp.js'
import { obterConfiguracao, salvarConfiguracao } from './configuracao.js'
import { db, id, initializeDatabase, bootstrapSuperAdmin } from './database.js'
import { loadUser, requireUser, requireSuperAdmin, login, adminLogin, logout, register, updateAccount, socketUser } from './auth.js'

// "Silenciar para sempre": o cliente oficial usa um timestamp no ano 9999
const MUTE_PARA_SEMPRE = 253402300799000

// ── Webhook de saída ──────────────────────────────────────────────────────
// Se uma URL estiver configurada, cada evento vira um POST JSON nela.
// É o gancho para integrar com n8n, Make, ou qualquer sistema seu.
function dispararWebhook(evento, dados) {
  const { webhookUrl } = obterConfiguracao()
  if (!webhookUrl) return
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ evento, dados, horario: new Date().toISOString() }),
    signal: AbortSignal.timeout(8000),
  }).catch((erro) => {
    console.error('Webhook falhou:', erro?.message || erro)
  })
}

// A porta pode ser trocada com a variável de ambiente PORT (ex.: PORT=3005)
// — útil quando outro programa já está usando a porta 3000.
const PORTA = Number(process.env.PORT) || 3333
const DIRETORIO_DADOS = process.env.DATA_DIR || '.'
mkdirSync(DIRETORIO_DADOS, { recursive: true })

const app = express()
app.set('trust proxy', 1)
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))
app.use(express.json({ limit: '32kb' }))
app.use(loadUser)

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false })
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 4, standardHeaders: 'draft-8', legacyHeaders: false })
app.post('/api/auth/login', loginLimiter, login)
app.post('/api/auth/register', registerLimiter, register)
app.put('/api/auth/account', requireUser, loginLimiter, updateAccount)
app.post('/api/admin/login', loginLimiter, adminLogin)
app.post('/api/auth/logout', logout)
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado.' })
  res.json({ user: req.user })
})

app.get('/api/admin/tenants', requireUser, requireSuperAdmin, async (req, res, next) => {
  try {
    const [rows] = await db.query(`SELECT t.id, t.name, t.slug, t.status, t.created_at, COUNT(tu.user_id) AS users
      FROM tenants t LEFT JOIN tenant_users tu ON tu.tenant_id = t.id GROUP BY t.id ORDER BY t.created_at DESC`)
    res.json({ tenants: rows })
  } catch (error) { next(error) }
})

app.get('/api/admin/overview', requireUser, requireSuperAdmin, async (req, res, next) => {
  try {
    const [[counts]] = await db.query(`SELECT
      (SELECT COUNT(*) FROM tenants) AS tenants,
      (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS activeTenants,
      (SELECT COUNT(*) FROM users WHERE active = 1) AS activeUsers,
      (SELECT COUNT(*) FROM whatsapp_connections) AS connections`)
    const [recent] = await db.query(`SELECT a.action, a.entity_type, a.created_at, u.email AS actor
      FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.created_at DESC LIMIT 12`)
    res.json({ counts, recent })
  } catch (error) { next(error) }
})

app.get('/api/admin/users', requireUser, requireSuperAdmin, async (req, res, next) => {
  try {
    const [users] = await db.query(`SELECT u.id, u.name, u.email, u.role, u.active, u.created_at,
      GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ', ') AS tenants
      FROM users u LEFT JOIN tenant_users tu ON tu.user_id = u.id LEFT JOIN tenants t ON t.id = tu.tenant_id
      GROUP BY u.id ORDER BY u.created_at DESC LIMIT 200`)
    res.json({ users })
  } catch (error) { next(error) }
})

app.get('/api/admin/connections', requireUser, requireSuperAdmin, async (req, res, next) => {
  try {
    const [connections] = await db.query(`SELECT c.id, c.name, c.status, c.session_key, c.created_at, t.name AS tenant
      FROM whatsapp_connections c JOIN tenants t ON t.id = c.tenant_id ORDER BY c.created_at DESC LIMIT 200`)
    res.json({ connections })
  } catch (error) { next(error) }
})

app.post('/api/admin/tenants', requireUser, requireSuperAdmin, async (req, res, next) => {
  const name = String(req.body?.name || '').trim().slice(0, 120)
  const slug = String(req.body?.slug || '').trim().toLowerCase()
  const adminName = String(req.body?.adminName || '').trim().slice(0, 120)
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!name || !adminName || !/^[a-z0-9-]{3,80}$/.test(slug) || !/^\S+@\S+\.\S+$/.test(email) || password.length < 14) {
    return res.status(400).json({ error: 'Informe empresa, slug, administrador, e-mail válido e senha de no mínimo 14 caracteres.' })
  }
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    const tenantId = id(); const userId = id()
    const bcrypt = await import('bcryptjs')
    await connection.query('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)', [tenantId, name, slug])
    await connection.query('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)', [userId, adminName, email, await bcrypt.default.hash(password, 12), 'tenant_admin'])
    await connection.query('INSERT INTO tenant_users (tenant_id, user_id, role) VALUES (?, ?, ?)', [tenantId, userId, 'owner'])
    await connection.query('INSERT INTO whatsapp_connections (id, tenant_id, name, session_key) VALUES (?, ?, ?, ?)', [id(), tenantId, 'Conexão principal', `tenant-${tenantId}`])
    await connection.query('INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)', [req.user.id, 'tenant_created', 'tenant', tenantId, JSON.stringify({ name, slug })])
    await connection.commit()
    res.status(201).json({ ok: true, tenant: { id: tenantId, name, slug } })
  } catch (error) {
    await connection.rollback()
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Esse slug ou e-mail já está em uso.' })
    next(error)
  } finally { connection.release() }
})

app.patch('/api/admin/tenants/:id/status', requireUser, requireSuperAdmin, async (req, res, next) => {
  try {
    const status = req.body?.status === 'suspended' ? 'suspended' : 'active'
    await db.query('UPDATE tenants SET status = ? WHERE id = ?', [status, req.params.id])
    await db.query('INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)', [req.user.id, `tenant_${status}`, 'tenant', req.params.id, JSON.stringify({ status })])
    res.json({ ok: true })
  } catch (error) { next(error) }
})

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login')
  return res.redirect(req.user.role === 'super_admin' ? '/admin' : '/tenant/aguardando')
})
app.get('/index.html', (req, res) => {
  if (!req.user) return res.redirect('/login')
  if (req.user.role === 'super_admin') return res.redirect('/admin')
  return res.redirect('/tenant/aguardando')
})
app.get('/tenant/aguardando', (req, res) => {
  if (!req.user) return res.redirect('/login')
  if (req.user.role === 'super_admin') return res.redirect('/admin')
  res.sendFile(join(process.cwd(), 'public', 'tenant-pending.html'))
})
app.get('/tenant-pending.html', (req, res) => res.redirect('/tenant/aguardando'))
app.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'super_admin' ? '/admin' : '/')
  res.sendFile(join(process.cwd(), 'public', 'login.html'))
})
app.get('/login.html', (req, res) => res.redirect('/login'))
app.get('/cadastro', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'super_admin' ? '/admin' : '/')
  res.sendFile(join(process.cwd(), 'public', 'cadastro.html'))
})
app.get('/cadastro.html', (req, res) => res.redirect('/cadastro'))
app.get('/admin/login', (req, res) => {
  if (req.user?.role === 'super_admin') return res.redirect('/admin')
  if (req.user) return res.redirect('/')
  res.sendFile(join(process.cwd(), 'public', 'admin-login.html'))
})
app.get('/admin', (req, res) => {
  if (req.user?.role !== 'super_admin') return res.redirect('/admin/login')
  res.sendFile(join(process.cwd(), 'public', 'admin.html'))
})
app.get('/admin.html', (req, res) => res.redirect('/admin'))
const servidorHttp = http.createServer(app)
// maxHttpBufferSize maior para o envio de arquivos pelo painel (padrão é só 1 MB)
const io = new Server(servidorHttp, { maxHttpBufferSize: 30 * 1024 * 1024 })
io.use(socketUser)

// A pasta public/ tem o HTML, CSS e JS do painel
app.use(express.static('public', { index: false }))

// Ícones Lucide (mesmo conjunto do lucide-react, versão sem build):
// o navegador carrega o script direto do node_modules via esta rota.
app.use('/vendor', express.static('node_modules/lucide/dist/umd'))

// Mídias baixadas do WhatsApp (o whatsapp.js salva nesta pasta)
app.use('/midia', requireUser, express.static(join(DIRETORIO_DADOS, 'midia')))

// ── Histórico de mensagens (para os chats não sumirem no F5) ──────────────
// Guardamos as últimas mensagens num arquivo JSON simples. Ao abrir o painel,
// o navegador recebe tudo de uma vez no evento 'historico'.
const ARQUIVO_HISTORICO = join(DIRETORIO_DADOS, 'historico.json')
const LIMITE_HISTORICO = 300

let historico = []
if (existsSync(ARQUIVO_HISTORICO)) {
  try {
    historico = JSON.parse(readFileSync(ARQUIVO_HISTORICO, 'utf8'))
    // Mensagens salvas antes do controle de leitura não têm o campo 'lida' —
    // consideramos lidas, senão TUDO viraria "não lida" na primeira carga.
    for (const m of historico) {
      if (m.lida === undefined) m.lida = true
    }
  } catch {
    console.error(`Arquivo ${ARQUIVO_HISTORICO} inválido — começando com o histórico vazio.`)
  }
}

// ── Contadores de Recebidas/Enviadas (Visão geral) ────────────────────────
// Acumulados e persistidos à parte: o histórico guarda só as últimas mensagens,
// mas os contadores nunca "encolhem" ao atualizar a página.
const ARQUIVO_CONTADORES = join(DIRETORIO_DADOS, 'contadores.json')
let contadores = { recebidas: 0, enviadas: 0 }
if (existsSync(ARQUIVO_CONTADORES)) {
  try {
    contadores = { ...contadores, ...JSON.parse(readFileSync(ARQUIVO_CONTADORES, 'utf8')) }
  } catch {
    console.error(`Arquivo ${ARQUIVO_CONTADORES} inválido — recomeçando a contagem.`)
  }
} else {
  // Primeira execução desta versão: usa o histórico existente como ponto de partida
  contadores.recebidas = historico.filter((m) => !m.fromMe).length
  contadores.enviadas = historico.filter((m) => m.fromMe).length
}

let timerContadores = null
function contarMensagem(fromMe) {
  if (fromMe) contadores.enviadas++
  else contadores.recebidas++
  clearTimeout(timerContadores)
  timerContadores = setTimeout(() => {
    try {
      writeFileSync(ARQUIVO_CONTADORES, JSON.stringify(contadores))
    } catch (erro) {
      console.error('Erro ao salvar os contadores:', erro?.message || erro)
    }
  }, 800)
}

// Grava no disco com um pequeno atraso, para não escrever a cada mensagem
// numa rajada (chega uma enxurrada quando o bot está em grupos movimentados)
let timerHistorico = null
function agendarSalvarHistorico() {
  clearTimeout(timerHistorico)
  timerHistorico = setTimeout(() => {
    try {
      writeFileSync(ARQUIVO_HISTORICO, JSON.stringify(historico))
    } catch (erro) {
      console.error('Erro ao salvar o histórico:', erro?.message || erro)
    }
  }, 800)
}

function guardarNoHistorico(mensagem) {
  // Enviadas por nós nascem "lidas"; recebidas ficam pendentes até o usuário
  // clicar na conversa — é isso que mantém o contador de não lidas após o F5.
  if (mensagem.lida === undefined) mensagem.lida = Boolean(mensagem.fromMe)
  historico.push(mensagem)
  if (historico.length > LIMITE_HISTORICO) {
    historico = historico.slice(-LIMITE_HISTORICO)
  }
  agendarSalvarHistorico()
}

// Aplica uma reação (emoji vazio remove) na mensagem certa do histórico
function aplicarReacao(chat, alvoId, autor, emoji) {
  for (const m of historico) {
    if (m.id === alvoId && m.chat === chat) {
      m.reacoes = m.reacoes || {}
      if (emoji) m.reacoes[autor] = emoji
      else delete m.reacoes[autor]
      agendarSalvarHistorico()
      return
    }
  }
}

// Troca o texto de uma mensagem editada e marca com a etiqueta "editada"
function aplicarEditada(chat, alvoId, novoTexto) {
  for (const m of historico) {
    if (m.id === alvoId && m.chat === chat) {
      m.texto = novoTexto
      m.editada = true
      agendarSalvarHistorico()
      return
    }
  }
}

// Marca uma mensagem do histórico como apagada ("apagar para todos")
function aplicarApagada(chat, alvoId) {
  for (const m of historico) {
    if (m.id === alvoId && m.chat === chat) {
      m.apagada = true
      m.texto = ''
      m.midia = null
      delete m.reacoes
      agendarSalvarHistorico()
      return
    }
  }
}

// ── Fotos de perfil (avatares) ────────────────────────────────────────────
// Cache por chat: url do CDN do WhatsApp, ou null quando não tem/é privada.
const avatares = {}

async function buscarAvatar(chat) {
  if (!clientWhatsapp || chat in avatares) return
  avatares[chat] = null // marca já-buscado (evita repetir para quem não tem foto)
  try {
    const url = await controleWhatsapp?.buscarFoto(chat)
    if (url) {
      avatares[chat] = url
      io.emit('avatar', { chat, url })
    }
  } catch {
    // sem foto ou perfil privado — o painel mostra o ícone padrão
  }
}

// Ao conectar, busca as fotos dos chats que já estão no histórico
// (um por vez, sem pressa — cada busca é uma chamada de rede ao WhatsApp)
async function buscarAvataresDoHistorico() {
  const unicos = [...new Set(historico.filter((m) => !m.fromMe).map((m) => m.chat))]
  for (const chat of unicos) {
    await buscarAvatar(chat)
  }
}

// Guardamos o último status e o último QR para reenviar a quem conectar depois.
// Assim, dar refresh na página não quebra nada: o navegador recebe tudo de novo.
let ultimoStatus = 'iniciando'
let ultimoQrDataUrl = null

// O client do WhatsApp e os controles (desconectar/reconectar) ficam aqui
// depois que iniciarWhatsapp resolver
let clientWhatsapp = null
let controleWhatsapp = null

// Dados da conta conectada (número, nome, foto...) — mostrados no card
// "Aparelho conectado" da Visão geral. Atenção: extraímos SÓ os campos de
// exibição — as credenciais completas têm chaves secretas e nunca podem
// ir para o navegador.
let contaConectada = null

async function atualizarConta() {
  if (!clientWhatsapp) return
  try {
    const credenciais = clientWhatsapp.getCredentials()
    if (!credenciais?.meJid) return
    contaConectada = {
      numero: credenciais.meJid.split('@')[0].split(':')[0],
      nome: credenciais.pushName || '',
      plataforma: credenciais.platform || '',
      conectadoEm: new Date().toISOString(),
      foto: null,
    }
    io.emit('conta', contaConectada)

    // A foto vem por uma chamada de rede — busca depois e reenvia quando chegar
    const foto = await controleWhatsapp?.buscarFoto(credenciais.meJid)
    if (foto && contaConectada) {
      contaConectada.foto = foto
      io.emit('conta', contaConectada)
    }
  } catch (erro) {
    // Sem foto ou perfil privado não é problema; outros erros só logamos
    console.error('Erro ao buscar os dados da conta:', erro?.message || erro)
  }
}

// Grupos em que a conta participa: [{ id, nome }] — usados na aba
// Configurações para marcar quais grupos o bot pode responder.
let gruposDaConta = []

async function atualizarGrupos() {
  if (!clientWhatsapp) return
  try {
    const grupos = await clientWhatsapp.group.queryAllGroups()
    gruposDaConta = grupos.map((g) => ({ id: g.jid, nome: g.subject || g.jid }))
    io.emit('grupos', gruposDaConta)
  } catch (erro) {
    console.error('Erro ao listar os grupos da conta:', erro?.message || erro)
  }
}

// Quando um navegador conecta (ou dá refresh), mandamos o estado atual na hora
// Momento em que o servidor subiu — vira o card "No ar" do painel
const iniciadoEm = Date.now()

io.on('connection', (socket) => {
  socket.emit('info', { iniciadoEm })
  socket.emit('status', ultimoStatus)
  socket.emit('config', obterConfiguracao())
  socket.emit('grupos', gruposDaConta)
  if (contaConectada) socket.emit('conta', contaConectada)
  socket.emit('contadores', contadores)
  socket.emit('historico', historico)
  socket.emit('avatares', avatares)
  if (ultimoQrDataUrl) {
    socket.emit('qr', ultimoQrDataUrl)
  }

  // O painel abriu um chat: assina a presença dele para receber o "digitando..."
  socket.on('abrir_chat', (jid) => {
    const limpo = String(jid || '').trim()
    if (limpo) controleWhatsapp?.assinarPresenca(limpo)
  })

  // Botão "Atualizar lista" da aba Configurações
  socket.on('listar_grupos', () => {
    atualizarGrupos()
  })

  // Pareamento por código (alternativa ao QR): gera e devolve o código de 8 dígitos
  socket.on('parear_codigo', async (numero) => {
    try {
      const limpo = String(numero || '').replace(/\D/g, '')
      if (limpo.length < 8) {
        socket.emit('erro', 'Digite o número com DDI para gerar o código (ex: 5511999999999).')
        return
      }
      const codigo = await controleWhatsapp?.pedirCodigo(limpo)
      if (codigo) socket.emit('codigo_pareamento', codigo)
    } catch (erro) {
      console.error('Erro ao gerar código de pareamento:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível gerar o código. Confira o número e tente de novo.')
    }
  })

  // Envio de arquivo pelo painel: { numero, nome, mime, dados (bytes) }
  socket.on('enviar_arquivo', async (dados) => {
    try {
      const numero = String(dados?.numero || '').trim()
      const nome = String(dados?.nome || 'arquivo')
      const mime = String(dados?.mime || 'application/octet-stream')
      const bytes = Buffer.from(dados?.dados || [])

      if (!numero || bytes.length === 0) {
        socket.emit('erro', 'Escolha o destino e um arquivo válido.')
        return
      }
      if (bytes.length > 25 * 1024 * 1024) {
        socket.emit('erro', 'Arquivo grande demais — o limite do painel é 25 MB.')
        return
      }
      if (!clientWhatsapp) {
        socket.emit('erro', 'O WhatsApp ainda não está conectado.')
        return
      }

      // Salva na pasta midia/ (a mesma servida em /midia) para a bolha renderizar
      const nomeSeguro = `up-${Date.now()}-${nome.replace(/[^\w.-]/g, '_')}`
      const caminho = `midia/${nomeSeguro}`
      writeFileSync(caminho, bytes)

      // Decide o tipo de envio pelo mimetype
      const tipo = mime.startsWith('image/') ? 'image'
        : mime.startsWith('video/') ? 'video'
        : mime.startsWith('audio/') ? 'audio'
        : 'document'

      const conteudo = { type: tipo, media: caminho, mimetype: mime }
      if (tipo === 'document') conteudo.fileName = nome

      const resultado = await clientWhatsapp.message.send(numero, conteudo)

      // O whatsapp.js pula mídias no evento de envio — quem reporta é a gente,
      // que tem o arquivo local pronto para o painel exibir.
      const rotulos = { image: 'imagem', video: 'video', audio: 'audio', document: 'documento' }
      const mensagem = {
        id: resultado?.id || nomeSeguro,
        chat: numero,
        nome: 'Você',
        texto: '',
        midia: { tipo: rotulos[tipo], url: `/midia/${nomeSeguro}`, legenda: '', nomeArquivo: nome },
        fromMe: true,
        horario: new Date().toISOString(),
        status: 'enviado',
      }
      guardarNoHistorico(mensagem)
      io.emit('mensagem', mensagem)
    } catch (erro) {
      console.error('Erro ao enviar arquivo:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível enviar o arquivo.')
    }
  })

  // Reagir a uma mensagem pelo painel (emoji vazio = remover a reação)
  socket.on('reagir', async ({ chat, id, fromMe, participant, emoji } = {}) => {
    try {
      if (!clientWhatsapp || !chat || !id) return
      await clientWhatsapp.message.send(chat, {
        type: 'reaction',
        emoji: emoji || '',
        target: {
          remoteJid: chat,
          id,
          fromMe: Boolean(fromMe),
          ...(participant ? { participant } : {}),
        },
      })
      aplicarReacao(chat, id, 'eu', emoji || '')
      io.emit('reacao', { chat, alvoId: id, autor: 'eu', emoji: emoji || '' })
    } catch (erro) {
      console.error('Erro ao reagir:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível enviar a reação.')
    }
  })

  // Editar uma mensagem NOSSA já enviada: manda o texto novo com editKey
  socket.on('editar_mensagem', async ({ chat, id, texto } = {}) => {
    try {
      const novoTexto = String(texto || '').trim()
      if (!clientWhatsapp || !chat || !id || !novoTexto) return
      const jid = String(chat)

      const opcoes = { editKey: { id } }
      // Em grupo o alvo precisa do autor — que somos nós (só editamos as nossas)
      if (jid.endsWith('@g.us')) {
        const credenciais = clientWhatsapp.getCredentials()
        if (credenciais?.meJid) opcoes.editKey.participant = credenciais.meJid
      }

      await clientWhatsapp.message.send(jid, novoTexto, opcoes)
      aplicarEditada(chat, id, novoTexto)
      io.emit('mensagem_editada', { chat, alvoId: id, novoTexto })
    } catch (erro) {
      console.error('Erro ao editar mensagem:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível editar a mensagem.')
    }
  })

  // Apagar para todos uma mensagem NOSSA (revoke)
  socket.on('apagar_mensagem', async ({ chat, id, participant } = {}) => {
    try {
      if (!clientWhatsapp || !chat || !id) return
      await clientWhatsapp.message.send(chat, {
        type: 'revoke',
        target: {
          remoteJid: chat,
          id,
          fromMe: true, // só apagamos mensagens nossas
          ...(participant ? { participant } : {}),
        },
      })
      aplicarApagada(chat, id)
      io.emit('mensagem_apagada', { chat, alvoId: id })
    } catch (erro) {
      console.error('Erro ao apagar mensagem:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível apagar a mensagem.')
    }
  })

  // Lida de verdade: abriu o chat no painel = manda recibo de leitura
  // (o contato vê os ✓✓ azuis) e marca o chat como lido no app-state
  socket.on('marcar_lido', async ({ chat, ids } = {}) => {
    try {
      if (!clientWhatsapp || !chat) return
      const jid = String(chat)
      const todos = Array.isArray(ids) ? ids.filter(Boolean) : []

      // Grava a leitura no histórico ANTES das chamadas de rede: mesmo que o
      // recibo falhe, o contador de não lidas fica certo depois do F5.
      let mudou = false
      for (const m of historico) {
        if (!m.fromMe && !m.lida && todos.includes(m.id)) {
          m.lida = true
          mudou = true
        }
      }
      if (mudou) agendarSalvarHistorico()

      const lista = todos.slice(0, 100)
      // Recibo de leitura só em conversa 1:1 — em grupo exigiria o autor de cada mensagem
      if (lista.length > 0 && !jid.endsWith('@g.us')) {
        await clientWhatsapp.message.sendReceipt(jid, lista, { type: 'read' })
      }
      await clientWhatsapp.chat.setChatRead(jid, true)
    } catch (erro) {
      // Ação de fundo: falhou, só loga (sem toast enchendo o saco)
      console.error('Erro ao marcar como lido:', erro?.message || erro)
    }
  })

  // Ações de chat do menu de contexto: arquivar, fixar, silenciar
  socket.on('acao_chat', async ({ chat, acao, valor } = {}) => {
    try {
      if (!clientWhatsapp || !chat) return
      const jid = String(chat)
      const ligado = Boolean(valor)

      if (acao === 'arquivar') await clientWhatsapp.chat.setChatArchive(jid, ligado)
      else if (acao === 'fixar') await clientWhatsapp.chat.setChatPin(jid, ligado)
      else if (acao === 'silenciar') await clientWhatsapp.chat.setChatMute(jid, ligado, ligado ? MUTE_PARA_SEMPRE : undefined)
      else return

      socket.emit('acao_chat_ok', { chat, acao, valor: ligado })
    } catch (erro) {
      console.error('Erro na ação de chat:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível aplicar a ação no chat.')
    }
  })

  // Teste do webhook (botão na aba Configurações)
  socket.on('testar_webhook', async () => {
    const { webhookUrl } = obterConfiguracao()
    if (!webhookUrl) {
      socket.emit('erro', 'Salve a URL do webhook antes de testar.')
      return
    }
    try {
      const resposta = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evento: 'teste', dados: { mensagem: 'Olá do zapo-panel!' }, horario: new Date().toISOString() }),
        signal: AbortSignal.timeout(8000),
      })
      socket.emit('webhook_teste', { ok: resposta.ok, status: resposta.status })
    } catch (erro) {
      socket.emit('webhook_teste', { ok: false, detalhe: erro?.message || 'sem resposta' })
    }
  })

  // Perfil do bot: nome e recado
  socket.on('atualizar_perfil', async ({ nome, recado } = {}) => {
    try {
      if (!clientWhatsapp) {
        socket.emit('erro', 'Conecte o WhatsApp antes de mudar o perfil.')
        return
      }
      const nomeLimpo = String(nome || '').trim()
      const recadoLimpo = String(recado || '').trim()
      if (nomeLimpo) await clientWhatsapp.profile.setPushName(nomeLimpo.slice(0, 25))
      if (recadoLimpo) await clientWhatsapp.profile.setStatus(recadoLimpo.slice(0, 139))
      socket.emit('perfil_ok', 'Perfil atualizado.')
    } catch (erro) {
      console.error('Erro ao atualizar o perfil:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível atualizar o perfil.')
    }
  })

  // Perfil do bot: foto (convertida para JPEG quadrado, como o WhatsApp exige)
  socket.on('atualizar_foto_perfil', async (dados) => {
    try {
      if (!clientWhatsapp) {
        socket.emit('erro', 'Conecte o WhatsApp antes de trocar a foto.')
        return
      }
      const bytes = Buffer.from(dados?.dados || [])
      if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
        socket.emit('erro', 'Escolha uma imagem de até 10 MB.')
        return
      }
      const jpeg = await sharp(bytes)
        .resize(640, 640, { fit: 'cover' })
        .jpeg({ quality: 85 })
        .toBuffer()
      await clientWhatsapp.profile.setProfilePicture(new Uint8Array(jpeg))
      socket.emit('perfil_ok', 'Foto de perfil atualizada.')
    } catch (erro) {
      console.error('Erro ao trocar a foto de perfil:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível trocar a foto de perfil.')
    }
  })

  // Botões "Desconectar" / "Reconectar" da Visão geral
  socket.on('desconectar', async () => {
    try {
      await controleWhatsapp?.desconectar()
    } catch (erro) {
      console.error('Erro ao desconectar:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível desconectar.')
    }
  })

  socket.on('reconectar', () => {
    try {
      controleWhatsapp?.reconectar()
    } catch (erro) {
      console.error('Erro ao reconectar:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível reconectar.')
    }
  })

  // Botão de limpar histórico (aba Conversas): apaga as mensagens salvas
  // e as mídias baixadas, e avisa todos os navegadores abertos
  socket.on('limpar_historico', () => {
    try {
      historico = []
      clearTimeout(timerHistorico)
      writeFileSync(ARQUIVO_HISTORICO, '[]')
      rmSync('midia', { recursive: true, force: true })
      mkdirSync('midia', { recursive: true })
      // Limpar o painel zera os contadores também
      contadores = { recebidas: 0, enviadas: 0 }
      clearTimeout(timerContadores)
      writeFileSync(ARQUIVO_CONTADORES, JSON.stringify(contadores))
      io.emit('contadores', contadores)
      io.emit('historico', [])
    } catch (erro) {
      console.error('Erro ao limpar o histórico:', erro?.message || erro)
      socket.emit('erro', 'Não foi possível limpar o histórico.')
    }
  })

  // O painel salvou a aba Configurações: valida, grava no bot-config.json
  // e reenvia a versão final para TODOS os navegadores abertos ficarem iguais.
  socket.on('salvar_config', (novaConfig) => {
    try {
      const salva = salvarConfiguracao(novaConfig)
      io.emit('config', salva)
    } catch (erro) {
      console.error('Erro ao salvar configuração:', erro)
      socket.emit('erro', 'Não foi possível salvar a configuração.')
    }
  })

  // O painel pede para enviar uma mensagem: { numero, texto, responderA? }
  socket.on('enviar', async (dados) => {
    try {
      const numero = (dados?.numero || '').trim()
      const texto = (dados?.texto || '').trim()

      if (!numero || !texto) {
        socket.emit('erro', 'Preencha o número e o texto antes de enviar.')
        return
      }
      if (!clientWhatsapp) {
        socket.emit('erro', 'O WhatsApp ainda não está conectado. Aguarde um pouco.')
        return
      }

      // Reply: o painel manda a "chave" da mensagem citada e a lib monta a citação
      const opcoes = {}
      if (dados?.responderA?.id && dados?.responderA?.chat) {
        opcoes.quote = {
          remoteJid: dados.responderA.chat,
          id: dados.responderA.id,
          fromMe: Boolean(dados.responderA.fromMe),
          ...(dados.responderA.participant ? { participant: dados.responderA.participant } : {}),
        }
      }

      await clientWhatsapp.message.send(numero, texto, opcoes)

      // Não precisamos emitir 'mensagem' aqui: o whatsapp.js escuta o evento
      // 'message_send' da lib e já avisa o painel sobre toda mensagem enviada.
      // Emitir de novo faria a mensagem aparecer duplicada na tela.
    } catch (erro) {
      console.error('Erro ao enviar mensagem:', erro)
      socket.emit('erro', 'Não foi possível enviar a mensagem. Verifique o número e tente de novo.')
    }
  })
})

// Liga o WhatsApp e conecta cada acontecimento ao painel via Socket.IO
async function ligarWhatsapp() {
  try {
    const wa = await iniciarWhatsapp({
      // Chegou um QR novo: convertemos a string em imagem PNG (dataURL)
      // para o navegador só precisar colocar num <img src="...">
      aoQr: async (qrString) => {
        try {
          ultimoQrDataUrl = await QRCode.toDataURL(qrString)
          io.emit('qr', ultimoQrDataUrl)
        } catch (erro) {
          console.error('Erro ao gerar imagem do QR:', erro)
          io.emit('erro', 'Não foi possível gerar a imagem do QR code.')
        }
      },

      aoStatus: (status) => {
        ultimoStatus = status
        // Conectou: o QR antigo não serve mais, então limpamos —
        // e aproveitamos para buscar a lista de grupos da conta
        if (status === 'conectado') {
          ultimoQrDataUrl = null
          atualizarConta()
          atualizarGrupos()
          buscarAvataresDoHistorico()
        }
        io.emit('status', status)
        dispararWebhook('status', { status })
      },

      aoParear: (numero) => {
        io.emit('pareado', { numero })
      },

      aoMensagem: (mensagem) => {
        contarMensagem(mensagem.fromMe)
        guardarNoHistorico(mensagem)
        io.emit('mensagem', mensagem)
        dispararWebhook('mensagem', mensagem)
        // Busca a foto de perfil de quem mandou (uma vez por chat)
        if (!mensagem.fromMe) buscarAvatar(mensagem.chat)
      },

      // Recibo de mensagem enviada: atualiza os "tiques" (✓ → ✓✓ → ✓✓ azul)
      aoRecibo: (recibo) => {
        const novo = recibo.status === 'read' || recibo.status === 'played' ? 'lido'
          : recibo.status === 'delivered' ? 'entregue'
          : null
        if (!novo) return

        // Um recibo nunca REBAIXA o status (lido não volta para entregue)
        const ORDEM = { enviado: 0, entregue: 1, lido: 2 }
        let mudou = false
        for (const m of historico) {
          if (m.fromMe && recibo.ids.includes(m.id) && ORDEM[m.status || 'enviado'] < ORDEM[novo]) {
            m.status = novo
            mudou = true
          }
        }
        if (mudou) agendarSalvarHistorico()
        io.emit('recibo', { chat: recibo.chat, ids: recibo.ids, status: novo })
      },

      // O contato começou/parou de digitar
      aoDigitando: (info) => {
        io.emit('digitando', info)
      },

      // Reação recebida: grava na mensagem alvo e avisa o painel
      aoReacao: (info) => {
        aplicarReacao(info.chat, info.alvoId, info.autor, info.emoji)
        io.emit('reacao', info)
      },

      // Alguém apagou uma mensagem para todos
      aoApagada: (info) => {
        aplicarApagada(info.chat, info.alvoId)
        io.emit('mensagem_apagada', info)
      },

      // Alguém editou uma mensagem: troca o texto na bolha correspondente
      aoEditada: (info) => {
        aplicarEditada(info.chat, info.alvoId, info.novoTexto)
        io.emit('mensagem_editada', info)
      },
    })

    clientWhatsapp = wa.client
    controleWhatsapp = wa
  } catch (erro) {
    console.error('Erro ao iniciar o WhatsApp:', erro)
    io.emit('erro', 'Falha ao iniciar o WhatsApp. Veja o terminal para detalhes.')
  }
}

// Se alguma promise falhar sem catch, só logamos — o servidor continua vivo
process.on('unhandledRejection', (motivo) => {
  console.error('Promise rejeitada sem tratamento (o servidor continua rodando):', motivo)
})

async function iniciarServidor() {
  await initializeDatabase()
  await bootstrapSuperAdmin()
  servidorHttp.listen(PORTA, () => {
  console.log('')
  console.log('==============================================')
  console.log('  zapo-panel — painel de WhatsApp no ar!')
  console.log('')
  console.log(`  1. Abra no navegador: http://localhost:${PORTA}`)
  console.log('  2. O QR code vai aparecer na tela')
  console.log('  3. Escaneie com o WhatsApp do celular:')
  console.log('     Configurações > Aparelhos conectados')
  console.log('==============================================')
  console.log('')

  ligarWhatsapp()
  })
}

iniciarServidor().catch((erro) => {
  console.error('Falha crítica na inicialização:', erro)
  process.exit(1)
})
