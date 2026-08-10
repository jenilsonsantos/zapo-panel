// app.js — o JavaScript do painel (roda no navegador).
// Conversa com o servidor via Socket.IO e atualiza a tela:
// status da conexão, QR code, lista de chats e mensagens em tempo real.

/* eslint-env browser */
/* global io, lucide */

// A página pode ser carregada por uma URL direta; sem sessão válida voltamos ao login.
fetch('/api/auth/me').then((resposta) => {
  if (!resposta.ok) location.replace('/login')
  return resposta.ok ? resposta.json() : null
}).then((dados) => {
  if (dados?.user?.role === 'super_admin') {
    document.querySelector('.topo-acoes')?.insertAdjacentHTML('afterbegin', '<a href="/admin" class="botao-privado" title="Administração">Admin</a>')
  }
}).catch(() => location.replace('/login'))

// ── Estado do painel (fica só na memória do navegador) ─────────────────────
// conversas: cada chat vira uma entrada { nome, mensagens: [...] }
const conversas = new Map()
let chatAtivo = null // qual chat está aberto na aba Conversas
// O primeiro chat é selecionado sozinho ao carregar a página — mas isso NÃO
// pode marcar nada como lido. Só o CLIQUE do usuário numa conversa conta.
let chatEscolhido = false
let totalRecebidas = 0
let totalEnviadas = 0

// Atalho para pegar elementos pelo id (só para o código ficar mais curto)
const $ = (id) => document.getElementById(id)

const socket = io()

// Preferência visual local: cada usuário pode recolher o menu sem afetar ninguém.
const sidebarToggle = $('sidebar-toggle')
function aplicarMenuRecolhido(recolhido) {
  document.body.classList.toggle('tenant-menu-recolhido', recolhido)
  sidebarToggle?.setAttribute('title', recolhido ? 'Expandir menu lateral' : 'Recolher menu lateral')
  if (sidebarToggle) sidebarToggle.innerHTML = `<i data-lucide="${recolhido ? 'panel-left-open' : 'panel-left-close'}"></i>`
  lucide.createIcons()
}
aplicarMenuRecolhido(localStorage.getItem('tenant-menu-recolhido') === '1')
sidebarToggle?.addEventListener('click', () => {
  const recolhido = !document.body.classList.contains('tenant-menu-recolhido')
  localStorage.setItem('tenant-menu-recolhido', recolhido ? '1' : '0')
  aplicarMenuRecolhido(recolhido)
})

// ── Segurança básica: nunca injetar texto de mensagem direto no HTML ──────
// (uma mensagem maliciosa poderia conter <script>; assim ela vira texto puro)
function escaparHtml(texto) {
  const div = document.createElement('div')
  div.textContent = texto ?? ''
  return div.innerHTML
}

// ── Formatação estilo WhatsApp nas bolhas ─────────────────────────────────
// Converte a notação do WhatsApp em HTML: *negrito*, _itálico_, ~riscado~,
// `código na linha`, ```bloco de código``` e linhas começando com "> ".
// A ordem importa: primeiro escapamos o HTML (segurança), depois protegemos
// os trechos de código com um marcador — senão o negrito/itálico bagunçaria
// o conteúdo deles (ex.: um _nome_de_variavel_ dentro do código).
function formatarTextoZap(texto) {
  const trechos = [] // códigos já prontos, guardados fora do texto
  const guardar = (html) => `\u0001${trechos.push(html) - 1}\u0001`

  let saida = escaparHtml(texto)
    // ```bloco de código``` (pode ocupar várias linhas)
    .replace(/```([\s\S]+?)```/g, (tudo, codigo) =>
      guardar(`<pre class="bolha-codigo">${codigo.replace(/^\n+|\n+$/g, '')}</pre>`))
    // `código na linha`
    .replace(/`([^`\n]+)`/g, (tudo, codigo) => guardar(`<code class="bolha-mono">${codigo}</code>`))

  saida = saida
    // Marcadores sem espaço encostado por dentro, sempre na mesma linha
    // (as mesmas regras do WhatsApp de verdade)
    .replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, '<strong>$1</strong>')
    .replace(/_([^\s_](?:[^_\n]*[^\s_])?)_/g, '<em>$1</em>')
    .replace(/~([^\s~](?:[^~\n]*[^\s~])?)~/g, '<del>$1</del>')
    // Linha começando com "> " vira citação (o escape transformou > em &gt;)
    .replace(/^&gt; ?(.*)$/gm, '<span class="bolha-citacao">$1</span>')
    // Quebras de linha do texto viram <br> (os blocos de código estão protegidos)
    .replace(/\n/g, '<br>')
    // A citação já ocupa a linha inteira — remove o <br> extra depois dela
    .replace(/(<\/span>)<br>/g, '$1')

  // Devolve os trechos de código para os lugares marcados
  return saida.replace(/\u0001(\d+)\u0001/g, (tudo, i) => trechos[i])
}

// ── Navegação da sidebar ───────────────────────────────────────────────────
const TITULOS = {
  'visao-geral': 'Visão geral',
  'conversas': 'Conversas',
  'comandos': 'Comandos do bot',
  'configuracoes': 'Configurações',
  'docs': 'Docs & IA',
}

document.querySelectorAll('.menu-item').forEach((botao) => {
  botao.addEventListener('click', () => {
    // marca o item clicado como ativo
    document.querySelectorAll('.menu-item').forEach((b) => b.classList.remove('ativo'))
    botao.classList.add('ativo')

    // mostra só a view escolhida
    const view = botao.dataset.view
    document.querySelectorAll('.view').forEach((v) => v.classList.add('oculto'))
    $(`view-${view}`).classList.remove('oculto')
    $('titulo-view').textContent = TITULOS[view]
  })
})

document.querySelectorAll('.tenant-hero-action[data-view]').forEach((botao) => {
  botao.addEventListener('click', () => document.querySelector(`.menu-item[data-view="${botao.dataset.view}"]`)?.click())
})

// ── Status da conexão (pill no topo + bolinha na sidebar + cards) ─────────
const STATUS_ROTULO = {
  iniciando: 'Iniciando',
  aguardando_qr: 'Aguardando QR',
  conectado: 'Conectado',
  desconectado: 'Desconectado',
}

const STATUS_ICONE = {
  iniciando: 'loader',
  aguardando_qr: 'qr-code',
  conectado: 'circle-check',
  desconectado: 'circle-x',
}

const STATUS_TEXTO_LONGO = {
  iniciando: 'Iniciando o servidor e preparando a sessão...',
  aguardando_qr: 'Aguardando o pareamento: escaneie o QR code abaixo com o celular.',
  conectado: 'Sessão ativa. O bot está respondendo aos comandos.',
  desconectado: 'Conexão caiu. O servidor vai tentar reconectar sozinho em alguns segundos.',
}

socket.on('status', (status) => {
  const rotulo = STATUS_ROTULO[status] || status

  $('pill-status').dataset.status = status
  $('pill-texto').textContent = rotulo
  $('pill-icone').innerHTML = `<i data-lucide="${STATUS_ICONE[status] || 'loader'}"></i>`

  $('ponto-status').dataset.status = status
  $('status-sidebar').textContent = rotulo
  $('texto-conexao').textContent = STATUS_TEXTO_LONGO[status] || rotulo

  // O card do QR só interessa enquanto estamos aguardando o pareamento.
  // Ele fica no topo da Visão geral — e rolamos para lá, para o QR nunca
  // ficar escondido caso a página esteja rolada para baixo.
  $('card-qr').classList.toggle('oculto', status !== 'aguardando_qr')
  $('card-conectado').classList.toggle('oculto', status !== 'conectado')
  if (status === 'aguardando_qr') $('view-visao-geral').scrollTop = 0

  // Botões de conexão: desconectar quando conectado, reconectar quando caiu
  $('botao-desconectar').classList.toggle('oculto', status !== 'conectado')
  $('botao-reconectar').classList.toggle('oculto', status !== 'desconectado')

  // Reconectou? A assinatura de presença zera por conexão — reassina o chat aberto
  if (status === 'conectado' && chatAtivo) {
    socket.emit('abrir_chat', chaveParaJid(chatAtivo))
  }

  lucide.createIcons() // desenha o ícone novo do pill
})

// ── Gerenciar a conexão ───────────────────────────────────────────────────
$('botao-desconectar').addEventListener('click', () => socket.emit('desconectar'))
$('botao-reconectar').addEventListener('click', () => socket.emit('reconectar'))

// ── Limpar histórico (2 cliques para evitar acidente) ─────────────────────
let timerConfirmarLimpar = null
$('botao-limpar').addEventListener('click', () => {
  const botao = $('botao-limpar')
  if (!botao.classList.contains('confirmar')) {
    // 1º clique: pede confirmação por 3 segundos
    botao.classList.add('confirmar')
    botao.title = 'Clique de novo para apagar TUDO'
    timerConfirmarLimpar = setTimeout(() => {
      botao.classList.remove('confirmar')
      botao.title = 'Limpar histórico de mensagens'
    }, 3000)
    return
  }
  // 2º clique: apaga de verdade (o servidor responde com o histórico vazio)
  clearTimeout(timerConfirmarLimpar)
  botao.classList.remove('confirmar')
  botao.title = 'Limpar histórico de mensagens'
  socket.emit('limpar_historico')
})

// ── QR code (chega já como imagem pronta, em dataURL) ─────────────────────
socket.on('qr', (dataUrl) => {
  $('imagem-qr').src = dataUrl
  $('imagem-qr').classList.remove('oculto')
  $('qr-aguardando').classList.add('oculto')
})

// ── Pareou: mostramos o número conectado na visão geral ───────────────────
socket.on('pareado', ({ numero }) => {
  $('numero-conectado').textContent = `Número conectado: ${formatarChat(normalizarChat(numero))}`
  $('numero-conectado').classList.remove('oculto')
})

// ── Dados da conta conectada (card "Aparelho conectado") ──────────────────
// O servidor manda nome, número, plataforma, horário da conexão e a foto
// de perfil (a foto chega num segundo evento, quando o download termina).
socket.on('conta', (conta) => {
  if (!conta) return

  const numeroLimpo = normalizarChat(conta.numero)
  const rotuloNumero = `+${numeroLimpo}`
  $('conta-nome').textContent = conta.nome || rotuloNumero
  // Sem nome de exibição, o número já ocupa a linha de cima — não repete
  $('conta-numero').textContent = conta.nome ? rotuloNumero : ''

  const detalhes = []
  if (conta.plataforma) detalhes.push(conta.plataforma)
  if (conta.conectadoEm) detalhes.push(`conectado ${formatarHora(conta.conectadoEm)}`)
  $('conta-detalhes').textContent = detalhes.join(' · ')

  // Foto de perfil da conta: mostra a imagem quando tiver; senão o ícone padrão
  const temFoto = Boolean(conta.foto)
  if (temFoto) $('conta-foto').src = conta.foto
  $('conta-foto').classList.toggle('oculto', !temFoto)
  $('conta-foto-padrao').classList.toggle('oculto', temFoto)

  // Aproveita para preencher o número no card Conexão (o evento 'pareado'
  // só acontece na hora de parear — este cobre também as reconexões)
  $('numero-conectado').textContent = `Número conectado: ${formatarChat(numeroLimpo)}`
  $('numero-conectado').classList.remove('oculto')

  lucide.createIcons()
})

// ── Mensagens (ao vivo e histórico) ───────────────────────────────────────

function atualizarMetricas() {
  $('metrica-recebidas').textContent = totalRecebidas
  $('metrica-enviadas').textContent = totalEnviadas

  // Métricas derivadas do que está em memória (histórico + tempo real)
  const hojeTexto = new Date().toDateString()
  let hoje = 0
  let naoLidas = 0
  let grupos = 0
  let midias = 0
  for (const [chave, conversa] of conversas) {
    naoLidas += conversa.naoLidas || 0
    if (chave.includes('@g.us')) grupos++
    for (const m of conversa.mensagens) {
      if (m.midia) midias++
      if (new Date(m.horario).toDateString() === hojeTexto) hoje++
    }
  }
  $('metrica-hoje').textContent = hoje
  $('metrica-naolidas').textContent = naoLidas
  $('metrica-conversas').textContent = conversas.size
  $('metrica-grupos').textContent = grupos
  $('metrica-midias').textContent = midias
  const mensagensRecebidas = [...conversas.values()].flatMap((conversa) => conversa.mensagens).filter((m) => !m.fromMe)
  const lidas = mensagensRecebidas.filter((m) => m.lida).length
  $('metrica-taxa').textContent = mensagensRecebidas.length ? `${Math.round((lidas / mensagensRecebidas.length) * 100)}%` : '0%'
}

// "No ar": o servidor manda quando iniciou; o painel atualiza a cada minuto
let servidorIniciadoEm = null

socket.on('info', ({ iniciadoEm } = {}) => {
  servidorIniciadoEm = iniciadoEm || null
  atualizarUptime()
})

function atualizarUptime() {
  if (!servidorIniciadoEm) return
  const minutos = Math.max(0, Math.floor((Date.now() - servidorIniciadoEm) / 60000))
  const horas = Math.floor(minutos / 60)
  $('metrica-uptime').textContent = horas > 0 ? `${horas}h ${minutos % 60}m` : `${minutos}m`
}
setInterval(atualizarUptime, 60000)

// Totais persistidos no servidor (não zeram nem encolhem no F5)
socket.on('contadores', ({ recebidas, enviadas } = {}) => {
  totalRecebidas = recebidas || 0
  totalEnviadas = enviadas || 0
  atualizarMetricas()
})

// Gráfico de barras: mensagens por hora nas últimas 24h (SVG puro, sem lib).
// Cada hora vira uma barra EMPILHADA: recebidas embaixo (verde) e enviadas
// em cima (azul), com um respiro de 2px entre as duas para separar as séries.
function renderizarGrafico() {
  const UMA_HORA = 3600000
  const agora = Date.now()
  const recebidasHora = new Array(24).fill(0) // índice 23 = hora atual
  const enviadasHora = new Array(24).fill(0)
  const chatsAtivos = new Set()
  let total = 0
  let midias = 0

  for (const [chave, conversa] of conversas) {
    for (const m of conversa.mensagens) {
      const idade = agora - new Date(m.horario).getTime()
      if (idade < 0 || idade >= 24 * UMA_HORA) continue
      const i = 23 - Math.floor(idade / UMA_HORA)
      if (m.fromMe) enviadasHora[i]++
      else recebidasHora[i]++
      if (m.midia) midias++
      chatsAtivos.add(chave)
      total++
    }
  }

  $('grafico-total').textContent = total

  // ── Mini-métricas embaixo do gráfico ──
  const totalRecebidas = recebidasHora.reduce((a, b) => a + b, 0)
  const totalEnviadas = enviadasHora.reduce((a, b) => a + b, 0)
  $('gstat-recebidas').textContent = totalRecebidas
  $('gstat-enviadas').textContent = totalEnviadas
  $('gstat-chats').textContent = chatsAtivos.size
  $('gstat-midias').textContent = midias

  // Hora de pico: a hora (cheia) com mais mensagens nas últimas 24h
  let indicePico = -1
  let maiorSoma = 0
  for (let i = 0; i < 24; i++) {
    const soma = recebidasHora[i] + enviadasHora[i]
    if (soma > maiorSoma) { maiorSoma = soma; indicePico = i }
  }
  if (indicePico >= 0) {
    const horaPico = new Date(agora - (23 - indicePico) * UMA_HORA).getHours()
    $('gstat-pico').textContent = `${String(horaPico).padStart(2, '0')}h–${String((horaPico + 1) % 24).padStart(2, '0')}h`
  } else {
    $('gstat-pico').textContent = '—'
  }

  // ── As barras ──
  const LARGURA = 240
  const ALTURA = 56
  const VAO = 2 // entre barras E entre os segmentos da pilha
  const larguraBarra = (LARGURA - VAO * 23) / 24
  const maximo = Math.max(...recebidasHora.map((v, i) => v + enviadasHora[i]), 1)

  let barras = ''
  for (let i = 0; i < 24; i++) {
    const rec = recebidasHora[i]
    const env = enviadasHora[i]
    const soma = rec + env
    const x = (i * (larguraBarra + VAO)).toFixed(2)
    const largura = larguraBarra.toFixed(2)
    const hora = new Date(agora - (23 - i) * UMA_HORA).getHours()
    const rotulo = `${String(hora).padStart(2, '0')}h: ${rec} recebida(s) · ${env} enviada(s)`

    // Hora sem mensagem: traço baixo cinza, como no oauth-hub
    if (soma === 0) {
      barras += `<rect class="barra vazia" x="${x}" y="${ALTURA - 3}" width="${largura}" height="3" rx="1.5"><title>${rotulo}</title></rect>`
      continue
    }

    // Altura total proporcional; cada série presente tem no mínimo 3px
    const alturaTotal = Math.max(rec && env ? 8 : 4, Math.round((soma / maximo) * ALTURA))
    const util = rec && env ? alturaTotal - VAO : alturaTotal
    const altRec = rec === 0 ? 0 : env === 0 ? util : Math.min(util - 3, Math.max(3, Math.round((rec / soma) * util)))
    const altEnv = env === 0 ? 0 : util - altRec
    const titulo = `<title>${rotulo}</title>`

    if (rec > 0) {
      barras += `<rect class="barra barra-recebidas" x="${x}" y="${ALTURA - altRec}" width="${largura}" height="${altRec}" rx="1.5">${titulo}</rect>`
    }
    if (env > 0) {
      const yEnv = ALTURA - altEnv - (rec > 0 ? altRec + VAO : 0)
      barras += `<rect class="barra barra-enviadas" x="${x}" y="${yEnv}" width="${largura}" height="${altEnv}" rx="1.5">${titulo}</rect>`
    }
  }

  $('grafico-atividade').innerHTML =
    `<svg viewBox="0 0 ${LARGURA} ${ALTURA}" preserveAspectRatio="none" role="img" aria-label="Mensagens recebidas e enviadas por hora">${barras}</svg>`
}

// Grupos têm o nome do GRUPO (vem da lista de grupos da conta),
// nunca o nome de quem mandou a última mensagem
function nomeDoGrupo(chave) {
  const grupo = gruposDaConta.find((g) => g.id === chave)
  return grupo ? grupo.nome : formatarChat(chave)
}

// Processa uma mensagem: atualiza contadores e a estrutura de conversas.
// Com { render: false } só acumula (usado no replay do histórico).
function processarMensagem(m, { render = true } = {}) {
  // Os totais oficiais vêm do servidor (evento 'contadores'); aqui só
  // incrementamos mensagens ao vivo — o replay do histórico não conta de novo
  if (render) {
    if (m.fromMe) totalEnviadas++
    else totalRecebidas++
  }

  // Normalizamos o id do chat para "5511999999999" (sem @s.whatsapp.net),
  // senão a mesma pessoa poderia virar dois chats diferentes na lista.
  const chave = normalizarChat(m.chat)
  const ehGrupo = chave.includes('@g.us')

  if (!conversas.has(chave)) {
    const nome = ehGrupo
      ? nomeDoGrupo(chave)
      : m.fromMe ? formatarChat(chave) : (m.nome || formatarChat(chave))
    conversas.set(chave, { nome, mensagens: [] })
  }
  const conversa = conversas.get(chave)

  // No privado, aproveitamos o nome do contato desta mensagem.
  // Em grupo NÃO: senão o chat ficaria com o nome de quem falou por último.
  if (!ehGrupo && !m.fromMe && m.nome) conversa.nome = m.nome

  conversa.mensagens.push(m)

  // Não lidas: mensagens ao vivo de chats fora da tela (outro chat, aba oculta
  // ou chat que só está "aberto" porque foi selecionado sozinho no carregamento)
  if (render && !m.fromMe && (!chatEscolhido || chave !== chatAtivo || document.hidden)) {
    conversa.naoLidas = (conversa.naoLidas || 0) + 1
  }

  // No replay do histórico (F5), o servidor informa quem ainda não foi lida —
  // é isso que faz o contador de não lidas sobreviver à atualização da página
  if (!render && !m.fromMe) {
    if (m.lida) m.lidaEnviada = true // já lida: não reenviar recibo de leitura
    else conversa.naoLidas = (conversa.naoLidas || 0) + 1
  }

  if (render && !m.fromMe) {
    // Chat que o usuário ESCOLHEU, aberto e visível: marca como lida de verdade
    if (chatEscolhido && chave === chatAtivo && !document.hidden) {
      marcarChatComoLido(chave)
    } else {
      notificar(m, chave) // fora da tela: notificação/som (se ligados)
    }
    // Mensagem nova desarquiva o chat (comportamento padrão do WhatsApp)
    if (estadoDoChat(chave).arquivado) estadoDoChat(chave).arquivado = false
  }

  // Mandou mensagem = parou de digitar
  if (render && digitandoEm.has(chave)) {
    clearTimeout(digitandoEm.get(chave))
    digitandoEm.delete(chave)
    atualizarDigitando()
  }

  // Primeiro chat que aparecer já fica selecionado
  if (!chatAtivo) {
    chatAtivo = chave
    if (render) $('campo-numero').value = chave
  }

  if (render) {
    atualizarMetricas()
    atualizarTitulo()
    renderizarGrafico()
    renderizarChats()
    if (chave === chatAtivo) renderizarMensagens()
  }
}

// Mensagem chegando ao vivo
socket.on('mensagem', (m) => processarMensagem(m))

// Histórico completo (chega ao abrir/atualizar a página — nada se perde no F5)
socket.on('historico', (lista) => {
  conversas.clear()
  chatAtivo = null
  chatEscolhido = false // F5 não é clique: nada de sair marcando como lido
  rolarParaFim = true
  for (const m of lista) processarMensagem(m, { render: false })
  atualizarMetricas()
  atualizarTitulo()
  renderizarGrafico()
  if (chatAtivo) $('campo-numero').value = chatAtivo
  renderizarChats()
  renderizarMensagens()
})

// ── Toast no canto da tela (erros em vermelho, confirmações em verde) ─────
let timerToast = null
function mostrarToast(mensagem, tipo = 'erro') {
  $('toast-texto').textContent = mensagem
  $('toast').classList.toggle('sucesso', tipo === 'sucesso')
  $('toast').classList.remove('oculto')
  clearTimeout(timerToast)
  timerToast = setTimeout(() => $('toast').classList.add('oculto'), 5000)
}

socket.on('erro', (mensagem) => mostrarToast(mensagem, 'erro'))

// ── Configurações do bot (aba Configurações) ──────────────────────────────
let configuracaoAtual = null
let aguardandoSalvar = false // para só mostrar "salvo" quando FOI a gente que salvou

socket.on('config', (config) => {
  configuracaoAtual = config
  renderizarConfiguracao()
  if (aguardandoSalvar) {
    aguardandoSalvar = false
    mostrarToast('Configuração salva.', 'sucesso')
  }
})

// Envia a configuração inteira com as mudanças por cima da atual
function salvarConfig(mudancas) {
  if (!configuracaoAtual) return
  aguardandoSalvar = true
  socket.emit('salvar_config', { ...configuracaoAtual, ...mudancas })
}

// Rádio "Todos" / "Somente autorizados"
document.querySelectorAll('input[name="modo-bot"]').forEach((radio) => {
  radio.addEventListener('change', () => salvarConfig({ modo: radio.value }))
})

// Rádio dos grupos: "Todos" / "Nenhum" / "Somente autorizados"
document.querySelectorAll('input[name="grupos-bot"]').forEach((radio) => {
  radio.addEventListener('change', () => salvarConfig({ grupos: radio.value }))
})

// Lista de grupos da conta (o servidor busca no WhatsApp e envia)
let gruposDaConta = []

socket.on('grupos', (lista) => {
  gruposDaConta = lista
  renderizarGrupos()

  // Aproveita os nomes reais para corrigir chats de grupo já abertos
  let mudouAlgum = false
  for (const [chave, conversa] of conversas) {
    if (!chave.includes('@g.us')) continue
    const grupo = lista.find((g) => g.id === chave)
    if (grupo && conversa.nome !== grupo.nome) {
      conversa.nome = grupo.nome
      mudouAlgum = true
    }
  }
  if (mudouAlgum) renderizarChats()
})

$('botao-atualizar-grupos').addEventListener('click', () => {
  socket.emit('listar_grupos')
})

// Marca/desmarca um grupo como autorizado
function alternarGrupo(id, marcado) {
  const atuais = configuracaoAtual.gruposAutorizados
  salvarConfig({
    gruposAutorizados: marcado ? [...atuais, id] : atuais.filter((g) => g !== id),
  })
}

function renderizarGrupos() {
  if (!configuracaoAtual) return // a config ainda não chegou do servidor

  // Junta os grupos da conta com os já autorizados (um grupo autorizado
  // pode não aparecer na lista, ex.: o bot saiu dele — mostramos mesmo assim
  // para dar como desmarcar).
  const conhecidos = new Map(gruposDaConta.map((g) => [g.id, g.nome]))
  for (const id of configuracaoAtual.gruposAutorizados) {
    if (!conhecidos.has(id)) conhecidos.set(id, id)
  }

  // Filtro da busca — grupos marcados aparecem sempre (para dar como desmarcar)
  const termo = ($('busca-grupos').value || '').trim().toLowerCase()

  $('grupos-vazio').classList.toggle('oculto', conhecidos.size > 0)

  let html = ''
  for (const [id, nome] of conhecidos) {
    const marcadoAgora = configuracaoAtual.gruposAutorizados.includes(id)
    if (termo && !marcadoAgora && !nome.toLowerCase().includes(termo)) continue
    const marcado = configuracaoAtual.gruposAutorizados.includes(id)
    html += `
      <li class="grupo">
        <label class="grupo-linha">
          <input type="checkbox" data-grupo="${escaparHtml(id)}" ${marcado ? 'checked' : ''}>
          <span class="grupo-textos">
            <span class="grupo-nome">${escaparHtml(nome)}</span>
            <small class="grupo-id">${escaparHtml(id)}</small>
          </span>
        </label>
      </li>`
  }
  $('lista-grupos').innerHTML = html

  $('lista-grupos').querySelectorAll('input[type="checkbox"]').forEach((caixa) => {
    caixa.addEventListener('change', () => alternarGrupo(caixa.dataset.grupo, caixa.checked))
  })
}

// Adicionar número autorizado
$('form-autorizado').addEventListener('submit', (evento) => {
  evento.preventDefault()
  const numero = $('campo-autorizado').value.replace(/\D/g, '') // só dígitos
  if (!numero) return
  if (numero.length < 8) {
    mostrarToast('Número muito curto — use o formato com DDI, ex: 5511999999999.')
    return
  }
  $('campo-autorizado').value = ''
  salvarConfig({ autorizados: [...configuracaoAtual.autorizados, numero] })
})

function removerAutorizado(numero) {
  salvarConfig({ autorizados: configuracaoAtual.autorizados.filter((n) => n !== numero) })
}

function renderizarConfiguracao() {
  const config = configuracaoAtual

  document.querySelectorAll('input[name="modo-bot"]').forEach((radio) => {
    radio.checked = radio.value === config.modo
  })
  document.querySelectorAll('input[name="grupos-bot"]').forEach((radio) => {
    radio.checked = radio.value === config.grupos
  })

  // As listas ficam esmaecidas quando o modo correspondente não as usa
  $('bloco-autorizados').classList.toggle('desabilitado', config.modo !== 'somente_autorizados')
  $('bloco-grupos').classList.toggle('desabilitado', config.grupos !== 'autorizados')

  // Webhook (não sobrescreve enquanto você digita no campo)
  if (document.activeElement !== $('campo-webhook')) {
    $('campo-webhook').value = config.webhookUrl || ''
  }

  $('autorizados-vazio').classList.toggle('oculto', config.autorizados.length > 0)
  let html = ''
  for (const numero of config.autorizados) {
    html += `
      <li class="autorizado">
        <span class="autorizado-numero"><i data-lucide="user-check"></i>+${escaparHtml(numero)}</span>
        <button type="button" class="remover-autorizado" data-numero="${escaparHtml(numero)}" title="Remover número">
          <i data-lucide="x"></i>
        </button>
      </li>`
  }
  $('autorizados').innerHTML = html
  $('autorizados').querySelectorAll('.remover-autorizado').forEach((botao) => {
    botao.addEventListener('click', () => removerAutorizado(botao.dataset.numero))
  })

  renderizarGrupos()
  lucide.createIcons()
}

// ── Responder (citar) uma mensagem ────────────────────────────────────────
let respondendoA = null // a mensagem sendo citada, ou null
let editandoMensagem = null // a mensagem NOSSA sendo editada, ou null

function iniciarResposta(m) {
  if (!m) return
  cancelarResposta() // sai de uma edição pendente, se houver
  respondendoA = m
  $('resposta-nome').textContent = m.fromMe ? 'Você' : (m.nome || '')
  $('resposta-texto').textContent = m.texto || ROTULO_MIDIA[m.midia?.tipo] || ''
  $('barra-resposta').classList.remove('oculto')
  lucide.createIcons()
  $('campo-texto').focus()
}

// Editar uma mensagem nossa: reusa a barrinha do reply e pré-preenche o campo
function iniciarEdicao(m) {
  if (!m?.fromMe || !m.texto) return
  cancelarResposta()
  editandoMensagem = m
  $('resposta-nome').textContent = 'Editando mensagem'
  $('resposta-texto').textContent = m.texto
  $('barra-resposta').classList.remove('oculto')
  $('campo-texto').value = m.texto
  lucide.createIcons()
  $('campo-texto').focus()
}

function cancelarResposta() {
  respondendoA = null
  if (editandoMensagem) {
    editandoMensagem = null
    $('campo-texto').value = '' // descarta o texto da edição abandonada
  }
  $('barra-resposta').classList.add('oculto')
}

$('cancelar-resposta').addEventListener('click', cancelarResposta)
// Esc no campo de texto cancela a citação
$('campo-texto').addEventListener('keydown', (evento) => {
  if (evento.key === 'Escape') cancelarResposta()
})

// ── Envio de mensagem pelo formulário ─────────────────────────────────────
$('form-enviar').addEventListener('submit', (evento) => {
  evento.preventDefault() // não deixa a página recarregar

  const numero = $('campo-numero').value.trim()
  const texto = $('campo-texto').value.trim()

  // Modo edição: em vez de mandar mensagem nova, edita a existente
  if (editandoMensagem) {
    if (!texto) return
    socket.emit('editar_mensagem', { chat: editandoMensagem.chat, id: editandoMensagem.id, texto })
    editandoMensagem = null
    $('barra-resposta').classList.add('oculto')
    $('campo-texto').value = ''
    return
  }

  if (!numero || !texto) return

  socket.emit('enviar', {
    numero,
    texto,
    // Se há uma citação ativa, manda a "chave" da mensagem citada
    responderA: respondendoA
      ? {
          chat: respondendoA.chat,
          id: respondendoA.id,
          fromMe: respondendoA.fromMe,
          participant: respondendoA.participant || null,
        }
      : null,
  })
  cancelarResposta()
  $('campo-texto').value = '' // limpa só o texto; o número fica para a próxima
})

// ── Funções de apoio ──────────────────────────────────────────────────────

// Transforma um JID do WhatsApp em uma chave estável de chat:
// "5511999999999:12@s.whatsapp.net" → "5511999999999"
// Grupos ("...@g.us") mantêm o sufixo para não confundir com pessoas.
// Contatos LID ("...@lid", a identidade anônima do WhatsApp) também mantêm:
// enviar só os dígitos de um LID faria o servidor tratar como telefone — e falhar.
function normalizarChat(jid) {
  if (!jid) return ''
  if (jid.includes('@g.us')) return jid
  if (jid.includes('@lid')) return `${jid.split('@')[0].split(':')[0]}@lid`
  return jid.split('@')[0].split(':')[0]
}

// Nome amigável para exibir quando não conhecemos o contato
function formatarChat(chave) {
  if (chave.includes('@g.us')) return `Grupo ${chave.split('@')[0]}`
  if (chave.includes('@lid')) return `Contato ${chave.split('@')[0]}`
  return `+${chave}`
}

let rolarParaFim = true // a próxima renderização das mensagens deve ir para o fim?

// Hora para mensagens de hoje; data + hora para dias anteriores
function formatarHora(iso) {
  const data = new Date(iso)
  const horaMinuto = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (data.toDateString() === new Date().toDateString()) return horaMinuto
  return `${data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${horaMinuto}`
}

// Título da aba mostra o total de não lidas: "(3) Zapo Painel"
function atualizarTitulo() {
  let total = 0
  for (const conversa of conversas.values()) total += conversa.naoLidas || 0
  document.title = total > 0 ? `(${total}) Zapo Painel` : 'Zapo Painel'
}

// ── Fotos de perfil (avatares) ────────────────────────────────────────────
let avatares = {} // chave normalizada do chat → url da foto

socket.on('avatares', (mapa) => {
  avatares = {}
  for (const [chat, url] of Object.entries(mapa || {})) {
    if (url) avatares[normalizarChat(chat)] = url
  }
  renderizarChats()
})

socket.on('avatar', ({ chat, url }) => {
  avatares[normalizarChat(chat)] = url
  renderizarChats()
})

// ── Recibos: os "tiques" das mensagens enviadas (✓ → ✓✓ → ✓✓ azul) ────────
const ORDEM_STATUS = { enviado: 0, entregue: 1, lido: 2 }

function htmlTicks(status) {
  const icone = status === 'entregue' || status === 'lido' ? 'check-check' : 'check'
  return `<i data-lucide="${icone}" class="ticks${status === 'lido' ? ' lido' : ''}"></i>`
}

socket.on('recibo', ({ chat, ids, status }) => {
  const chave = normalizarChat(chat)
  const conversa = conversas.get(chave)
  if (!conversa) return

  let mudou = false
  for (const m of conversa.mensagens) {
    if (m.fromMe && ids.includes(m.id) && ORDEM_STATUS[m.status || 'enviado'] < ORDEM_STATUS[status]) {
      m.status = status
      mudou = true
    }
  }
  if (mudou && chave === chatAtivo) renderizarMensagens()
})

// ── "digitando..." do contato ─────────────────────────────────────────────
// O servidor assina a presença do chat quando você o abre; aqui só exibimos.
const digitandoEm = new Map() // chave do chat → timer de expiração

socket.on('digitando', ({ chat, estado }) => {
  const chave = normalizarChat(chat)
  clearTimeout(digitandoEm.get(chave))
  if (estado === 'composing') {
    // Se o "parou de digitar" se perder, o aviso expira sozinho em 8s
    digitandoEm.set(chave, setTimeout(() => {
      digitandoEm.delete(chave)
      atualizarDigitando()
    }, 8000))
  } else {
    digitandoEm.delete(chave)
  }
  atualizarDigitando()
})

function atualizarDigitando() {
  $('indicador-digitando').classList.toggle('oculto', !digitandoEm.has(chatAtivo))
  renderizarChats() // a prévia do chat vira "digitando..."
}

// Converte a chave do chat num JID completo para a assinatura de presença
function chaveParaJid(chave) {
  return chave.includes('@') ? chave : `${chave}@s.whatsapp.net`
}

// ── Estado local dos chats: fixado, silenciado, arquivado ─────────────────
const estadoChats = new Map() // chave → { fixado, silenciado, arquivado }

function estadoDoChat(chave) {
  if (!estadoChats.has(chave)) {
    estadoChats.set(chave, { fixado: false, silenciado: false, arquivado: false })
  }
  return estadoChats.get(chave)
}

// ── Lida de verdade ───────────────────────────────────────────────────────
// Avisa o servidor quais mensagens foram vistas: o contato ganha os ✓✓ azuis
// e o chat é marcado como lido também no celular.
// Só roda depois de um clique do usuário — atualizar a página não conta.
function marcarChatComoLido(chave) {
  if (!chatEscolhido) return
  const conversa = conversas.get(chave)
  if (!conversa || document.hidden) return
  const ids = []
  for (const m of conversa.mensagens) {
    if (!m.fromMe && !m.lidaEnviada) {
      m.lidaEnviada = true // não reenviar o recibo da mesma mensagem
      ids.push(m.id)
    }
  }
  if (ids.length > 0) socket.emit('marcar_lido', { chat: chaveParaJid(chave), ids })
}

// Voltou para a aba com um chat aberto (que o usuário tinha escolhido)?
// Marca como lido agora
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && chatAtivo && chatEscolhido) {
    const conversa = conversas.get(chatAtivo)
    if (conversa) conversa.naoLidas = 0
    marcarChatComoLido(chatAtivo)
    atualizarTitulo()
    renderizarChats()
  }
})

// ── Notificações (área de trabalho + som) ─────────────────────────────────
const NOTIF_DESKTOP_KEY = 'zapo-notif-desktop'
const NOTIF_SOM_KEY = 'zapo-notif-som'

// Bipe curto via WebAudio — sem arquivo de som, sem dependência
function tocarSom() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const ganho = ctx.createGain()
    osc.connect(ganho)
    ganho.connect(ctx.destination)
    osc.frequency.value = 880
    ganho.gain.setValueAtTime(0.08, ctx.currentTime)
    ganho.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
    osc.start()
    osc.stop(ctx.currentTime + 0.25)
    osc.onended = () => ctx.close()
  } catch {
    // navegador bloqueou áudio sem interação — paciência
  }
}

function notificar(m, chave) {
  if (estadoDoChat(chave).silenciado) return // silenciado não incomoda

  if (localStorage.getItem(NOTIF_SOM_KEY) === '1') tocarSom()

  if (
    localStorage.getItem(NOTIF_DESKTOP_KEY) === '1' &&
    'Notification' in window &&
    Notification.permission === 'granted' &&
    document.hidden
  ) {
    const corpo = m.texto || ROTULO_MIDIA[m.midia?.tipo] || 'Mensagem nova'
    const aviso = new Notification(conversas.get(chave)?.nome || 'Zapo Painel', {
      body: corpo.slice(0, 120),
      icon: avatares[chave] || 'favicon-zapo.png',
    })
    aviso.onclick = () => {
      window.focus()
      selecionarChat(chave)
      aviso.close()
    }
  }
}

function selecionarChat(chave) {
  chatAtivo = chave
  chatEscolhido = true // clique de verdade: a partir daqui pode marcar como lido
  const conversa = conversas.get(chave)
  if (conversa) conversa.naoLidas = 0 // abriu = leu
  rolarParaFim = true
  // Preenche o destino para responder este chat direto.
  // Pode ser um número, um LID ("...@lid") ou até um grupo ("...@g.us") —
  // o zapo aceita qualquer um desses formatos no envio.
  $('campo-numero').value = chave
  // Assina a presença deste chat para receber o "digitando..." dele
  socket.emit('abrir_chat', chaveParaJid(chave))
  marcarChatComoLido(chave) // lida de verdade: o contato vê os ✓✓ azuis
  cancelarResposta() // reply pendente era do chat anterior
  renderizarChats()
  renderizarMensagens()
  atualizarTitulo()
  atualizarMetricas() // o card "Não lidas" muda ao abrir um chat
  atualizarDigitando()
  $('campo-texto').focus()
}

function renderizarChats() {
  const container = $('chats')
  $('chats-vazio').classList.toggle('oculto', conversas.size > 0)

  // Filtra pela busca (que também revela os arquivados) e ordena:
  // fixados primeiro, depois do mais recente para o mais antigo
  const termo = ($('busca-chats').value || '').trim().toLowerCase()
  const lista = [...conversas.entries()]
    .filter(([chave, conversa]) => {
      if (termo) return conversa.nome.toLowerCase().includes(termo)
      return !estadoDoChat(chave).arquivado // arquivado some da lista
    })
    .sort(([chaveA, a], [chaveB, b]) => {
      const fixadoA = estadoDoChat(chaveA).fixado ? 1 : 0
      const fixadoB = estadoDoChat(chaveB).fixado ? 1 : 0
      if (fixadoA !== fixadoB) return fixadoB - fixadoA
      const ultimaA = a.mensagens[a.mensagens.length - 1]?.horario || ''
      const ultimaB = b.mensagens[b.mensagens.length - 1]?.horario || ''
      return ultimaB.localeCompare(ultimaA) // datas ISO ordenam certo como texto
    })

  let html = ''
  for (const [chave, conversa] of lista) {
    const ultima = conversa.mensagens[conversa.mensagens.length - 1]
    const digitando = digitandoEm.has(chave)
    const previa = digitando
      ? 'digitando...'
      : ultima ? (ultima.texto || ROTULO_MIDIA[ultima.midia?.tipo] || '') : ''
    // Foto de perfil quando temos; senão o ícone padrão de pessoa/grupo
    const avatar = avatares[chave]
      ? `<img class="chat-avatar-img" src="${escaparHtml(avatares[chave])}" alt="" loading="lazy">`
      : `<span class="chat-avatar"><i data-lucide="${chave.includes('@g.us') ? 'users' : 'user'}"></i></span>`
    const estado = estadoDoChat(chave)
    const miniIcones =
      (estado.fixado ? '<i data-lucide="pin" class="mini-icone"></i>' : '') +
      (estado.silenciado ? '<i data-lucide="bell-off" class="mini-icone"></i>' : '')
    html += `
      <button class="chat-item ${chave === chatAtivo ? 'ativo' : ''}" data-chat="${escaparHtml(chave)}">
        ${avatar}
        <span class="chat-info">
          <span class="chat-nome">${escaparHtml(conversa.nome)}${miniIcones}</span>
          <span class="chat-previa${digitando ? ' digitando-previa' : ''}">${escaparHtml(previa)}</span>
        </span>
        ${conversa.naoLidas ? `<span class="badge-naolidas">${conversa.naoLidas}</span>` : ''}
      </button>`
  }
  container.innerHTML = html

  // Liga o clique (abrir) e o clique direito (menu de ações) de cada item
  container.querySelectorAll('.chat-item').forEach((item) => {
    item.addEventListener('click', () => selecionarChat(item.dataset.chat))
    item.addEventListener('contextmenu', (evento) => abrirMenuContexto(evento, item.dataset.chat))
  })

  lucide.createIcons() // desenha os ícones dos avatares recém-criados
}

function renderizarMensagens() {
  const container = $('mensagens')
  const conversa = conversas.get(chatAtivo)

  // Só "gruda" no fim se o usuário já estava perto do fim (ou trocou de chat).
  // Senão, quem sobe para ler mensagens antigas seria puxado para baixo
  // toda vez que chegasse mensagem nova.
  const deveRolar = rolarParaFim ||
    container.scrollHeight - container.scrollTop - container.clientHeight < 80
  rolarParaFim = false

  if (!conversa || conversa.mensagens.length === 0) {
    container.innerHTML = '<p class="mensagens-vazio">Nenhuma mensagem neste chat ainda.</p>'
    return
  }

  let html = ''
  conversa.mensagens.forEach((m, indice) => {
    const hora = formatarHora(m.horario)

    // Mensagem apagada para todos: vira só o aviso, sem ações
    if (m.apagada) {
      html += `
      <div class="bolha ${m.fromMe ? 'minha' : ''}">
        ${m.fromMe ? '' : `<div class="bolha-nome">${escaparHtml(m.nome)}</div>`}
        <em class="mensagem-apagada">Mensagem apagada</em>
        <div class="bolha-hora">${hora}</div>
      </div>`
      return
    }

    html += `
      <div class="bolha ${m.fromMe ? 'minha' : ''}">
        <span class="bolha-acoes">
          <button type="button" class="bolha-acao bolha-reagir" data-i="${indice}" title="Reagir"><i data-lucide="smile-plus"></i></button>
          <button type="button" class="bolha-acao bolha-responder" data-i="${indice}" title="Responder"><i data-lucide="corner-up-left"></i></button>
          ${m.fromMe && m.texto && !m.midia ? `<button type="button" class="bolha-acao bolha-editar" data-i="${indice}" title="Editar mensagem"><i data-lucide="pencil"></i></button>` : ''}
          ${m.fromMe ? `<button type="button" class="bolha-acao bolha-apagar" data-i="${indice}" title="Apagar para todos"><i data-lucide="trash-2"></i></button>` : ''}
        </span>
        ${m.fromMe ? '' : `<div class="bolha-nome">${escaparHtml(m.nome)}</div>`}
        ${htmlDaMidia(m)}
        ${m.texto ? `<div class="bolha-texto">${formatarTextoZap(m.texto)}</div>` : ''}
        <div class="bolha-hora">${m.editada ? '<span class="bolha-editada">editada</span>' : ''}${hora}${m.fromMe ? htmlTicks(m.status || 'enviado') : ''}</div>
        ${htmlReacoes(m)}
      </div>`
  })
  container.innerHTML = html

  // Ações de cada bolha: responder, reagir e apagar (2 cliques)
  container.querySelectorAll('.bolha-responder').forEach((botao) => {
    botao.addEventListener('click', () => iniciarResposta(conversa.mensagens[Number(botao.dataset.i)]))
  })
  container.querySelectorAll('.bolha-reagir').forEach((botao) => {
    botao.addEventListener('click', (evento) => abrirMenuReacoes(evento, conversa.mensagens[Number(botao.dataset.i)]))
  })
  container.querySelectorAll('.bolha-editar').forEach((botao) => {
    botao.addEventListener('click', () => iniciarEdicao(conversa.mensagens[Number(botao.dataset.i)]))
  })
  container.querySelectorAll('.bolha-apagar').forEach((botao) => {
    botao.addEventListener('click', () => {
      const m = conversa.mensagens[Number(botao.dataset.i)]
      if (!botao.classList.contains('confirmar')) {
        // 1º clique: pede confirmação por 3 segundos
        botao.classList.add('confirmar')
        botao.title = 'Clique de novo para apagar para todos'
        setTimeout(() => {
          botao.classList.remove('confirmar')
          botao.title = 'Apagar para todos'
        }, 3000)
        return
      }
      socket.emit('apagar_mensagem', { chat: m.chat, id: m.id, participant: m.participant || null })
    })
  })

  // Rola para a mensagem mais recente (quando faz sentido — veja acima)
  if (deveRolar) container.scrollTop = container.scrollHeight

  lucide.createIcons() // desenha os ícones das mensagens recém-renderizadas
}

// Reações agrupadas na bolha: "👍 2 ❤️"
function htmlReacoes(m) {
  const emojis = Object.values(m.reacoes || {}).filter(Boolean)
  if (emojis.length === 0) return ''
  const grupos = new Map()
  for (const emoji of emojis) grupos.set(emoji, (grupos.get(emoji) || 0) + 1)
  const texto = [...grupos].map(([emoji, n]) => (n > 1 ? `${emoji} ${n}` : emoji)).join(' ')
  return `<div class="bolha-reacoes">${escaparHtml(texto)}</div>`
}

// ── Reagir a uma mensagem ─────────────────────────────────────────────────
let mensagemDaReacao = null

function abrirMenuReacoes(evento, m) {
  evento.stopPropagation() // senão o clique global fecha o menu na hora
  mensagemDaReacao = m
  const menu = $('menu-reacoes')
  menu.classList.remove('oculto')
  menu.style.left = `${Math.min(evento.clientX, window.innerWidth - 310)}px`
  menu.style.top = `${Math.min(evento.clientY + 10, window.innerHeight - 70)}px`
}

$('menu-reacoes').querySelectorAll('button').forEach((botao) => {
  botao.addEventListener('click', () => {
    if (!mensagemDaReacao) return
    socket.emit('reagir', {
      chat: mensagemDaReacao.chat,
      id: mensagemDaReacao.id,
      fromMe: mensagemDaReacao.fromMe,
      participant: mensagemDaReacao.participant || null,
      emoji: botao.dataset.emoji || '', // vazio = remover a reação
    })
  })
})

// Reação chegou (nossa ou de alguém): atualiza a bolha alvo
socket.on('reacao', ({ chat, alvoId, autor, emoji }) => {
  const chave = normalizarChat(chat)
  const conversa = conversas.get(chave)
  const m = conversa?.mensagens.find((x) => x.id === alvoId)
  if (!m) return
  m.reacoes = m.reacoes || {}
  if (emoji) m.reacoes[autor] = emoji
  else delete m.reacoes[autor]
  if (chave === chatAtivo) renderizarMensagens()
})

// Mensagem editada (por nós, pelo contato, ou pelo celular do bot):
// troca o texto na bolha e ganha a etiqueta "editada"
socket.on('mensagem_editada', ({ chat, alvoId, novoTexto }) => {
  const chave = normalizarChat(chat)
  const conversa = conversas.get(chave)
  const m = conversa?.mensagens.find((x) => x.id === alvoId)
  if (!m) return
  m.texto = novoTexto || m.texto
  m.editada = true
  if (chave === chatAtivo) renderizarMensagens()
  renderizarChats() // a prévia do chat pode ser a mensagem editada
})

// Mensagem apagada para todos (por nós ou pelo contato)
socket.on('mensagem_apagada', ({ chat, alvoId }) => {
  const chave = normalizarChat(chat)
  const conversa = conversas.get(chave)
  const m = conversa?.mensagens.find((x) => x.id === alvoId)
  if (!m) return
  m.apagada = true
  m.texto = ''
  m.midia = null
  delete m.reacoes
  if (chave === chatAtivo) renderizarMensagens()
  renderizarChats() // a prévia pode ter sido a mensagem apagada
})

// Rótulos usados na prévia da lista de chats quando a última mensagem é mídia
const ROTULO_MIDIA = {
  imagem: 'Imagem',
  figurinha: 'Figurinha',
  video: 'Vídeo',
  audio: 'Áudio',
  documento: 'Documento',
}

// Monta o HTML da mídia dentro da bolha (imagem, figurinha, vídeo, áudio, documento)
function htmlDaMidia(m) {
  if (!m.midia) return ''
  const url = escaparHtml(m.midia.url)

  switch (m.midia.tipo) {
    case 'imagem':
      return `<a href="${url}" target="_blank" rel="noopener"><img class="bolha-midia" src="${url}" alt="Imagem" loading="lazy"></a>`
    case 'figurinha':
      return `<img class="bolha-midia figurinha" src="${url}" alt="Figurinha" loading="lazy">`
    case 'video':
      return `<video class="bolha-midia" src="${url}" controls preload="metadata"></video>`
    case 'audio':
      return `<audio class="bolha-audio" src="${url}" controls preload="metadata"></audio>`
    case 'documento':
      return `<a class="bolha-doc" href="${url}" target="_blank" rel="noopener"><i data-lucide="file-text"></i>${escaparHtml(m.midia.nomeArquivo || 'Documento')}</a>`
    default:
      return ''
  }
}

// ── Busca na lista de conversas ───────────────────────────────────────────
$('busca-chats').addEventListener('input', () => renderizarChats())

// ── Busca na lista de grupos (aba Configurações) ──────────────────────────
$('busca-grupos').addEventListener('input', () => renderizarGrupos())

// ── Pareamento por código (alternativa ao QR, sem câmera) ─────────────────
$('form-codigo').addEventListener('submit', (evento) => {
  evento.preventDefault()
  const numero = $('campo-numero-codigo').value.replace(/\D/g, '')
  if (numero.length < 8) {
    mostrarToast('Digite o número com DDI, ex: 5511999999999.')
    return
  }
  socket.emit('parear_codigo', numero)
})

socket.on('codigo_pareamento', (codigo) => {
  // Mostra como ABCD-EFGH para facilitar a digitação no celular
  const texto = String(codigo)
  $('codigo-texto').textContent = texto.length === 8 ? `${texto.slice(0, 4)}-${texto.slice(4)}` : texto
  $('codigo-gerado').classList.remove('oculto')
})

// ── Enviar arquivo pelo painel (clipe do compositor) ──────────────────────
$('botao-anexo').addEventListener('click', () => $('campo-arquivo').click())

$('campo-arquivo').addEventListener('change', async () => {
  const arquivo = $('campo-arquivo').files[0]
  $('campo-arquivo').value = '' // permite escolher o mesmo arquivo de novo depois
  if (!arquivo) return

  const numero = $('campo-numero').value.trim()
  if (!numero) {
    mostrarToast('Selecione um chat (ou preencha o destino) antes de anexar.')
    return
  }
  if (arquivo.size > 25 * 1024 * 1024) {
    mostrarToast('Arquivo grande demais — o limite é 25 MB.')
    return
  }

  mostrarToast(`Enviando ${arquivo.name}...`, 'sucesso')
  socket.emit('enviar_arquivo', {
    numero,
    nome: arquivo.name,
    mime: arquivo.type || 'application/octet-stream',
    dados: await arquivo.arrayBuffer(),
  })
})

// ── Menu de contexto do chat: fixar, silenciar, arquivar ──────────────────
let chatDoMenu = null

function abrirMenuContexto(evento, chave) {
  evento.preventDefault()
  chatDoMenu = chave
  const estado = estadoDoChat(chave)
  $('rotulo-fixar').textContent = estado.fixado ? 'Desafixar' : 'Fixar'
  $('rotulo-silenciar').textContent = estado.silenciado ? 'Reativar som' : 'Silenciar'
  $('rotulo-arquivar').textContent = estado.arquivado ? 'Desarquivar' : 'Arquivar'

  const menu = $('menu-contexto')
  menu.classList.remove('oculto')
  // não deixa o menu vazar para fora da janela
  menu.style.left = `${Math.min(evento.clientX, window.innerWidth - 190)}px`
  menu.style.top = `${Math.min(evento.clientY, window.innerHeight - 150)}px`
}

// Clique em qualquer lugar fecha os menus flutuantes
document.addEventListener('click', () => {
  $('menu-contexto').classList.add('oculto')
  $('menu-reacoes').classList.add('oculto')
})

$('menu-contexto').querySelectorAll('button').forEach((botao) => {
  botao.addEventListener('click', () => {
    if (!chatDoMenu) return
    const acao = botao.dataset.acao
    const estado = estadoDoChat(chatDoMenu)
    const atual = acao === 'fixar' ? estado.fixado : acao === 'silenciar' ? estado.silenciado : estado.arquivado
    socket.emit('acao_chat', { chat: chaveParaJid(chatDoMenu), acao, valor: !atual })
  })
})

// O servidor confirmou a ação: atualiza o estado local e a lista
socket.on('acao_chat_ok', ({ chat, acao, valor }) => {
  const chave = normalizarChat(chat)
  const estado = estadoDoChat(chave)

  if (acao === 'fixar') {
    estado.fixado = valor
    if (valor) estado.arquivado = false // fixar desfaz o arquivamento (regra do WhatsApp)
  } else if (acao === 'silenciar') {
    estado.silenciado = valor
  } else if (acao === 'arquivar') {
    estado.arquivado = valor
    if (valor) estado.fixado = false // arquivar desfaz o fixado
  }

  const nomes = {
    fixar: valor ? 'fixado' : 'desafixado',
    silenciar: valor ? 'silenciado' : 'com som reativado',
    arquivar: valor ? 'arquivado (some da lista; a busca ainda encontra)' : 'desarquivado',
  }
  mostrarToast(`Chat ${nomes[acao]}.`, 'sucesso')
  renderizarChats()
})

// ── Webhook de saída (aba Configurações) ──────────────────────────────────
$('form-webhook').addEventListener('submit', (evento) => {
  evento.preventDefault()
  const url = $('campo-webhook').value.trim()
  if (url && !/^https?:\/\//i.test(url)) {
    mostrarToast('A URL do webhook precisa começar com http:// ou https://.')
    return
  }
  salvarConfig({ webhookUrl: url })
})

$('botao-testar-webhook').addEventListener('click', () => socket.emit('testar_webhook'))

socket.on('webhook_teste', ({ ok, status, detalhe }) => {
  if (ok) mostrarToast(`Webhook respondeu ${status}. Tudo certo.`, 'sucesso')
  else mostrarToast(`Webhook falhou${status ? ` (HTTP ${status})` : ''}${detalhe ? `: ${detalhe}` : ''}.`)
})

// ── Perfil do bot (aba Configurações) ─────────────────────────────────────
$('form-perfil').addEventListener('submit', (evento) => {
  evento.preventDefault()
  const nome = $('campo-perfil-nome').value.trim()
  const recado = $('campo-perfil-recado').value.trim()
  if (!nome && !recado) {
    mostrarToast('Preencha o nome e/ou o recado para salvar.')
    return
  }
  socket.emit('atualizar_perfil', { nome, recado })
})

$('botao-foto-perfil').addEventListener('click', () => $('campo-foto-perfil').click())

$('campo-foto-perfil').addEventListener('change', async () => {
  const arquivo = $('campo-foto-perfil').files[0]
  $('campo-foto-perfil').value = ''
  if (!arquivo) return
  if (arquivo.size > 10 * 1024 * 1024) {
    mostrarToast('Escolha uma imagem de até 10 MB.')
    return
  }
  mostrarToast('Enviando a foto...', 'sucesso')
  socket.emit('atualizar_foto_perfil', { dados: await arquivo.arrayBuffer() })
})

socket.on('perfil_ok', (mensagem) => mostrarToast(mensagem, 'sucesso'))

// ── Interruptores de notificação ──────────────────────────────────────────
$('switch-notif-desktop').addEventListener('change', async () => {
  if ($('switch-notif-desktop').checked) {
    const permissao = await Notification.requestPermission()
    if (permissao !== 'granted') {
      $('switch-notif-desktop').checked = false
      mostrarToast('O navegador bloqueou as notificações — libere nas permissões do site.')
      return
    }
  }
  localStorage.setItem(NOTIF_DESKTOP_KEY, $('switch-notif-desktop').checked ? '1' : '')
})

$('switch-notif-som').addEventListener('change', () => {
  localStorage.setItem(NOTIF_SOM_KEY, $('switch-notif-som').checked ? '1' : '')
})

// Estado inicial dos interruptores (guardado no navegador)
$('switch-notif-desktop').checked =
  localStorage.getItem(NOTIF_DESKTOP_KEY) === '1' && 'Notification' in window && Notification.permission === 'granted'
$('switch-notif-som').checked = localStorage.getItem(NOTIF_SOM_KEY) === '1'

// ── Modo privado: borra dados sensíveis (ótimo para gravar vídeo/live) ────
// A preferência fica no navegador (localStorage), não no servidor.
const CHAVE_MODO_PRIVADO = 'zapo-modo-privado'

function aplicarModoPrivado(ativo) {
  document.body.classList.toggle('privado', ativo)
  $('botao-privado').classList.toggle('ativo', ativo)
  $('botao-privado').title = ativo
    ? 'Dados borrados — clique para mostrar'
    : 'Borrar dados sensíveis (modo gravação)'
  // olho fechado = dados escondidos; olho aberto = tudo visível
  $('icone-privado').innerHTML = `<i data-lucide="${ativo ? 'eye-off' : 'eye'}"></i>`
  lucide.createIcons()
}

$('botao-privado').addEventListener('click', () => {
  const ativo = !document.body.classList.contains('privado')
  localStorage.setItem(CHAVE_MODO_PRIVADO, ativo ? '1' : '')
  aplicarModoPrivado(ativo)
})

// Restaura a escolha da última visita
aplicarModoPrivado(localStorage.getItem(CHAVE_MODO_PRIVADO) === '1')

// Desenha todos os ícones estáticos da página na primeira carga
lucide.createIcons()
