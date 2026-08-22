// Proxy da API Anthropic como Cloudflare Pages Function.
// Publicado junto com o site (mesma origem), rota: POST /api/messages
//
// A chave fica como SECRET no projeto Pages (Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY = sk-ant-…   (tipo Secret, ambiente Production)
// Depois de criar o secret, refaça o deploy (Deployments → ⋯ → Retry deployment)
// para ele valer. O app detecta esta rota sozinho — nada a configurar nele.

export async function onRequest(context) {
  const req = context.request;

  // O app chama na mesma origem; navegador nenhum manda preflight aqui.
  // GET serve de sonda para o app detectar que o proxy existe (responde 405).
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // Bloqueia outros sites tentando usar o endpoint via navegador.
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin) {
    return new Response('origin not allowed', { status: 403 });
  }

  if (!context.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY não configurada no projeto Pages (Settings → Variables and Secrets, tipo Secret) — crie e refaça o deploy.' } }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }

  const headers = {
    'content-type': 'application/json',
    'x-api-key': context.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  const beta = req.headers.get('anthropic-beta');
  if (beta) headers['anthropic-beta'] = beta;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: req.body,
  });

  // Repassa corpo (inclusive streaming SSE) e status.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  });
}
