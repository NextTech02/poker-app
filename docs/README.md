# Documentação

Como o sistema funciona e por que foi feito assim. Para instalar, rodar e fazer
deploy, veja o [README da raiz](../README.md); para a orientação de quem
desenvolve com o Claude Code, o [CLAUDE.md](../CLAUDE.md).

## O que vale hoje

| Documento | Assunto |
|---|---|
| [STAGE_ENCAPSULATION.md](STAGE_ENCAPSULATION.md) | Etapas: o cabeçalho `X-Stage-ID` recorta todas as operações pela etapa selecionada |
| [IMPLEMENTACAO_CAIXA_SANGRIA.md](IMPLEMENTACAO_CAIXA_SANGRIA.md) | Caixa da etapa, caixa geral, sangria e rake |
| [INTERVAL_FEATURE_GUIDE.md](INTERVAL_FEATURE_GUIDE.md) | Intervalos (breaks) na estrutura de blinds |
| [BROADCAST_SETUP_INSTRUCTIONS.md](BROADCAST_SETUP_INSTRUCTIONS.md) | Telão público: como configurar |
| [BROADCAST_TV_LAYOUT_2026-10.md](BROADCAST_TV_LAYOUT_2026-10.md) | Telão: layout de palco 1920x1080 e biblioteca de fundos (out/2026) |
| [BLINDS_NIVEL_ATUAL_E_REORDENACAO_2026-10.md](BLINDS_NIVEL_ATUAL_E_REORDENACAO_2026-10.md) | Blinds: nível atual sinalizado e reordenar arrastando (out/2026) |
| [RELOGIO_DE_MESA_2026-11.md](RELOGIO_DE_MESA_2026-11.md) | Relógio de ação no tablet do dealer e time bank por jogador |
| [PAINEL_DE_MESAS_2026-11.md](PAINEL_DE_MESAS_2026-11.md) | Todas as mesas desenhadas para o floor e o diretor |
| [MIGRACAO_SUPABASE_SAO_PAULO.md](MIGRACAO_SUPABASE_SAO_PAULO.md) | Migração do banco de Oregon para São Paulo: roteiro, ensaio e virada (nov/2026) |

Outros documentos ficam junto do que descrevem:
[landing/README.md](../landing/README.md) (landing page) e os READMEs de
`db/tests/` (testes de gatilhos do banco).

## Histórico

[`historico/`](historico/) guarda o que retrata o sistema **como ele era** quando
foi escrito. Serve para entender decisões antigas; antes de confiar em algum
detalhe, confira no código.

- **Instalação e deploy das versões 1 e 2**, substituídos pelo README da raiz:
  `QUICKSTART`, `COMPLETE_SETUP_GUIDE`, `SETUP_CHECKLIST`, `TROUBLESHOOTING`,
  `PRODUCTION_DEPLOYMENT`, `MIGRATION_GUIDE_V2`.
- **Relatórios de implementação**: `BACKEND_ENRICHED_TIMER`,
  `FRONTEND_ENRICHED_TIMER`, `TEST_REPORT`, `PLAYER_REGISTRATION_GUIDE`,
  `SISTEMA_ALOCACAO_README`, `CORRECAO_CAIXA_GERAL`.
- **Análises, planos e PRDs**: `FRONTEND_ANALYSIS_SUMMARY`,
  `FRONTEND_EXPLORATION_REPORT`, `FRONTEND_QUICK_REFERENCE`, `EMOJI_INVENTORY`,
  `PLAN` (dias classificatórios), `PRD_DOGFOOD_FIXES`, `PRD_CORRECOES_V2`.
- **`email-templates/`**: modelos de e-mail do Supabase Auth, sem uso desde
  set/2026 — os e-mails saem do backend, pelo Resend
  (`backend/app/services/email_service.py`).
