# 🤖 zapo-panel — Painel de WhatsApp + Bot de Comandos

O **zapo-panel** é um painel web que conecta no seu WhatsApp usando a biblioteca [zapo-js](https://zapo.to). Ele mostra um QR code no navegador, exibe as mensagens chegando em tempo real e ainda traz um bot que responde comandos como `!ping`, `!menu` e `!enquete` — com botões, listas e enquetes de verdade dentro do WhatsApp. Este é o projeto construído no vídeo do canal, feito de propósito para quem está **começando agora** em programação. 🎬

---

## ⚠️ Leia antes de usar

Sério, leia. São 30 segundos:

- A zapo-js é uma biblioteca **NÃO-oficial**. Ela não tem nenhuma ligação com o WhatsApp/Meta.
- Usar automação no WhatsApp **pode resultar em banimento do número**. Isso é raro em uso de teste, mas o risco existe.
- Por isso: **use um CHIP DE TESTE** 📱 — aquele chip velho na gaveta serve. **NÃO use seu número principal**, nem o número da empresa, nem o da sua mãe.
- Este é um projeto **educacional**, para aprender programação. Não use para enviar spam (além de feio, é o caminho mais rápido para o banimento).

Combinado? Então bora. 🚀

---

## ✅ Requisitos

Você só precisa de **uma** coisa instalada: o **Node.js versão 20.9 ou mais nova**.

O Node.js é o programa que roda código JavaScript no seu computador (fora do navegador). Baixe no site oficial: **https://nodejs.org** — clique no botão verde da versão **LTS** e instale clicando em "Avançar" até o fim.

**Como conferir se já tem (Windows):**

1. Aperte a tecla `Windows`, digite `cmd` e aperte `Enter`. Vai abrir uma janela preta — isso é o **terminal** (não morde).
2. Digite o comando abaixo e aperte `Enter`:

```
node --version
```

Se aparecer algo como `v20.11.0` ou `v22.x.x`, está tudo certo. Se aparecer um número menor que `20.9`, ou um erro tipo "não é reconhecido", instale/atualize pelo site acima e **feche e abra o terminal de novo**.

---

## 🚀 Passo a passo para rodar

### 1. Baixe o projeto

**Opção A — sem instalar nada (mais fácil):**
na página do projeto no GitHub, clique no botão verde **`Code`** > **`Download ZIP`**. Depois clique com o botão direito no arquivo baixado > **Extrair tudo**.

**Opção B — se você já tem o Git:**

```
git clone https://github.com/SEU-USUARIO/zapo-panel.git
```

### 2. Abra o terminal DENTRO da pasta do projeto

Jeito fácil no Windows: abra a pasta do projeto no Explorador de Arquivos, clique na **barra de endereço** lá em cima, digite `cmd` e aperte `Enter`. O terminal abre já no lugar certo.

### 3. Instale as dependências

```
npm install
```

Isso baixa todas as bibliotecas que o projeto usa (zapo-js, express, socket.io...). Pode demorar um pouco na primeira vez — é normal aparecer MUITA coisa na tela.

### 4. Ligue o servidor

```
npm start
```

Se aparecer o quadro `zapo-panel — painel de WhatsApp no ar!` com o endereço `http://localhost:3333`, funcionou! Deixe essa janela **aberta** — se fechar, o painel desliga.

> 💡 Porta 3333 ocupada por outro programa? Rode com outra porta: `set PORT=3005` e depois `npm start` (aí o endereço vira `http://localhost:3005`).

### 5. Abra o painel no navegador

Acesse: **http://localhost:3333**

Vai aparecer um QR code na tela. 📷

### 6. Escaneie o QR com o WhatsApp do chip de teste

No celular, abra o WhatsApp e vá em:

> **Configurações** (ou os 3 pontinhos ⋮ no Android) > **Dispositivos conectados** > **Conectar dispositivo** > aponte a câmera para o QR na tela do computador.

Quando conectar, o painel muda para "conectado" e as mensagens começam a aparecer. Pronto, você tem um bot de WhatsApp rodando! 🎉

---

## 🐳 Alternativa: rodar com Docker

Tem Docker Desktop instalado? Então nem precisa instalar o Node — dentro da pasta do projeto:

```
docker compose up -d
```

Abra **http://localhost:3333** e escaneie o QR. Pronto.

- A sessão do WhatsApp fica guardada num volume do Docker (`dados-sessao`) — parar e subir de novo **não** pede QR.
- O `bot-config.json` (suas configurações do bot) continua na pasta do projeto, visível aqui fora.
- Mudou o código? `docker compose restart` aplica. Mudou as dependências (`package.json`)? `docker compose up -d --build -V`.
- Para parar: `docker compose down` (a sessão fica). Para apagar tudo, inclusive a sessão: `docker compose down -v`.

---

## 💬 Comandos do bot

Mande estas mensagens para o número conectado (de outro celular, ou peça para um amigo):

| Comando    | O que acontece |
|------------|----------------|
| `!ping`    | O bot responde `pong 🏓` e ainda reage à sua mensagem. O "alô, tá me ouvindo?" dos bots. |
| `!menu`    | Lista todos os comandos disponíveis, respondendo (reply) a sua mensagem. |
| `!botoes`  | Manda uma mensagem com botões de **Sim / Não**. Clique e veja o bot confirmar sua escolha. |
| `!lista`   | Abre o cardápio da nossa pizzaria fictícia 🍕, com 2 seções para escolher. Escolheu? "Pedido confirmado!" |
| `!link`    | Manda um botão que abre o canal do YouTube. Marketing raiz. 😄 |
| `!enquete` | Cria uma enquete de sabor de pizza. Democracia em ação. 🗳️ |

> **Atenção:** botões e listas **podem não aparecer em todo aparelho ou tipo de conta** (algumas versões do WhatsApp, contas business, WhatsApp Web...). Isso é uma limitação do **próprio WhatsApp**, não um bug do projeto. Se não renderizar aí, teste em outro celular.

**Controlando quem o bot responde:** por padrão, o bot responde **qualquer pessoa, em qualquer lugar**. Para restringir, abra a aba **Configurações** do painel:

- **Pessoas** — "Todos" ou "Somente autorizados" (lista de números que você adiciona).
- **Grupos** — "Todos os grupos", "Nenhum grupo" ou "Somente grupos autorizados": o painel lista os grupos da conta conectada com nome, e você marca quais o bot pode responder.

As preferências ficam salvas no arquivo `bot-config.json` e valem mesmo depois de reiniciar.

---

## 🧠 Como funciona

O projeto é dividido em arquivos pequenos, cada um com UMA responsabilidade:

| Arquivo        | Responsabilidade |
|----------------|------------------|
| `server.js`    | O servidor web: entrega a página do painel, converte o QR em imagem e conversa com o navegador via Socket.IO. |
| `whatsapp.js`  | A conexão com o WhatsApp: gera o QR, avisa quando conecta/desconecta e repassa cada mensagem recebida. |
| `comandos.js`  | O "cérebro" do bot: decide o que responder para cada comando (`!ping`, `!menu`...). |
| `configuracao.js` | As preferências do bot (quem ele responde), salvas no arquivo `bot-config.json`. |
| `mensagens.js` | Funções prontas de envio: texto, reply, botões, lista, enquete, reação, "digitando...". |
| `public/`      | O painel que você vê no navegador (HTML, CSS e JavaScript do lado do cliente). |

💡 **Quer mudar as respostas do bot?** Tudo em `comandos.js`. Abra, troque os textos, invente comandos novos e salve. Esse arquivo é seu playground.

💡 **Dica para mexer no código:** rode o servidor com `npm run dev` em vez de `npm start`. Nesse modo, toda vez que você salvar um arquivo `.js` do projeto, o servidor **reinicia sozinho** com a mudança aplicada (e a sessão do WhatsApp volta sem pedir QR de novo). Mudou algo só na pasta `public/`? Nem precisa reiniciar — basta atualizar a página no navegador.

---

## 🆘 Deu erro?

Respira. 90% dos problemas estão nesta lista:

**"SyntaxError" estranho logo ao rodar / erro na instalação**
Provavelmente seu Node é antigo. Rode `node --version` — precisa ser **20.9 ou maior**. Atualize em https://nodejs.org e reabra o terminal.

**"EADDRINUSE" ou "porta em uso"**
Outro programa (ou outra cópia deste projeto) já está usando a porta 3333. Feche outros terminais abertos e rode `npm start` de novo — ou troque a porta com `set PORT=3005` antes do `npm start`. Se persistir, reinicie o computador — resolve na força bruta. 😅

**O QR code expirou / não conecta ao escanear**
QR de WhatsApp vence rápido. Pare o servidor (`Ctrl+C` no terminal), rode `npm start` de novo e escaneie o QR **novo** sem demorar.

**Conectava antes e agora só dá erro / fica desconectando**
A sessão salva pode ter travado. Pare o servidor, **apague a pasta `.auth`** dentro do projeto (é onde fica a sessão salva) e rode `npm start` — vai aparecer um QR novo para parear de novo.

**Instalou tudo certo mas nada abre / conexão bloqueada (Windows)**
Antivírus ou o Firewall do Windows podem bloquear o Node. Se aparecer aquela janela do "Firewall do Windows" pedindo permissão, clique em **Permitir acesso**. Alguns antivírus mais bravos precisam que você adicione o Node/pasta do projeto às exceções.

Não achou seu erro aqui? Leia a mensagem de erro com calma — ela quase sempre diz o que aconteceu. E comente no vídeo que a gente se ajuda. 🤝

---

## 📚 Bônus: a documentação do zapo-js dentro da sua IA (MCP)

O projeto já vem com um arquivo `.mcp.json` que conecta a documentação oficial do zapo-js (https://zapo.to) direto no seu assistente de código — a IA passa a **consultar a doc de verdade** em vez de chutar:

- **Claude Code**: abra a pasta do projeto e ele vai perguntar se você aprova o servidor `zapo-docs` do `.mcp.json`. Aprove e pronto. Para deixar disponível em qualquer projeto: `claude mcp add zapo-docs --scope user --transport http https://zapo.to/mcp`
- **Cursor**: adicione no arquivo `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "zapo-docs": { "url": "https://zapo.to/mcp" }
  }
}
```

Depois é só pedir coisas como *"crie um comando !figurinha no comandos.js consultando a doc do zapo"* — a IA busca a página certa da documentação sozinha.

---

## 🏆 Desafio para você

Terminou e quer subir de nível? Tente fazer o painel controlar **DOIS números ao mesmo tempo** (multi-sessão):

- A zapo-js aceita um `sessionId` na criação do cliente — hoje usamos `'default'`. Crie um segundo cliente com um `sessionId` diferente (tipo `'segundo-numero'`) e cada um guarda sua própria sessão.
- Dica: você vai precisar de dois QR codes no painel e de identificar de qual sessão veio cada mensagem.

A documentação da zapo-js está em **https://zapo.to** — ela é sua amiga nessa jornada. Se conseguir, mostra nos comentários! 💪

---

## 📄 Licença

MIT — pode usar, copiar, modificar e compartilhar à vontade, inclusive em projetos comerciais. Só não vale culpar os autores se algo der errado (incluindo banimento de número 😉).
