// configuracao.js — preferências do bot (quem ele responde).
//
// A configuração fica salva no arquivo bot-config.json, na raiz do projeto,
// para não se perder quando o servidor reiniciar. A aba "Configurações" do
// painel lê e altera estes valores via Socket.IO (veja o server.js).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DIRETORIO_DADOS = process.env.DATA_DIR || '.'
mkdirSync(DIRETORIO_DADOS, { recursive: true })
const ARQUIVO = join(DIRETORIO_DADOS, 'bot-config.json')

// Valores usados quando o arquivo ainda não existe (primeira execução).
// Os padrões mantêm o comportamento clássico: responder todo mundo, em todo lugar.
const PADRAO = {
  modo: 'todos', // 'todos' ou 'somente_autorizados'
  autorizados: [], // números com DDI, só dígitos. ex: ['5511999999999']
  grupos: 'todos', // 'todos', 'nenhum' ou 'autorizados'
  gruposAutorizados: [], // IDs de grupo completos. ex: ['120363012345@g.us']
  webhookUrl: '', // URL que recebe um POST a cada mensagem (vazio = desligado)
}

const MODOS_GRUPO = ['todos', 'nenhum', 'autorizados']

// Garante que qualquer configuração (do arquivo ou vinda do painel)
// tenha o formato certo — nunca confie em dados externos sem validar.
function sanitizar(config) {
  const modo = config?.modo === 'somente_autorizados' ? 'somente_autorizados' : 'todos'

  const autorizados = Array.isArray(config?.autorizados)
    ? [...new Set( // Set elimina números repetidos
        config.autorizados
          .map((numero) => String(numero).replace(/\D/g, '')) // só dígitos
          .filter((numero) => numero.length >= 8 && numero.length <= 20)
      )]
    : []

  // Migração: versões antigas usavam responderGrupos (true/false).
  // Se o arquivo antigo dizia "false", vira o modo 'nenhum' de hoje.
  let grupos = MODOS_GRUPO.includes(config?.grupos)
    ? config.grupos
    : config?.responderGrupos === false
      ? 'nenhum'
      : 'todos'

  const gruposAutorizados = Array.isArray(config?.gruposAutorizados)
    ? [...new Set(
        config.gruposAutorizados
          .map((id) => String(id).trim())
          .filter((id) => /^[\w.-]+@g\.us$/.test(id)) // só IDs de grupo válidos
      )]
    : []

  // Webhook: só aceita URL http(s) — qualquer outra coisa vira desligado
  const urlBruta = String(config?.webhookUrl || '').trim().slice(0, 500)
  const webhookUrl = /^https?:\/\/.+/i.test(urlBruta) ? urlBruta : ''

  return { modo, autorizados, grupos, gruposAutorizados, webhookUrl }
}

function carregar() {
  if (!existsSync(ARQUIVO)) return { ...PADRAO }
  try {
    const lido = JSON.parse(readFileSync(ARQUIVO, 'utf8'))
    return sanitizar({ ...PADRAO, ...lido })
  } catch {
    console.error(`Arquivo ${ARQUIVO} inválido — usando a configuração padrão.`)
    return { ...PADRAO }
  }
}

// A configuração vive em memória e é recarregada do disco só na inicialização
let configuracao = carregar()

export function obterConfiguracao() {
  return configuracao
}

// Valida, aplica e grava no disco. Devolve a versão final (já sanitizada),
// que o server.js reenvia para todos os navegadores abertos.
export function salvarConfiguracao(nova) {
  configuracao = sanitizar(nova)
  writeFileSync(ARQUIVO, JSON.stringify(configuracao, null, 2) + '\n')
  return configuracao
}

// Decide se o bot deve responder a esta mensagem, seguindo a configuração.
// Usada pelo comandos.js logo no início do tratarMensagem.
export function podeResponder(event) {
  const { modo, autorizados, grupos, gruposAutorizados } = configuracao
  const chat = event.key.remoteJid || ''
  const ehGrupo = chat.endsWith('@g.us')

  // 1º filtro: o GRUPO pode? ('nenhum' bloqueia todos; 'autorizados' exige
  // que o grupo esteja marcado na aba Configurações do painel)
  if (ehGrupo) {
    if (grupos === 'nenhum') return false
    if (grupos === 'autorizados' && !gruposAutorizados.includes(chat)) return false
  }

  // 2º filtro: a PESSOA pode?
  if (modo === 'todos') return true

  // Em grupo, quem escreveu vem em key.participant; no privado é o próprio chat.
  // Normalizamos para só os dígitos: '5511999999999:3@s.whatsapp.net' → '5511999999999'
  // Obs.: contatos que chegam como LID (identidade anônima do WhatsApp) podem
  // não bater com o número — nesse caso, adicione o número pelo chat privado.
  const origem = ehGrupo ? event.key.participant || '' : chat
  const numero = String(origem).split('@')[0].split(':')[0].replace(/\D/g, '')

  return autorizados.includes(numero)
}
