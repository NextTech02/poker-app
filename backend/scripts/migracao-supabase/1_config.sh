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
# Segredos a API não devolve, mas EXIGE para aceitar o resto: a senha do SMTP
# próprio e o secret do captcha. Vêm do variaveis.env (SMTP_PASS,
# HCAPTCHA_SECRET); sem eles, esses campos ficam de fora e o script avisa o que
# fazer à mão no painel do projeto novo.
source "$(dirname "${BASH_SOURCE[0]}")/comum.sh"
exigir SUPABASE_ACCESS_TOKEN OLD_REF

API=https://api.supabase.com/v1/projects
auth_header=(-H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN")

# Chama a Management API e devolve a resposta. Em erro, mostra o código E a
# resposta — é ela que diz qual campo foi recusado — e para o script.
#   api METODO CAMINHO [args do curl...]
api() {
  local metodo=$1 caminho=$2 corpo codigo
  shift 2
  corpo=$(mktemp)
  codigo=$(curl -sS -o "$corpo" -w '%{http_code}' -X "$metodo" "${auth_header[@]}" \
             -H "Content-Type: application/json" "$@" "$API/$caminho") || { rm -f "$corpo"; exit 1; }
  if [ "${codigo:0:1}" != 2 ]; then
    echo "ERRO $codigo em $metodo $caminho:" >&2
    cat "$corpo" >&2
    echo >&2
    # A API também responde 401 a campo recusado (ex.: SMTP sem senha), então
    # a dica do token só sai quando a resposta fala do token.
    if [ "$codigo" = 401 ] && grep -qiE 'jwt|token|unauthorized' "$corpo"; then
      echo "401 = token recusado. Confira SUPABASE_ACCESS_TOKEN no variaveis.env (começa com sbp_;" >&2
      echo "gere outro em supabase.com/dashboard/account/tokens)." >&2
    fi
    rm -f "$corpo"
    exit 1
  fi
  cat "$corpo"
  rm -f "$corpo"
}

exportar() {
  mkdir -p config-antigo
  for parte in config/auth postgrest config/storage; do
    arquivo="config-antigo/$(echo "$parte" | tr / _).json"
    # Grava num .tmp e só troca se veio um JSON de verdade: um erro no meio
    # não deixa arquivo vazio para o `aplicar` mandar ao projeto novo.
    api GET "$OLD_REF/$parte" > "$arquivo.tmp"
    jq -e 'type == "object" and length > 0' "$arquivo.tmp" > /dev/null
    mv "$arquivo.tmp" "$arquivo"
    echo "salvo: $arquivo"
  done
  echo
  echo "Hook de login no antigo:"
  jq '{hook_custom_access_token_enabled, hook_custom_access_token_uri}' config-antigo/config_auth.json
}

aplicar() {
  exigir NEW_REF
  for f in config_auth postgrest config_storage; do
    jq -e 'type == "object" and length > 0' "config-antigo/$f.json" > /dev/null 2>&1 \
      || { echo "config-antigo/$f.json falta ou está vazio. Rode antes: bash 1_config.sh exportar" >&2; exit 1; }
  done

  # Auth: só o que o antigo tem DIFERENTE do novo. Mandar a configuração inteira
  # esbarra em campo que o plano não deixa nem mexer (no ensaio: 402 para os
  # hooks de verificação de senha/MFA, desligados no antigo). Filtros, em ordem:
  #  1. nulos/vazios e QUALQUER segredo (a API pode devolvê-lo mascarado, e
  #     reenviar a máscara sobrescreveria o valor de verdade). `^smtp_pass$` e
  #     não `pass`: este pegaria password_min_length, password_required_characters
  #     e password_hibp_enabled — a política de senha;
  #  2. hooks desligados no antigo;
  #  3. os dois segredos exigidos: com SMTP próprio, a API recusa smtp_* e
  #     rate_limit_email_sent sem smtp_pass ("Custom SMTP required ... Missing
  #     SMTP_PASS", visto no ensaio); o captcha ligado precisa do secret;
  #  4. o que já está igual no novo — e assim rodar de novo não reenvia nada.
  api GET "$NEW_REF/config/auth" > config-antigo/auth_novo_antes.json
  jq --slurpfile novo config-antigo/auth_novo_antes.json \
     --arg smtp_pass "${SMTP_PASS:-}" --arg captcha "${HCAPTCHA_SECRET:-}" '
      with_entries(select(.value != null and .value != "")
        | select(.key | test("secret|^smtp_pass$|auth_token|api_key|access_key") | not))
      | [to_entries[] | select((.key | test("^hook_.+_enabled$")) and .value == true)
         | .key | rtrimstr("_enabled")] as $ligados
      | with_entries(select((.key | startswith("hook_") | not)
          or (.key as $k | any($ligados[]; . as $h | $k | startswith($h + "_")))))
      | if (.smtp_host // "") == "" then .
        elif $smtp_pass != "" then . + {smtp_pass: $smtp_pass}
        else with_entries(select(.key | test("^smtp_|^rate_limit_email_sent$") | not))
        end
      | if .security_captcha_enabled != true then .
        elif $captcha != "" then . + {security_captcha_secret: $captcha}
        else del(.security_captcha_enabled)
        end
      | with_entries(select(.value != $novo[0][.key]))' \
     config-antigo/config_auth.json > config-antigo/auth_para_o_novo.json
  # Só os NOMES dos campos (os valores podem ter segredo).
  echo "Auth — campos que vão para o novo: $(jq -r 'keys | join(", ")' config-antigo/auth_para_o_novo.json)"
  if jq -e 'length > 0' config-antigo/auth_para_o_novo.json > /dev/null; then
    # Se a API recusar um campo, `api` mostra a resposta, que diz QUAL.
    api PATCH "$NEW_REF/config/auth" --data @config-antigo/auth_para_o_novo.json > /dev/null
    echo "Auth aplicado."
  else
    echo "Auth do novo já igual ao do antigo."
  fi

  # API (PostgREST): o max_rows=1000 que o backend assume (paginacao.py).
  jq '{max_rows, db_schema, db_extra_search_path}' config-antigo/postgrest.json \
    | api PATCH "$NEW_REF/postgrest" --data @- > /dev/null
  echo "API aplicada."

  jq '{fileSizeLimit}' config-antigo/config_storage.json \
    | api PATCH "$NEW_REF/config/storage" --data @- > /dev/null
  echo "Storage aplicado."

  echo
  echo "Conferindo no NOVO:"
  api GET "$NEW_REF/config/auth" \
    | jq '{hook_custom_access_token_enabled, hook_custom_access_token_uri, mfa_totp_enroll_enabled,
           site_url, smtp_host, security_captcha_enabled}'

  pendencias=()
  if jq -e '(.smtp_host // "") != ""' config-antigo/config_auth.json > /dev/null && [ -z "${SMTP_PASS:-}" ]; then
    pendencias+=("Authentication > Emails > SMTP Settings: o SMTP próprio NÃO foi copiado (falta SMTP_PASS no variaveis.env). Sem ele, os e-mails do Auth (convites) saem pelo SMTP padrão do Supabase, que é limitado.")
  fi
  if jq -e '.security_captcha_enabled == true' config-antigo/config_auth.json > /dev/null && [ -z "${HCAPTCHA_SECRET:-}" ]; then
    pendencias+=("Authentication > Attack Protection: captcha DESLIGADO no novo (falta HCAPTCHA_SECRET no variaveis.env).")
  fi
  echo
  if [ ${#pendencias[@]} -gt 0 ]; then
    echo "PENDENTE no painel do NOVO:"
    printf '  - %s\n' "${pendencias[@]}"
  else
    echo "Nada pendente: SMTP e captcha (se o antigo usa) foram copiados com os segredos do variaveis.env."
  fi
}

case "${1:-}" in
  exportar) exportar ;;
  aplicar) aplicar ;;
  *) echo "uso: bash 1_config.sh exportar|aplicar" >&2; exit 1 ;;
esac
