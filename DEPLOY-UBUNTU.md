# Implantação em Ubuntu — ublochat.com.br

Este guia publica o painel em `https://ublochat.com.br` com Docker e Caddy. O Caddy solicita, instala e renova automaticamente o certificado SSL gratuito do Let's Encrypt. Não é necessário instalar Nginx, Certbot ou Node.js na VPS.

> Atenção: o painel expõe mensagens, QR code e controles da conta conectada. Proteja o acesso à VPS e use um número de WhatsApp de teste: a biblioteca usada pelo projeto não é oficial e automação pode levar ao bloqueio da conta.

## 1. Pré-requisitos

- VPS Ubuntu 22.04 ou 24.04 com acesso `sudo`;
- domínio `ublochat.com.br` administrado por você;
- portas TCP **80** e **443** livres e liberadas também no firewall/provedor;
- um registro DNS tipo **A** de `ublochat.com.br` apontando para o IP público da VPS.

Confirme a propagação antes de continuar:

```bash
dig +short ublochat.com.br
```

O resultado deve ser o IP da VPS. A emissão do SSL só funciona depois disso. Se houver Cloudflare, deixe o registro como **DNS only** até o primeiro certificado ser emitido, ou mantenha as portas 80/443 corretamente acessíveis.

## 2. Instalar Docker

Execute **um comando por vez** no terminal da VPS. O comando `sudo` pode pedir a senha do seu usuário; ao digitá-la nada aparecerá na tela, o que é normal.

```bash
sudo apt update
```

```bash
sudo apt install -y ca-certificates curl git
```

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
```

```bash
sudo sh get-docker.sh
```

```bash
sudo usermod -aG docker $USER
```

### Reconectar à VPS (etapa obrigatória)

Agora rode o comando abaixo. **Ele fechará/desconectará o terminal de propósito**: isso é necessário para que a permissão de usar Docker sem `sudo` passe a valer.

```bash
exit
```

Abra uma nova conexão SSH com a VPS e confira a instalação:

```bash
docker --version
docker compose version
```

## 3. Baixar e publicar o projeto

Escolha uma pasta de aplicações e clone o repositório:

```bash
sudo mkdir -p /opt/ublochat
sudo chown "$USER":"$USER" /opt/ublochat
git clone https://github.com/jenilsonsantos/zapo-panel.git /opt/ublochat
cd /opt/ublochat
docker compose -f docker-compose.production.yml up -d --build
```

Veja o início dos serviços e acompanhe a emissão do certificado:

```bash
docker compose -f docker-compose.production.yml logs -f
```

Quando o Caddy informar que obteve o certificado, abra `https://ublochat.com.br`, escaneie o QR code pelo WhatsApp e faça um teste. A porta 3333 não é publicada na internet; apenas o Caddy a acessa na rede interna do Docker.

## 4. Firewall

Se usar UFW, permita somente SSH, HTTP e HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Libere as mesmas portas no painel da sua VPS (firewall/security group), se ele existir.

## Atualizações

Na pasta `/opt/ublochat`:

```bash
git pull --ff-only
docker compose -f docker-compose.production.yml up -d --build
```

Os dados persistentes ficam no volume Docker `zapo-data`, portanto atualização e recriação do contêiner não exigem novo QR code. Não rode `docker compose down -v`, pois essa opção apaga também a sessão do WhatsApp e o histórico.

## Backup e restauração

Faça backup antes de atualizações importantes. O arquivo abaixo guarda as configurações, histórico, mídias e sessão autenticada — trate-o como segredo:

```bash
cd /opt/ublochat
DATA_VOLUME=$(docker volume ls --format '{{.Name}}' | grep '_zapo-data$' | head -n1)
docker run --rm -v "$DATA_VOLUME":/source -v "$PWD":/backup alpine \
  tar czf /backup/zapo-data-$(date +%F).tar.gz -C /source .
```

O comando localiza automaticamente o volume de dados. Para restaurar, pare os serviços, extraia o backup no volume e suba novamente:

```bash
docker compose -f docker-compose.production.yml down
DATA_VOLUME=$(docker volume ls --format '{{.Name}}' | grep '_zapo-data$' | head -n1)
docker run --rm -v "$DATA_VOLUME":/target -v "$PWD":/backup alpine \
  sh -c 'rm -rf /target/* /target/.[!.]* /target/..?*; tar xzf /backup/zapo-data-AAAA-MM-DD.tar.gz -C /target'
docker compose -f docker-compose.production.yml up -d
```

Substitua a data pelo arquivo de backup desejado. Não compartilhe esse `.tar.gz`.

## SSL automático: verificação e problemas comuns

O Caddy renova certificados automaticamente e mantém seus dados no volume `caddy-data`. Para ver logs:

```bash
docker logs zapo-caddy --tail 100
```

Se o SSL não for emitido, verifique nesta ordem: DNS aponta para a VPS, portas 80/443 estão liberadas no UFW e no provedor, e nenhum Nginx/Apache ocupa essas portas (`sudo ss -ltnp | grep -E ':80|:443'`). Depois reinicie: `docker compose -f docker-compose.production.yml restart caddy`.

## Dados e banco de dados suportado

Na configuração atual, o projeto usa **SQLite**, por meio de `better-sqlite3` e `@zapo-js/store-sqlite`. A sessão do WhatsApp é gravada em `state.sqlite`; configurações, histórico e contadores usam arquivos JSON. Não há integração configurada com MySQL, PostgreSQL, MongoDB ou Redis. Para uma única instância na VPS, SQLite é apropriado e evita administrar outro serviço de banco.

O painel não deve ser executado em múltiplas réplicas compartilhando o mesmo SQLite. Caso seja necessário alta disponibilidade ou múltiplas instâncias, será preciso adaptar a camada de persistência antes do deploy.
