#!/usr/bin/env bash
set -euo pipefail

# Instalação inicial. Execute dentro da pasta clonada do projeto.
# Exemplo: bash scripts/install-production.sh ublochat.com.br admin@ublochat.com.br

DOMAIN="${1:-ublochat.com.br}"
ADMIN_EMAIL="${2:-admin@${DOMAIN}}"
ENV_FILE=".env"

if [[ ! "$DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
  echo "Domínio inválido: $DOMAIN" >&2
  exit 1
fi

if [[ ! "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "E-mail do administrador inválido: $ADMIN_EMAIL" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  echo "O arquivo .env já existe. A instalação não será sobrescrita para preservar suas credenciais." >&2
  exit 1
fi

for command in openssl docker; do
  command -v "$command" >/dev/null || { echo "Comando obrigatório ausente: $command" >&2; exit 1; }
done

generate_secret() { openssl rand -hex 32; }
MYSQL_PASSWORD="$(generate_secret)"
MYSQL_ROOT_PASSWORD="$(generate_secret)"
ADMIN_PASSWORD="$(generate_secret)"

umask 077
cat > "$ENV_FILE" <<EOF
DOMAIN=$DOMAIN
MYSQL_DATABASE=zapo
MYSQL_USER=zapo_app
MYSQL_PASSWORD=$MYSQL_PASSWORD
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
NODE_ENV=production
EOF
chmod 600 "$ENV_FILE"

echo "Iniciando os serviços. Na primeira vez a imagem pode levar alguns minutos para ser compilada..."
docker compose -f docker-compose.production.yml up -d --build

cat <<EOF

=================================================================
 INSTALAÇÃO CONCLUÍDA — GUARDE ESTAS CREDENCIAIS AGORA
=================================================================
 Painel:              https://$DOMAIN/login
 Administração:       https://$DOMAIN/admin
 E-mail administrador: $ADMIN_EMAIL
 Senha administrador:  $ADMIN_PASSWORD

 Usuário MySQL:        zapo_app
 Senha MySQL:          $MYSQL_PASSWORD
 Senha root MySQL:     $MYSQL_ROOT_PASSWORD

 Estas credenciais também estão em .env (permissão 600).
 Elas não são enviadas ao Git. Não compartilhe esta tela nem o .env.
=================================================================
EOF
