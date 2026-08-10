// mensagens.js — nossa "biblioteca de bolso" para enviar mensagens com o zapo-js.
//
// A ideia aqui é simples: cada função embrulha um formato de mensagem do WhatsApp
// (texto, botões, lista, enquete...) para que o resto do projeto não precise
// decorar o formato "cru" da API. Copie este arquivo para os seus projetos!
//
// Todas as funções são async e recebem o `client` (criado no whatsapp.js)
// como primeiro parâmetro. O `para` pode ser só os dígitos ('5511999999999'),
// um JID completo ('...@s.whatsapp.net') ou um grupo ('...@g.us').

import { proto } from 'zapo-js';

// Texto simples — o "oi" básico. Passando só uma string, o zapo-js já entende.
export async function enviarTexto(client, para, texto) {
  return client.message.send(para, texto);
}

// Responder citando a mensagem original (aquele reply com a mensagem "presa" em cima).
// O `event` é o objeto que chega no client.on('message') — passamos ele inteiro
// na opção `quote` e o zapo-js preenche a citação sozinho.
export async function responder(client, event, texto) {
  return client.message.send(
    event.key.remoteJid,
    { type: 'text', text: texto },
    { quote: event }
  );
}

// Botões clássicos — aparecem como botõezinhos clicáveis embaixo do texto.
// `botoes` é um array no formato [{ id, texto }].
// Quando a pessoa clica, chega uma NOVA mensagem com
// event.message.buttonsResponseMessage.selectedButtonId === id do botão.
export async function enviarBotoes(client, para, { texto, rodape, botoes }) {
  return client.message.send(para, {
    buttonsMessage: {
      contentText: texto, // texto principal da mensagem
      footerText: rodape, // letras pequenas embaixo
      headerType: proto.Message.ButtonsMessage.HeaderType.TEXT,
      text: '', // título do cabeçalho (deixamos vazio, o contentText já basta)
      buttons: botoes.map((botao) => ({
        buttonId: botao.id, // é isso que volta quando clicam
        buttonText: { displayText: botao.texto }, // rótulo visível do botão
        type: proto.Message.ButtonsMessage.Button.Type.RESPONSE,
      })),
    },
  });
}

// Lista (menu) — aparece um botão que abre uma "gaveta" com seções e itens.
// Ótimo para cardápios! `secoes` = [{ titulo, itens: [{ id, titulo, descricao }] }].
// A escolha volta em event.message.listResponseMessage.singleSelectReply.selectedRowId.
export async function enviarLista(client, para, { titulo, descricao, textoBotao, rodape, secoes }) {
  return client.message.send(para, {
    listMessage: {
      title: titulo,
      description: descricao,
      buttonText: textoBotao, // texto do botão que abre a lista
      footerText: rodape,
      listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
      sections: secoes.map((secao) => ({
        title: secao.titulo,
        rows: secao.itens.map((item) => ({
          rowId: item.id, // é isso que volta quando escolhem o item
          title: item.titulo,
          description: item.descricao,
        })),
      })),
    },
  });
}

// Botão de URL — um botão que abre um link no navegador (não gera resposta no chat).
// Usa o formato "nativeFlow": o botão é descrito num JSON dentro de buttonParamsJson.
export async function enviarBotaoUrl(client, para, { texto, rodape, textoBotao, url }) {
  return client.message.send(para, {
    interactiveMessage: {
      body: { text: texto },
      footer: { text: rodape },
      nativeFlowMessage: {
        buttons: [
          {
            name: 'cta_url', // "call to action" de URL
            buttonParamsJson: JSON.stringify({ display_text: textoBotao, url }),
          },
        ],
        messageVersion: 1,
      },
    },
  });
}

// Enquete — as pessoas votam tocando nas opções.
// Os votos chegam no evento 'message_addon' com kind === 'poll_vote'.
export async function enviarEnquete(client, para, pergunta, opcoes) {
  return client.message.send(para, {
    type: 'poll',
    name: pergunta, // a pergunta da enquete
    options: opcoes, // array de strings, ex.: ['Calabresa', 'Chocolate']
    selectableCount: 1, // quantas opções cada pessoa pode marcar
  });
}

// Reação — aquele emoji que "gruda" na mensagem da pessoa.
// O `target` é a key da mensagem que vai receber o emoji.
export async function reagir(client, event, emoji) {
  return client.message.send(event.key.remoteJid, {
    type: 'reaction',
    emoji,
    target: event.key,
  });
}

// "Digitando..." — mostra o status de digitação por alguns segundos.
// Truque de UX: usar antes de responder deixa o bot com cara de gente. 😄
// composing = começa a "digitar", paused = para de "digitar".
export async function digitando(client, para, segundos) {
  await client.presence.sendChatstate(para, { state: 'composing' });
  // Promise + setTimeout = um "sleep" simples em JavaScript
  await new Promise((resolve) => setTimeout(resolve, segundos * 1000));
  await client.presence.sendChatstate(para, { state: 'paused' });
}
