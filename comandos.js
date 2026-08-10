// comandos.js — o "cérebro" do bot: recebe cada mensagem e decide o que responder.
//
// O whatsapp.js chama tratarMensagem(client, event) para toda mensagem que chega.
// Aqui a gente extrai o texto (que pode vir de vários lugares diferentes,
// dependendo se foi texto digitado, clique em botão ou escolha numa lista)
// e roteia para o comando certo usando um switch.

import {
  responder,
  enviarBotoes,
  enviarLista,
  enviarBotaoUrl,
  enviarEnquete,
  reagir,
  digitando,
} from './mensagens.js';
import { podeResponder } from './configuracao.js';

// Nomes bonitos das pizzas, usados para confirmar o pedido da !lista.
// A chave é o rowId que definimos nas seções da lista.
const NOMES_DAS_PIZZAS = {
  'pizza-margherita': 'Margherita',
  'pizza-calabresa': 'Calabresa',
  'pizza-portuguesa': 'Portuguesa',
  'pizza-chocolate': 'Chocolate com Morango',
  'pizza-romeu-e-julieta': 'Romeu e Julieta',
};

// O texto de uma mensagem pode estar em campos diferentes do event.message,
// dependendo de COMO a pessoa interagiu. Testamos um por um:
function extrairTexto(mensagem) {
  if (!mensagem) return null;
  return (
    mensagem.conversation || // texto simples
    mensagem.extendedTextMessage?.text || // texto com reply ou preview de link
    mensagem.buttonsResponseMessage?.selectedButtonId || // clique em botão → vira o id do botão
    mensagem.listResponseMessage?.singleSelectReply?.selectedRowId || // escolha na lista → vira o rowId
    null
  );
}

export async function tratarMensagem(client, event) {
  // Ignora mensagens enviadas por nós mesmos (senão o bot responderia a si próprio!)
  if (event.key.fromMe) return;

  // Filtro da aba "Configurações" do painel: quem o bot pode responder
  // (todos, somente números autorizados, responder ou não em grupos).
  if (!podeResponder(event)) return;

  const texto = extrairTexto(event.message);
  if (!texto) return; // sem texto (foto, áudio, figurinha...) = nada a fazer

  const comando = texto.trim().toLowerCase();
  const chat = event.key.remoteJid; // o chat de onde veio a mensagem (é para lá que respondemos)

  // ── Cliques nos botões Sim/Não (do !botoes) ─────────────────────────────
  if (comando === 'sim') {
    await digitando(client, chat, 1.5);
    await responder(client, event, 'Boa! Anotado aqui: você disse SIM! ✅🎉');
    return;
  }
  if (comando === 'nao') {
    await digitando(client, chat, 1.5);
    await responder(client, event, 'Tudo bem, fica para a próxima então! ❌😅');
    return;
  }

  // ── Escolha na lista de pizzas (do !lista) ──────────────────────────────
  if (comando.startsWith('pizza-')) {
    // Busca o nome bonito; se não achar, improvisa a partir do id
    const nome = NOMES_DAS_PIZZAS[comando] || comando.replace('pizza-', '').replaceAll('-', ' ');
    await digitando(client, chat, 1.5);
    await responder(client, event, `Pedido confirmado: ${nome} 🍕 Já jogamos no forno! 🔥`);
    return;
  }

  // ── Comandos que começam com "!" ────────────────────────────────────────
  switch (comando) {
    case '!ping': {
      // Primeiro a reação na mensagem da pessoa, depois o pong
      await reagir(client, event, '🏓');
      await digitando(client, chat, 1.5);
      await responder(client, event, 'pong 🏓');
      break;
    }

    case '!menu': {
      await digitando(client, chat, 1.5);
      await responder(
        client,
        event,
        [
          '🤖 *Comandos do zapo-panel:*',
          '',
          '!ping — teste de vida (pong!)',
          '!menu — esta lista de comandos',
          '!botoes — botões de Sim/Não',
          '!lista — cardápio da pizzaria',
          '!link — botão com link do canal',
          '!enquete — vote no melhor sabor',
        ].join('\n')
      );
      break;
    }

    case '!botoes': {
      await digitando(client, chat, 1.5);
      await enviarBotoes(client, chat, {
        texto: 'Você está gostando do zapo-panel? 🤔',
        rodape: 'Toque em um botão para responder',
        botoes: [
          { id: 'sim', texto: 'Sim 👍' },
          { id: 'nao', texto: 'Não 👎' },
        ],
      });
      break;
    }

    case '!lista': {
      await digitando(client, chat, 1.5);
      await enviarLista(client, chat, {
        titulo: 'Pizzaria do Zapo 🍕',
        descricao: 'Escolha sua pizza no cardápio abaixo:',
        textoBotao: 'Ver cardápio',
        rodape: 'Entrega em 30 minutinhos',
        secoes: [
          {
            titulo: 'Pizzas Salgadas',
            itens: [
              { id: 'pizza-margherita', titulo: 'Margherita', descricao: 'Molho, muçarela e manjericão' },
              { id: 'pizza-calabresa', titulo: 'Calabresa', descricao: 'Calabresa fatiada com cebola' },
              { id: 'pizza-portuguesa', titulo: 'Portuguesa', descricao: 'Presunto, ovo, cebola e azeitona' },
            ],
          },
          {
            titulo: 'Pizzas Doces',
            itens: [
              { id: 'pizza-chocolate', titulo: 'Chocolate com Morango', descricao: 'Chocolate derretido e morangos' },
              { id: 'pizza-romeu-e-julieta', titulo: 'Romeu e Julieta', descricao: 'Goiabada com queijo' },
            ],
          },
        ],
      });
      break;
    }

    case '!link': {
      await digitando(client, chat, 1.5);
      await enviarBotaoUrl(client, chat, {
        texto: 'Curtiu o projeto? Se inscreve no canal para mais vídeos! 🎬',
        rodape: 'É de graça e ajuda demais',
        textoBotao: 'Abrir canal no YouTube',
        url: 'https://www.youtube.com/channel/UCrPbAoQKz42Gm0mLdWatAEA',
      });
      break;
    }

    case '!enquete': {
      await digitando(client, chat, 1.5);
      await enviarEnquete(client, chat, 'Qual é o melhor sabor de pizza? 🍕', [
        'Margherita',
        'Calabresa',
        'Portuguesa',
        'Chocolate com Morango',
      ]);
      break;
    }

    default: {
      // Começou com "!" mas não é um comando conhecido → dá uma dica
      if (comando.startsWith('!')) {
        await digitando(client, chat, 1.5);
        await responder(client, event, `Não conheço o comando *${comando}* 🤔 Digite *!menu* para ver o que eu sei fazer!`);
      }
      // Mensagens normais (sem "!") são ignoradas de propósito:
      // o bot só responde quando é chamado.
    }
  }
}
