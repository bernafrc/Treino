// Worker do site (Cloudflare, fluxo Workers + assets).
// Os arquivos do app são servidos como assets estáticos automaticamente;
// este script só atende o que NÃO é arquivo — na prática, a rota do proxy:
//
//   POST /api/messages  →  repassa para a API da Anthropic com a chave
//                          guardada como SECRET do worker.
//
// A chave: painel do worker → Settings → Variables and Secrets →
//   Add → tipo Secret → nome ANTHROPIC_API_KEY → valor sk-ant-…
// O app detecta a rota sozinho (GET /api/messages responde 405).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/messages') return proxyAnthropic(request, env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
};

async function proxyAnthropic(request, env) {
  // GET serve de sonda para o app detectar que o proxy existe.
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // Mesma origem: bloqueia outros sites tentando usar o endpoint via navegador.
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return new Response('origin not allowed', { status: 403 });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY não configurada: painel do worker → Settings → Variables and Secrets → Add Secret.' } }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }

  const headers = {
    'content-type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  const beta = request.headers.get('anthropic-beta');
  if (beta) headers['anthropic-beta'] = beta;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: request.body,
  });

  // Repassa corpo (inclusive streaming SSE) e status.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  });
}
