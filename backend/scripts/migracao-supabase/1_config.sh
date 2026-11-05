#!/usr/bin/env bash
# Configurações que NÃO estão no banco: Auth (hook de login, MFA, URLs, limites,
# captcha), API (max_rows) e Storage. Pela Management API do Supabase.
#
#   bash 1_config.sh exportar   # salva as do antigo em config-antigo/ (só lê)
#   bash 1_config.sh aplicar    # aplica no NOVO o que foi exportado
#
# Rode `aplicar` DEPOIS do restore do banco (3_restaurar.sh): a configuração
# liga o hook `custom_access_token_hook`, e com o hook ligado e a função ainda
# inexistente ninguém consegue entrar.
#
# Segredos a API não devolve (secret do hCaptcha, senha de SMTP): o script
# avisa, e eles são preenchidos à mão no painel do projeto novo.
source "$(dirname "${BASH_SOURCE[0]}")/comum.sh"
exigir SUPABASE_ACCESS_TOKEN OLD_REF

API=https://api.supabase.com/v1/projects
auth_header=(-H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN")

exportar() {
  mkdir -p config-antigo
  for parte in config/auth postgrest config/storage; do
    arquivo="config-antigo/$(echo "$parte" | tr / _).json"
    curl -fsS "${auth_header[@]}" "$API/$OLD_REF/$parte" > "$arquivo"
    echo "salvo: $arquivo"
  done
  echo
  echo "Hook de login no antigo:"
  jq '{hook_custom_access_token_enabled, hook_custom_access_token_uri}' config-antigo/config_auth.json
}

aplicar() {
  exigir NEW_REF
  [ -d config-antigo ] || { echo "Rode antes: bash 1_config.sh exportar" >&2; exit 1; }

  # Auth: tudo o que veio, menos nulos e QUALQUER segredo (a API pode devolvê-lo
  # mascarado, e reenviar a máscara sobrescreveria o valor de verdade).
  jq 'with_entries(select(.value != null)
        | select(.key | test("secret|pass|auth_token|api_key") | not))' \
     config-antigo/config_auth.json > config-antigo/auth_para_o_novo.json
  # --fail-with-body: se a API recusar um campo, a resposta diz QUAL.
  curl -sS --fail-with-body -X PATCH "${auth_header[@]}" -H "Content-Type: application/json" \
       --data @config-antigo/auth_para_o_novo.json "$API/$NEW_REF/config/auth" > /dev/null
  echo "Auth aplicado."

  # API (PostgREST): o max_rows=1000 que o backend assume (paginacao.py).
  jq '{max_rows, db_schema, db_extra_search_path}' config-antigo/postgrest.json \
    | curl -sS --fail-with-body -X PATCH "${auth_header[@]}" -H "Content-Type: application/json" \
           --data @- "$API/$NEW_REF/postgrest" > /dev/null
  echo "API aplicada."

  jq '{fileSizeLimit}' config-antigo/config_storage.json \
    | curl -sS --fail-with-body -X PATCH "${auth_header[@]}" -H "Content-Type: application/json" \
           --data @- "$API/$NEW_REF/config/storage" > /dev/null
  echo "Storage aplicado."

  echo
  echo "Conferindo o hook de login no NOVO:"
  curl -fsS "${auth_header[@]}" "$API/$NEW_REF/config/auth" \
    | jq '{hook_custom_access_token_enabled, hook_custom_access_token_uri, mfa_totp_enroll_enabled, site_url}'
  echo
  echo "À MÃO no painel do NOVO (a API não devolve segredos):"
  echo "  - Authentication > Attack Protection: secret do hCaptcha (o mesmo HCAPTCHA_SECRET da VPS)"
  if jq -e '.smtp_host // empty' config-antigo/config_auth.json > /dev/null; then
    echo "  - Authentication > SMTP: senha do SMTP próprio"
  fi
}

case "${1:-}" in
  exportar) exportar ;;
  aplicar) aplicar ;;
  *) echo "uso: bash 1_config.sh exportar|aplicar" >&2; exit 1 ;;
esac
