/**
 * O idioma declarado no HTML precisa acompanhar o idioma da interface.
 *
 * O defeito que estes testes travam foi relatado por um cliente colombiano: o
 * intervalo do torneio aparecia como "allanamiento" (arrombamento). A tradução
 * errada nao era nossa — era o Chrome traduzindo a pagina POR CIMA, porque o
 * `index.html` dizia `lang="pt-BR"` para sempre e a interface estava em
 * espanhol. Declarando o idioma certo, o navegador para de intervir.
 */
import i18n from './i18n';

describe('idioma declarado no documento', () => {
  // Sentinela: sem ela, o jsdom pode ja estar no idioma que o teste espera e a
  // asserção passaria mesmo com a sincronizacao desligada — foi o que aconteceu
  // na primeira versao destes testes.
  const SENTINELA = 'zz-ZZ';

  beforeEach(() => {
    document.documentElement.lang = SENTINELA;
  });

  afterEach(async () => {
    await i18n.changeLanguage('pt-BR');
  });

  test('o HTML declara o idioma que a interface esta usando', async () => {
    await i18n.changeLanguage(i18n.language);
    expect(document.documentElement.lang).toBe(i18n.language);
    expect(document.documentElement.lang).not.toBe(SENTINELA);
  });

  test('trocar para espanhol muda o lang do documento', async () => {
    await i18n.changeLanguage('es-ES');
    expect(document.documentElement.lang).toBe('es-ES');
  });

  test('trocar para ingles muda o lang do documento', async () => {
    await i18n.changeLanguage('en-US');
    expect(document.documentElement.lang).toBe('en-US');
  });

  test('voltar para portugues tambem atualiza', async () => {
    await i18n.changeLanguage('es-ES');
    await i18n.changeLanguage('pt-BR');
    expect(document.documentElement.lang).toBe('pt-BR');
  });
});
