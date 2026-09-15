/**
 * Resumo legível de um User-Agent para o log de acessos.
 *
 * Não é detecção precisa de navegador — é o suficiente para o dono do clube
 * olhar a linha e entender "entrou pelo celular" ou "entrou pelo Chrome no
 * Windows". A ordem dos testes importa: quase todo UA diz "Mozilla", o do
 * Edge e do Opera dizem "Chrome", e o do Chrome diz "Safari".
 */
export function parseUserAgent(ua) {
  const s = ua || '';
  let browser = 'Outro';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';

  let os = 'Outro';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/Android/.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';

  const device = /Mobi|Android|iPhone|iPad/.test(s) ? 'mobile' : 'desktop';
  return { browser, os, device };
}

/** "Chrome · Windows"; vazio quando não há UA (evento gravado pelo banco). */
export function formatUserAgent(ua) {
  if (!ua) return '';
  const { browser, os } = parseUserAgent(ua);
  if (browser === 'Outro' && os === 'Outro') return ua.slice(0, 40);
  return `${browser} · ${os}`;
}
