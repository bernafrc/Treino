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
    if (url.pathname.startsWith('/api/fitbit/')) return handleFitbitRoute(request, env, url);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
};

// ---- Fitbit: OAuth + ponte de dados ----
// Tokens do Fitbit ficam no Durable Object (servidor), nunca no aparelho.
// Secrets necessários no worker: FITBIT_CLIENT_ID e FITBIT_CLIENT_SECRET
// (cadastro do app pessoal em dev.fitbit.com; redirect = /api/fitbit/callback).
async function handleFitbitRoute(request, env, url) {
  const path = url.pathname;

  // callback é navegação do browser vindo do fitbit.com (GET, sem headers custom)
  if (path === '/api/fitbit/callback') return fitbitCallback(request, env, url);

  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response('origin not allowed', { status: 403 });
  if (!env.SYNC_TOKEN || (request.headers.get('x-sync-token') || '') !== env.SYNC_TOKEN) {
    return new Response('unauthorized', { status: 401 });
  }

  if (path === '/api/fitbit/authurl') {
    if (!env.FITBIT_CLIENT_ID || !env.FITBIT_CLIENT_SECRET) {
      return jsonResp({ error: { message: 'Configure os secrets FITBIT_CLIENT_ID e FITBIT_CLIENT_SECRET no worker (cadastro em dev.fitbit.com).' } }, 500);
    }
    const state = crypto.randomUUID();
    const redirect = url.origin + '/api/fitbit/callback';
    const auth = 'https://www.fitbit.com/oauth2/authorize?response_type=code'
      + '&client_id=' + encodeURIComponent(env.FITBIT_CLIENT_ID)
      + '&redirect_uri=' + encodeURIComponent(redirect)
      + '&scope=' + encodeURIComponent('weight activity')
      + '&state=' + state;
    return new Response(JSON.stringify({ url: auth }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // cookie de state: só quem passou pelo authurl (com o código de sync) valida o callback
        'set-cookie': 'fb_state=' + state + '; Max-Age=600; Path=/api/fitbit; HttpOnly; Secure; SameSite=Lax',
      },
    });
  }

  // demais rotas (status/weight/activity/unlink) vivem no Durable Object
  const id = env.STORE.idFromName('main');
  return env.STORE.get(id).fetch(request);
}

async function fitbitCallback(request, env, url) {
  const back = (flag) => new Response(null, {
    status: 302,
    headers: {
      location: url.origin + '/#fitbit=' + flag,
      'set-cookie': 'fb_state=; Max-Age=0; Path=/api/fitbit; HttpOnly; Secure; SameSite=Lax',
    },
  });
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const m = (request.headers.get('Cookie') || '').match(/fb_state=([^;]+)/);
  if (!code || !state || !m || m[1] !== state) return back('err');
  if (!env.FITBIT_CLIENT_ID || !env.FITBIT_CLIENT_SECRET) return back('err');

  const basic = btoa(env.FITBIT_CLIENT_ID + ':' + env.FITBIT_CLIENT_SECRET);
  const resp = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST',
    headers: { authorization: 'Basic ' + basic, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code&code=' + encodeURIComponent(code)
      + '&redirect_uri=' + encodeURIComponent(url.origin + '/api/fitbit/callback'),
  });
  if (!resp.ok) return back('err');
  const j = await resp.json();
  const tok = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in || 28800) * 1000,
    user_id: j.user_id || null,
    linked_at: new Date().toISOString(),
  };
  const id = env.STORE.idFromName('main');
  await env.STORE.get(id).fetch(new Request(url.origin + '/api/fitbit/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tok),
  }));
  return back('ok');
}

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
  constructor(state, env) { this.storage = state.storage; this.env = env || {}; }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/fitbit/')) return this.fitbit(request, path);
    return this.handleSync(request);
  }

  // ---- Fitbit (tokens e chamadas ficam todos no servidor) ----
  async fitbit(request, path) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const st = this.storage;

    if (path === '/api/fitbit/save') { await st.put('fitbit', body); return jsonResp({ ok: true }); }
    if (path === '/api/fitbit/unlink') { await st.delete('fitbit'); return jsonResp({ ok: true }); }
    if (path === '/api/fitbit/status') {
      const t = await st.get('fitbit');
      return jsonResp({ linked: !!t, since: t ? t.linked_at : null });
    }

    const at = await this.fbAccessToken();
    if (!at) return jsonResp({ error: { message: 'Fitbit não conectado (ou a autorização expirou). Use CONECTAR FITBIT de novo.' } }, 409);
    const h = { authorization: 'Bearer ' + at, 'accept-language': 'pt_BR' }; // pt_BR = unidades métricas

    if (path === '/api/fitbit/weight') {
      const days = Math.min(31, Math.max(1, Math.round(body.days || 30)));
      const f = (d) => d.toISOString().slice(0, 10);
      const end = new Date(), start = new Date(Date.now() - (days - 1) * 86400000);
      const [wr, fr] = await Promise.all([
        fetch('https://api.fitbit.com/1/user/-/body/log/weight/date/' + f(start) + '/' + f(end) + '.json', { headers: h }),
        fetch('https://api.fitbit.com/1/user/-/body/log/fat/date/' + f(start) + '/' + f(end) + '.json', { headers: h }),
      ]);
      if (!wr.ok) return jsonResp({ error: { message: 'Fitbit respondeu HTTP ' + wr.status + ' no peso' } }, 502);
      const wj = await wr.json();
      const fj = fr.ok ? await fr.json() : { fat: [] };
      const byDate = {};
      (wj.weight || []).forEach((x) => { if (x.date && typeof x.weight === 'number') byDate[x.date] = { date: x.date, weight: x.weight }; });
      (fj.fat || []).forEach((x) => { if (x.date && byDate[x.date] && typeof x.fat === 'number') byDate[x.date].bf = x.fat; });
      return jsonResp({ entries: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)) });
    }

    if (path === '/api/fitbit/activity') {
      const durationMin = Math.max(1, Math.round(body.durationMin || 45));
      const cal = Math.round(durationMin * 6); // estimativa: ~6 kcal/min de musculação
      const params = new URLSearchParams({
        activityName: String(body.name || 'Musculação').slice(0, 60),
        manualCalories: String(cal),
        startTime: String(body.startTime || '12:00'),
        durationMillis: String(durationMin * 60000),
        date: String(body.date || new Date().toISOString().slice(0, 10)),
      });
      const ar = await fetch('https://api.fitbit.com/1/user/-/activities.json', {
        method: 'POST',
        headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      if (!ar.ok) return jsonResp({ error: { message: 'Fitbit respondeu HTTP ' + ar.status + ' na atividade' } }, 502);
      return jsonResp({ ok: true, calories: cal });
    }

    return jsonResp({ error: { message: 'rota fitbit desconhecida' } }, 404);
  }

  // Access token válido, renovando se preciso. Refresh token do Fitbit é de uso
  // único — o DO é single-thread, então não há corrida ao renovar aqui dentro.
  async fbAccessToken() {
    const st = this.storage;
    let t = await st.get('fitbit');
    if (!t) return null;
    if (Date.now() < (t.expires_at || 0) - 60000) return t.access_token;
    if (!this.env.FITBIT_CLIENT_ID || !this.env.FITBIT_CLIENT_SECRET) return null;
    const basic = btoa(this.env.FITBIT_CLIENT_ID + ':' + this.env.FITBIT_CLIENT_SECRET);
    const resp = await fetch('https://api.fitbit.com/oauth2/token', {
      method: 'POST',
      headers: { authorization: 'Basic ' + basic, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(t.refresh_token),
    });
    if (!resp.ok) {
      if (resp.status === 400 || resp.status === 401) await st.delete('fitbit'); // autorização morreu: reconectar
      return null;
    }
    const j = await resp.json();
    t = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in || 28800) * 1000,
      user_id: j.user_id || t.user_id,
      linked_at: t.linked_at,
    };
    await st.put('fitbit', t);
    return t.access_token;
  }

  async handleSync(request) {
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
