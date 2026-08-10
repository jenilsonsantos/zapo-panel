# Instalação SaaS com MySQL — Ubuntu e ublochat.com.br

Esta instalação sobe quatro serviços: o painel, **MySQL 8.4**, Caddy (HTTPS/SSL automático) e o volume persistente de dados. O MySQL não é exposto à internet.

## Antes de começar

1. O DNS A de `ublochat.com.br` deve apontar para o IP público da VPS.
2. Libere TCP 80 e 443 no firewall da VPS e no provedor.
3. Entre novamente na VPS após instalar Docker, para a permissão do grupo Docker ser aplicada.

## Instalar Docker

Execute cada comando separadamente:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
exit
```

O `exit` desconecta de propósito. Entre novamente por SSH e valide com `docker --version`.

## Publicar o sistema

```bash
sudo mkdir -p /opt/ublochat
sudo chown "$USER":"$USER" /opt/ublochat
git clone https://github.com/jenilsonsantos/zapo-panel.git /opt/ublochat
cd /opt/ublochat
cp .env.example .env
```

Gere três senhas diferentes e fortes; copie cada resultado para o campo correspondente no `.env`:

```bash
openssl rand -base64 36
```

Edite o arquivo com `nano .env`:

```ini
MYSQL_DATABASE=zapo
MYSQL_USER=zapo_app
MYSQL_PASSWORD=COLE_A_PRIMEIRA_SENHA
MYSQL_ROOT_PASSWORD=COLE_A_SEGUNDA_SENHA
ADMIN_EMAIL=admin@ublochat.com.br
ADMIN_PASSWORD=COLE_A_TERCEIRA_SENHA_COM_14_OU_MAIS_CARACTERES
NODE_ENV=production
```

Salve no Nano com `Ctrl+O`, `Enter` e saia com `Ctrl+X`. Nunca envie esse arquivo para GitHub, WhatsApp ou e-mail.

Suba os serviços:

```bash
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml logs -f
```

Espere a mensagem de certificado obtido pelo Caddy e abra `https://ublochat.com.br`. Entre usando `ADMIN_EMAIL` e `ADMIN_PASSWORD`. O banco cria automaticamente as tabelas e o administrador no primeiro início.

## Painel administrativo

O superadministrador acessa `https://ublochat.com.br/admin`. Ali é possível criar cada empresa (tenant), seu primeiro administrador e suspender/reativar a empresa. Senhas são salvas com hash bcrypt; não são armazenadas em texto.

## Proteções incluídas

- MySQL somente na rede interna do Docker, sem porta pública;
- TLS com emissão e renovação automática pelo Caddy;
- cookies `HttpOnly`, `SameSite` e `Secure` em produção;
- limite de tentativas de login;
- cabeçalhos de segurança e bloqueio de acesso aos endpoints sem login;
- papéis `super_admin`, `tenant_admin` e `agent` e vínculo usuário–empresa;
- sessão expirada após sete dias e revogável pelo logout.

## Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

## Backup

Faça backup dos volumes antes de atualizações importantes. O banco contém usuários, empresas e sessões; o volume de dados contém estado do WhatsApp e mídias.

```bash
cd /opt/ublochat
docker compose -f docker-compose.production.yml exec -T mysql sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' > mysql-$(date +%F).sql
DATA_VOLUME=$(docker volume ls --format '{{.Name}}' | grep '_zapo-data$' | head -n1)
docker run --rm -v "$DATA_VOLUME":/source -v "$PWD":/backup alpine tar czf /backup/zapo-data-$(date +%F).tar.gz -C /source .
```

## Atualizar

```bash
cd /opt/ublochat
git pull --ff-only
docker compose -f docker-compose.production.yml up -d --build
```

Não use `docker compose down -v` em produção: isso remove volumes, incluindo banco e sessões.

## Limite atual da integração WhatsApp

O banco, login e gestão de empresas já são multi-tenant. A camada WhatsApp original, porém, ainda opera uma única conexão em memória. Antes de liberar o painel operacional a administradores de empresas, é necessário concluir o gerenciador de conexões por tenant: uma instância/sessão isolada, dados e mídia no diretório do respectivo tenant, e eventos Socket.IO emitidos apenas para sua sala. Não compartilhe o painel WhatsApp atual entre tenants enquanto essa etapa não estiver concluída.
