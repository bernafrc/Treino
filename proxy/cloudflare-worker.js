// Proxy do Plano de Treino — Cloudflare Worker
//
// Guarda a chave da Anthropic como SECRET no painel da Cloudflare (equivalente
// do .env) e repassa as chamadas do app. O navegador nunca vê a chave.
//
// Como publicar (5 min, plano gratuito):
//   1. https://dash.cloudflare.com → Workers & Pages → Create Worker.
//   2. Cole este arquivo inteiro no editor e faça Deploy.
//   3. Na aba Settings → Variables and Secrets do worker:
//        - Adicione um SECRET chamado  ANTHROPIC_API_KEY  com a sua chave sk-ant-…
//        - Adicione uma variável       ALLOWED_ORIGINS    com as origens permitidas,
//          separadas por vírgula. Ex:
//          https://SEUUSUARIO.github.io,http://localhost:8000
//   4. Copie a URL do worker (https://NOME.SEUSUBDOMINIO.workers.dev) e cole no
//      campo "URL do proxy" do app (aba GUIA → MOTOR IA).
//
// ALLOWED_ORIGINS é o que impede outra pessoa de gastar seus créditos se
// descobrir a URL: só páginas servidas das origens listadas passam.

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || 'http://localhost:8000')
      .split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const ok = allowed.includes(origin);

    const cors = {
      'Access-Control-Allow-Origin': ok ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, anthropic-beta',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });
    if (!ok) return new Response('origin not allowed', { status: 403, headers: cors });
    if (!env.ANTHROPIC_API_KEY) return new Response('ANTHROPIC_API_KEY secret not set', { status: 500, headers: cors });

    const upstreamHeaders = {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    const beta = request.headers.get('anthropic-beta');
    if (beta) upstreamHeaders['anthropic-beta'] = beta;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: upstreamHeaders,
      body: request.body,
    });

    // Repassa o corpo (inclusive streaming SSE) e o status, com CORS por cima.
    const h = new Headers(cors);
    h.set('content-type', upstream.headers.get('content-type') || 'application/json');
    return new Response(upstream.body, { status: upstream.status, headers: h });
  },
};
