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
    if (url.pathname === '/api/sync') return handleSync(request, env);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
};

// ---- Sincronização: histórico único e permanente ----
// Os dados moram num Durable Object (SQLite) — instância única "main".
// Autenticação: secret SYNC_TOKEN no worker; o app manda o mesmo valor no
// header x-sync-token. Sem o código, ninguém lê nem escreve.
async function handleSync(request, env) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return new Response('origin not allowed', { status: 403 });
  }

  if (!env.SYNC_TOKEN) {
    return jsonResp({ error: { message: 'SYNC_TOKEN não configurado: painel do worker → Settings → Variables and Secrets → Add Secret SYNC_TOKEN.' } }, 500);
  }
  if ((request.headers.get('x-sync-token') || '') !== env.SYNC_TOKEN) {
    return new Response('unauthorized', { status: 401 });
  }

  const id = env.STORE.idFromName('main');
  return env.STORE.get(id).fetch(request);
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

// Regras de merge (a fonte da verdade é a união):
// - treinos e medidas: união por id — um aparelho atrasado nunca apaga nada;
// - deleções: lápides (tombstones) por id, pra apagado não ressuscitar;
// - plano e análise: timestamp mais novo vence (planStamp / generatedAt).
export class TreinoStore {
  constructor(state) { this.storage = state.storage; }

  async fetch(request) {
    let body;
    try { body = await request.json(); } catch (e) { return jsonResp({ error: { message: 'json inválido' } }, 400); }
    body = body || {};
    const st = this.storage;

    // 1. lápides novas: registra e apaga o item correspondente
    const tombMap = await st.list({ prefix: 't:' });
    const incomingTombs = body.tomb || {};
    for (const id in incomingTombs) {
      if (typeof id !== 'string' || id.length > 80) continue;
      if (!tombMap.has('t:' + id)) await st.put('t:' + id, String(incomingTombs[id]).slice(0, 40));
      tombMap.set('t:' + id, true);
      await st.delete('h:' + id);
      await st.delete('b:' + id);
    }

    // 2. união por id (só adiciona o que o servidor não tem e não foi apagado)
    const addAll = async (items, prefix, idOk) => {
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it.id !== 'string' || !idOk(it)) continue;
        if (tombMap.has('t:' + it.id)) continue;
        if ((await st.get(prefix + it.id)) === undefined) await st.put(prefix + it.id, it);
      }
    };
    await addAll(body.history, 'h:', (s) => Array.isArray(s.exercises) && s.completedAt);
    await addAll(body.bodyweight, 'b:', (b) => typeof b.weight === 'number' && b.date);

    // 3. plano: stamp mais novo vence (plan null = plano original restaurado)
    const storedStamp = (await st.get('planStamp')) || '';
    const inStamp = String(body.planStamp || '');
    if (inStamp && inStamp > storedStamp) {
      await st.put('planStamp', inStamp);
      if (body.plan) await st.put('plan', { plan: body.plan, meta: body.planMeta || null });
      else await st.delete('plan');
    }

    // 4. análise: generatedAt mais novo vence
    const storedAn = await st.get('analysis');
    if (body.analysis && body.analysis.generatedAt
      && (!storedAn || String(body.analysis.generatedAt) > String(storedAn.generatedAt || ''))) {
      await st.put('analysis', body.analysis);
    }

    // 5. devolve o estado consolidado
    const hist = [...(await st.list({ prefix: 'h:' })).values()]
      .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
    const bw = [...(await st.list({ prefix: 'b:' })).values()]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const planRec = await st.get('plan');
    return jsonResp({
      history: hist,
      bodyweight: bw,
      planStamp: (await st.get('planStamp')) || '',
      plan: planRec ? planRec.plan : null,
      planMeta: planRec ? planRec.meta : null,
      analysis: (await st.get('analysis')) || null,
    });
  }
}

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
