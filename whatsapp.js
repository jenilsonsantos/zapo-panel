// whatsapp.js — camada de conexão com o WhatsApp usando a lib zapo-js.
// Aqui a gente cria o client, escuta os eventos (QR, pareamento, conexão,
// mensagens) e avisa o resto do app através dos callbacks recebidos.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { WaClient, createStore, ConsoleLogger } from 'zapo-js'
import { createSqliteStore } from '@zapo-js/store-sqlite'
import { tratarMensagem } from './comandos.js'

// Algumas mensagens vêm "embrulhadas" (temporárias, ver-uma-vez, editadas):
// o conteúdo de verdade fica um nível abaixo, dentro de .message.
const EMBRULHOS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'editedMessage']
function desembrulhar(mensagem) {
  let atual = mensagem || {}
  let mudou = true
  while (mudou) {
    mudou = false
    for (const campo of EMBRULHOS) {
      if (atual[campo]?.message) {
        atual = atual[campo].message
        mudou = true
      }
    }
  }
  return atual
}

// Tira o texto "legível" de uma mensagem recebida.
// No WhatsApp o texto pode vir em campos diferentes dependendo do tipo:
// texto simples, texto com reply, clique em botão ou escolha em lista.
function extrairTexto(mensagem) {
  if (!mensagem) return ''
  mensagem = desembrulhar(mensagem)

  const enquete = mensagem.pollCreationMessage || mensagem.pollCreationMessageV3
  // Mensagens de template (as "mensagens estruturadas" da API oficial):
  // o texto fica dentro do hydratedTemplate
  const template = mensagem.templateMessage?.hydratedTemplate
    || mensagem.templateMessage?.hydratedFourRowTemplate
    || mensagem.highlyStructuredMessage?.hydratedHsm?.hydratedTemplate
  return (
    mensagem.conversation || // texto simples
    mensagem.extendedTextMessage?.text || // texto com reply/preview de link
    mensagem.buttonsResponseMessage?.selectedButtonId || // clique em botão
    mensagem.listResponseMessage?.singleSelectReply?.selectedRowId || // item de lista
    mensagem.templateButtonReplyMessage?.selectedDisplayText || // clique em botão de template
    mensagem.buttonsMessage?.contentText || // botões que o BOT envia
    mensagem.listMessage?.description || // lista que o BOT envia
    mensagem.interactiveMessage?.body?.text || // botão de URL que o BOT envia
    mensagem.interactiveResponseMessage?.body?.text || // resposta de mensagem interativa
    template?.hydratedContentText || template?.hydratedTitleText || // template da API oficial
    (enquete ? `Enquete: ${enquete.name}` : '') || // enquete que o BOT envia
    '[mensagem não suportada]'
  )
}

// Tipos de mídia que sabemos baixar e mostrar no painel.
// A chave é o campo dentro de event.message; o valor é o "tipo" que o front usa.
const TIPOS_MIDIA = {
  imageMessage: 'imagem',
  stickerMessage: 'figurinha',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'documento',
}

// Converte o mimetype ("image/jpeg; codecs=...") numa extensão de arquivo
function extensaoDoMimetype(mimetype = '') {
  const conhecidas = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  }
  const base = mimetype.split(';')[0].trim()
  return conhecidas[base] || base.split('/')[1] || 'bin'
}

// Se a mensagem tiver mídia, baixa (descriptografada) para a pasta midia/
// e devolve as informações que o painel precisa para renderizar.
async function baixarMidia(client, evento) {
  const mensagem = desembrulhar(evento.message)
  const campo = Object.keys(TIPOS_MIDIA).find((c) => mensagem[c])
  if (!campo) return null

  const info = mensagem[campo]
  try {
    const arquivo = `${evento.key.id}.${extensaoDoMimetype(info.mimetype)}`
    await client.message.downloadToFile(evento, `midia/${arquivo}`)
    return {
      tipo: TIPOS_MIDIA[campo],
      url: `/midia/${arquivo}`, // o server.js serve a pasta midia/ nessa rota
      legenda: info.caption || '',
      nomeArquivo: info.fileName || arquivo, // documentos têm nome original
    }
  } catch (erro) {
    console.error('Erro ao baixar mídia:', erro?.message || erro)
    return null
  }
}

// Inicia o WhatsApp e devolve o client já configurado.
// Os callbacks servem para o server.js reagir ao que acontece aqui.
export async function iniciarWhatsapp({ aoQr, aoStatus, aoParear, aoMensagem, aoRecibo, aoDigitando, aoReacao, aoApagada, aoEditada }) {
  // O store guarda a sessão num arquivo SQLite — assim você não precisa
  // escanear o QR de novo toda vez que reiniciar o servidor.
  // O SQLite não cria a pasta sozinho, então garantimos que ela existe antes.
  const diretorioDados = process.env.DATA_DIR || '.'
  const diretorioAuth = join(diretorioDados, '.auth')
  const diretorioMidia = join(diretorioDados, 'midia')
  mkdirSync(diretorioAuth, { recursive: true })
  mkdirSync(diretorioMidia, { recursive: true }) // mídias baixadas para o painel
  const store = createStore({
    backends: { sqlite: createSqliteStore({ path: join(diretorioAuth, 'state.sqlite') }) },
    providers: {
      auth: 'sqlite',
      signal: 'sqlite',
      preKey: 'sqlite',
      session: 'sqlite',
      identity: 'sqlite',
      senderKey: 'sqlite',
      appState: 'sqlite',
      privacyToken: 'sqlite',
      messages: 'sqlite',
      threads: 'sqlite',
      contacts: 'sqlite'
    }
  })

  // Logger em 'warn' para o terminal ficar limpo (só mostra avisos e erros).
  const client = new WaClient({ store, sessionId: 'default' }, new ConsoleLogger('warn'))

  // Os "Status" dos contatos chegam como mensagens de status@broadcast e
  // enchem o terminal com erros de descriptografia. Não interessam ao painel:
  // descartamos essas mensagens antes mesmo de qualquer handler rodar.
  client.ignoreKey({ remoteJid: 'status@broadcast' })

  aoStatus('iniciando')

  // Controle da reconexão: evita agendar duas reconexões ao mesmo tempo
  // e para de tentar se o celular desvinculou o aparelho (logout).
  let foiLogout = false
  let timerReconexao = null
  let pausadoManualmente = false // true = o usuário clicou em "Desconectar" no painel

  // Presença: só recebemos "digitando..." de chats que assinamos.
  // A assinatura vale por CONEXÃO — ao reconectar, é preciso assinar de novo.
  const presencasAssinadas = new Set()

  function conectar() {
    timerReconexao = null
    // connect() só resolve DEPOIS do pareamento, então não usamos await aqui —
    // senão o iniciarWhatsapp ficaria travado esperando o QR ser escaneado.
    client.connect().catch((erro) => {
      console.error('Erro ao conectar no WhatsApp:', erro?.message || erro)
      aoStatus('desconectado')
      agendarReconexao()
    })
  }

  function agendarReconexao() {
    if (foiLogout || pausadoManualmente || timerReconexao) return // pausado ou retry já marcado
    timerReconexao = setTimeout(conectar, 5000) // tenta de novo em 5 segundos
  }

  // Botão "Desconectar" do painel: fecha a conexão de propósito e segura a
  // reconexão automática até o usuário pedir para voltar. A sessão fica salva.
  async function desconectar() {
    pausadoManualmente = true
    clearTimeout(timerReconexao)
    timerReconexao = null
    await client.disconnect()
  }

  // Pareamento por código: alternativa ao QR. A pessoa digita o número dela,
  // recebe um código de 8 caracteres e digita no celular — sem câmera.
  async function pedirCodigo(numero) {
    return client.auth.requestPairingCode(String(numero).replace(/\D/g, ''))
  }

  // Assina a presença de um chat para receber o "digitando..." dele
  async function assinarPresenca(jid) {
    if (presencasAssinadas.has(jid)) return
    presencasAssinadas.add(jid)
    try {
      await client.presence.subscribe(jid)
    } catch (erro) {
      presencasAssinadas.delete(jid) // deixa tentar de novo depois
      console.error('Erro ao assinar presença:', erro?.message || erro)
    }
  }

  // Busca a foto de perfil (URL no CDN do WhatsApp) — null se não tiver/privada
  async function buscarFoto(jid) {
    const foto = await client.profile.getProfilePicture(jid)
    return foto?.url || null
  }

  // Botão "Reconectar" do painel: libera a reconexão e conecta na hora
  function reconectar() {
    if (foiLogout) {
      console.error('Sessão foi desvinculada no celular — apague a pasta .auth e reinicie para parear de novo.')
      return
    }
    pausadoManualmente = false
    conectar()
  }

  // Revogações ("apagar para todos") e edições chegam como mensagens de
  // PROTOCOLO. O tipo diz o que fazer; o alvo (key.id) diz em qual mensagem.
  function tratarProtocolo(chatDoEvento, protocolo) {
    const alvo = protocolo?.key
    if (!alvo?.id) return
    const chat = chatDoEvento || alvo.remoteJid || ''
    const tipo = protocolo.type // pode vir como número (enum) ou string

    // Edição: a mensagem NOVA vem dentro de editedMessage
    if (tipo === 'MESSAGE_EDIT' || tipo === 14) {
      console.log('Edição recebida — alvo:', alvo.id) // ajuda a conferir no terminal
      aoEditada?.({
        chat,
        alvoId: alvo.id,
        novoTexto: extrairTexto(protocolo.editedMessage),
      })
      return
    }

    // Revogação ("apagar para todos")
    if (tipo === 'REVOKE' || tipo === 0 || tipo === undefined || tipo === null) {
      aoApagada?.({ chat, alvoId: alvo.id })
    }
    // Outros tipos (sincronizações internas) não interessam ao painel
  }

  // A lib entrega as mensagens de protocolo num evento próprio — é por AQUI
  // que as edições de verdade chegam (o handler de 'message' acima é reserva).
  client.on('message_protocol', (evento) => {
    tratarProtocolo(evento.key?.remoteJid, evento.protocolMessage)
  })

  // IMPORTANTE: registrar todos os eventos ANTES de chamar connect(),
  // senão dá para perder o primeiro QR code.

  // Chegou um QR novo para escanear (ele se renova sozinho de tempos em tempos).
  client.on('auth_qr', ({ qr }) => {
    aoQr(qr)
    aoStatus('aguardando_qr')
  })

  // O celular escaneou o QR — pareamento concluído!
  client.on('auth_paired', ({ credentials }) => {
    aoParear(credentials.meJid)
    aoStatus('conectado')
  })

  // Mudanças na conexão: abriu ou fechou.
  client.on('connection', (evento) => {
    if (evento.status === 'open') {
      presencasAssinadas.clear() // conexão nova = assinaturas de presença zeradas
      aoStatus('conectado')
      return
    }

    if (evento.status === 'close') {
      aoStatus('desconectado')

      // isLogout = true significa que o aparelho foi desvinculado no celular.
      // Nesse caso NÃO adianta reconectar: precisa parear de novo do zero.
      if (evento.isLogout) {
        foiLogout = true
        console.error('Sessão encerrada no celular. Apague a pasta .auth e reinicie para parear de novo.')
        return
      }

      // Caiu por outro motivo (internet, servidor...) — a lib não reconecta
      // sozinha, então agendamos uma nova tentativa.
      agendarReconexao()
    }
  })

  // Chegou mensagem (de outra pessoa ou nossa, vinda de outro aparelho).
  client.on('message', async (evento) => {
    // Reações não viram bolha — "colam" na mensagem original. Em grupos elas
    // costumam chegar CRIPTOGRAFADAS (encReactionMessage); quem entrega a
    // reação decifrada é o evento message_addon, então aqui só descartamos.
    // O mesmo vale para votos de enquete, comentários, pins e afins.
    const conteudo = desembrulhar(evento.message)
    if (
      conteudo.reactionMessage ||
      conteudo.encReactionMessage ||
      conteudo.pollUpdateMessage ||
      conteudo.encCommentMessage ||
      conteudo.pinInChatMessage ||
      conteudo.keepInChatMessage ||
      conteudo.secretEncryptedMessage
    ) return

    // Mensagem de protocolo (revogação, edição...): trata e não vira bolha
    if (conteudo.protocolMessage) {
      tratarProtocolo(evento.key.remoteJid, conteudo.protocolMessage)
      return
    }

    // Se for mídia, baixa e usa a legenda como texto; senão, extrai o texto normal
    const midia = await baixarMidia(client, evento)
    const texto = midia ? midia.legenda : extrairTexto(evento.message)

    // Avisa o painel web sobre a mensagem.
    aoMensagem({
      id: evento.key.id,
      chat: evento.key.remoteJid,
      nome: evento.pushName || evento.key.participant || evento.key.remoteJid,
      texto,
      midia,
      participant: evento.key.participant || null, // autor, quando é grupo (usado no reply)
      fromMe: evento.key.fromMe,
      horario: evento.timestampSeconds
        ? new Date(evento.timestampSeconds * 1000).toISOString()
        : new Date().toISOString()
    })

    // Passa para o roteador de comandos (!ping, !menu...).
    // O try/catch garante que um erro num comando não derrube a conexão.
    try {
      await tratarMensagem(client, evento)
    } catch (erro) {
      console.error('Erro ao tratar comando:', erro?.message || erro)
    }
  })

  // Mensagens que o PRÓPRIO bot está enviando — assim as respostas
  // dele também aparecem no painel.
  client.on('message_send', (evento) => {
    // Reações (normais e criptografadas) e mensagens de protocolo (edição,
    // revogação...) não viram bolha — no WhatsApp elas "colam" na original.
    const m = desembrulhar(evento.message)
    if (m.reactionMessage || m.encReactionMessage || m.protocolMessage || m.pollUpdateMessage) return

    // Mídia enviada PELO PAINEL é reportada pelo próprio server.js (que tem
    // o arquivo local) — aqui a gente pula para não duplicar a bolha.
    if (m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage) return

    aoMensagem({
      id: evento.id || '',
      chat: evento.to,
      nome: 'Bot',
      texto: extrairTexto(evento.message),
      fromMe: true,
      horario: new Date().toISOString(),
      status: 'enviado' // os recibos (entregue/lido) atualizam depois
    })
  })

  // Recibo de mensagem que NÓS enviamos: entregue, lida, tocada (áudio)...
  client.on('receipt', (evento) => {
    if (evento.fromSelfDevice) return // sincronização dos próprios aparelhos
    aoRecibo?.({
      chat: evento.chatJid || '',
      ids: [...(evento.messageIds || [])],
      status: evento.status, // 'delivered' | 'read' | 'played' | ...
    })
  })

  // O contato está digitando/gravando (exige assinatura de presença no chat)
  client.on('chatstate', (evento) => {
    aoDigitando?.({ chat: evento.chatJid || '', estado: evento.state }) // 'composing' | 'paused'
  })

  // "Addons" criptografados colados numa mensagem original: reações,
  // votos de enquete E TAMBÉM as edições feitas por celulares mais novos
  // (que não chegam como message_protocol, e sim por aqui).
  client.on('message_addon', (evento) => {
    // Reação: cola o emoji na bolha original
    if (evento.kind === 'reaction') {
      const reacao = evento.message?.reactionMessage
      if (!reacao?.key?.id) return
      aoReacao?.({
        chat: reacao.key.remoteJid || evento.key?.remoteJid || '', // chat da mensagem alvo
        alvoId: reacao.key.id, // id da mensagem que recebeu a reação
        emoji: reacao.text || '', // vazio = reação removida
        // quem reagiu (para a mesma pessoa trocar a própria reação, não somar)
        autor: evento.key?.fromMe ? 'eu' : evento.key?.participant || evento.key?.remoteJid || 'contato',
      })
      return
    }

    const conteudo = desembrulhar(evento.message)

    // Edição vinda como addon: o conteúdo decifrado costuma ser a mesma
    // mensagem de protocolo (MESSAGE_EDIT) — reaproveitamos o tratador
    if (conteudo?.protocolMessage) {
      tratarProtocolo(evento.key?.remoteJid || '', conteudo.protocolMessage)
      return
    }

    // Edição em que o conteúdo já É a mensagem nova: o alvo vem no addon
    if (String(evento.kind || '').toLowerCase().includes('edit') && conteudo) {
      const alvoId = evento.targetMessageId || evento.targetKey?.id || evento.key?.id
      if (alvoId) {
        aoEditada?.({
          chat: evento.key?.remoteJid || '',
          alvoId,
          novoTexto: extrairTexto(conteudo),
        })
      }
      return
    }

    // Outros addons (voto de enquete etc.): loga o tipo para sabermos o que
    // está chegando — ajuda a diagnosticar sem poluir o painel
    console.log('Addon não tratado pelo painel:', evento.kind, Object.keys(conteudo || {}).join(', '))
  })

  // Agora sim: dispara a conexão sem travar o retorno da função.
  conectar()

  // Devolvemos o client + os controles que o painel usa
  return { client, desconectar, reconectar, pedirCodigo, assinarPresenca, buscarFoto }
}
