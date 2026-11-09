(function (root) {
  'use strict';
  const families = Object.freeze({
    seller: Object.freeze({ label: 'Seller', title: 'Dach Seller', href: '/seller', section: 'marketplaces' }),
    business: Object.freeze({ label: 'Business', title: 'Dach Business', href: '/business', section: 'gestão' }),
    ads: Object.freeze({ label: 'Ads', title: 'Dach Ads', href: '/ads', section: 'performance' })
  });
  const products = {
    seller: [
      { label: 'Mercado Livre', href: '/seller/mercado-livre', login: '/ml/login', key: 'ml' },
      { label: 'Shopee', href: '/seller/shopee', login: '/shopee', key: 'shopee' },
      { label: 'Magalu', href: '/seller/magalu', login: '/go/magalu', key: 'magalu' }
    ],
    business: [
      { label: 'Stock', href: '/voltstock', login: '/voltstock/login', key: 'stock' },
      { label: 'Core', href: '/core', login: '/core/app', key: 'core' },
      { label: 'Chat', href: '/chat/', login: '/login', key: 'chat' },
      { label: 'Price', href: '/business/price', login: '/volt-price', key: 'price' }
    ],
    ads: [
      { label: 'DACH Ads', href: '/ads', login: '/ads/app', key: 'ads' }
    ]
  };
  function margin(price, discount, ads) {
    const revenue = price * (1 - discount / 100);
    const fees = revenue * .16;
    const fixed = 45 + 12 + ads;
    const profit = revenue - fees - fixed;
    return {
      revenue: +revenue.toFixed(2),
      fees: +fees.toFixed(2),
      profit: +profit.toFixed(2),
      margin: +(revenue ? profit / revenue * 100 : 0).toFixed(2),
      breakEven: +(fixed / (.84 * (1 - discount / 100))).toFixed(2)
    };
  }
  // Fila do dia (Shopee): mesma lista em duas ordens. Horários em minutos desde 0h de hoje (ontem < 0, amanhã > 1440).
  const orders = [
    { id: 'SH-4831', title: 'Garrafa térmica', arrived: 12 * 60 + 58, shipBy: 1440 + 12 * 60 },
    { id: 'SH-4826', title: 'Kit organizador', arrived: 11 * 60 + 40, shipBy: 16 * 60 },
    { id: 'SH-4819', title: 'Fone bluetooth', arrived: 10 * 60 + 5, shipBy: 18 * 60 },
    { id: 'SH-4812', title: 'Luminária de mesa', arrived: 8 * 60 + 30, shipBy: 14 * 60 },
    { id: 'SH-4807', title: 'Capa de celular', arrived: -(1440 - 22 * 60 - 10), shipBy: 12 * 60 },
    { id: 'SH-4798', title: 'Tapete de banheiro', arrived: -(1440 - 19 * 60 - 45), shipBy: 11 * 60 }
  ];
  // Ordena a fila: por chegada (mais recentes primeiro, como uma lista comum) ou por prazo de envio.
  const orderQueue = (list, mode) => [...list].sort((a, b) => mode === 'deadline' ? a.shipBy - b.shipBy : b.arrived - a.arrived);
  // Situação de um pedido no horário "agora": atrasado, vence logo (até 2h) ou no prazo.
  const deadlineState = (order, now) => { const left = order.shipBy - now; return { left, state: left < 0 ? 'late' : left <= 120 ? 'soon' : 'ok' }; };
  const businessSteps = [
    ['Stock', 'Uma posição pede reposição.', 'O setor A-01 chegou a 8 unidades no exemplo. O estoque dá contexto à decisão.', '8 unidades', 'Estoque disponível'],
    ['Chat', 'A exceção ganha um responsável.', 'A equipe recebe uma solicitação com setor, prioridade e histórico. Nada depende de uma mensagem solta.', '1 solicitação', 'Responsável: operações'],
    ['Core', 'A equipe avalia a próxima compra.', 'A necessidade chega à gestão para análise e aprovação. Este cenário ilustra a jornada; confirme as integrações disponíveis na demonstração.', 'Em análise', 'Decisão da equipe']
  ];
  const moduleKey = (family, moduleName) => {
    const normalized = String(moduleName || '').toLowerCase();
    if (family === 'seller') return ({ 'mercado livre': 'ml', shopee: 'shopee', magalu: 'magalu' })[normalized];
    if (family === 'business') return normalized === 'business' ? undefined : normalized;
    if (family === 'ads') return normalized === 'ads' || normalized === 'dach ads' ? 'ads' : normalized;
    return undefined;
  };
  const loginDestination = (family, moduleName) => {
    const active = (products[family] || []).find(product => product.key === moduleKey(family, moduleName));
    return active ? active.login : '/login';
  };
  const nextStep = (step, total) => total > 0 ? Math.min(step + 1, total - 1) : 0;
  if (typeof module !== 'undefined' && module.exports) module.exports = { margin, nextStep, orders, orderQueue, deadlineState, businessSteps, loginDestination };
  if (!root.document) return;
  const money = value => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const linkList = (family, activeKey) => (products[family] || []).map(({ label, href, key }) => `<a href="${href}"${key === activeKey ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const familyNav = activeFamily => Object.entries(families).map(([key, config]) => `<a href="${config.href}" ${key === activeFamily ? 'aria-current="page"' : ''}>${config.label}</a>`).join('');
  const productMenu = activeKey => Object.entries(families).map(([key, config]) => `<strong>${config.label} · ${config.section}</strong>${linkList(key, activeKey)}`).join('');
  const pageActions = (family, moduleName) => {
    const contactSection = document.querySelector('#contato, #cta, .final-cta');
    return {
      login: loginDestination(family, moduleName),
      contact: contactSection && contactSection.id ? '#' + contactSection.id : '#dachbyte-contact'
    };
  };
  // Formulário de contato das landings: o cliente escolhe se quer resposta por WhatsApp ou e-mail.
  // Envia para /api/contact/commercial (o gateway manda o lead por e-mail para a equipe).
  const leadVolumes = ['Até 300 pedidos por mês', '300 a 1.000 pedidos por mês', '1.000 a 5.000 pedidos por mês', 'Mais de 5.000 pedidos por mês'];
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function contactForm(host, family, interest) {
    if (!host || host.dataset.dxFormMounted === 'true') return;
    host.dataset.dxFormMounted = 'true';
    const options = family === 'seller' ? ['Mercado Livre', 'Shopee', 'Magalu', 'Outro canal'] : [...(products[family] || []).map(p => p.label), 'Outro'];
    const checked = label => String(interest || '').toLowerCase() === label.toLowerCase() ? ' checked' : '';
    host.innerHTML = `<form class="dx-lead" novalidate>
      <label class="dx-field"><span>Nome</span><input name="name" autocomplete="name" required></label>
      <fieldset class="dx-choice"><legend>Como prefere que a gente fale com você?</legend>
        <label><input type="radio" name="contact_preference" value="whatsapp" checked><span>WhatsApp</span></label>
        <label><input type="radio" name="contact_preference" value="email"><span>E-mail</span></label>
      </fieldset>
      <label class="dx-field" data-when="whatsapp"><span>WhatsApp com DDD</span><input name="cellphone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(11) 91234-5678"></label>
      <label class="dx-field" data-when="email" hidden><span>E-mail</span><input name="email" type="email" autocomplete="email" placeholder="voce@empresa.com.br"></label>
      <fieldset class="dx-chips"><legend>${family === 'seller' ? 'Onde você vende' : 'Produtos de interesse'}</legend>${options.map(o => `<label><input type="checkbox" name="channels" value="${escapeHtml(o)}"${checked(o)}><span>${escapeHtml(o)}</span></label>`).join('')}</fieldset>
      <label class="dx-field"><span>Pedidos por mês <small>(opcional)</small></span><select name="orders_volume"><option value="">Selecione</option>${leadVolumes.map(v => `<option>${v}</option>`).join('')}</select></label>
      <input class="dx-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button class="dx-primary" type="submit">Quero conversar</button>
      <p class="dx-lead__note">A equipe DACHBYTE responde pelo canal que você escolher. Seus dados servem só para este contato. <a href="/privacidade">Privacidade</a></p>
      <p class="dx-lead__status" role="status" aria-live="polite"></p>
    </form>`;
    const form = host.querySelector('form');
    const status = form.querySelector('.dx-lead__status');
    const field = name => form.elements[name];
    const preference = () => form.querySelector('[name="contact_preference"]:checked').value;
    const syncPreference = () => form.querySelectorAll('[data-when]').forEach(el => { el.hidden = el.dataset.when !== preference(); });
    form.querySelectorAll('[name="contact_preference"]').forEach(r => r.addEventListener('change', syncPreference));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const pref = preference();
      const channels = [...form.querySelectorAll('[name="channels"]:checked')].map(c => c.value);
      const payload = {
        name: field('name').value.trim(), contact_preference: pref,
        cellphone: field('cellphone').value.trim(), email: field('email').value.trim(), channels,
        orders_volume: field('orders_volume').value, website: field('website').value,
        page_path: location.pathname
      };
      const problem = payload.name.length < 3 ? ['name', 'Informe seu nome.']
        : pref === 'whatsapp' && payload.cellphone.replace(/\D/g, '').length < 10 ? ['cellphone', 'Informe o WhatsApp com DDD.']
        : pref === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ? ['email', 'Informe um e-mail válido.']
        : !channels.length ? ['channels', 'Marque pelo menos uma opção.'] : null;
      if (problem) { status.textContent = problem[1]; status.dataset.tone = 'error'; const el = form.querySelector(`[name="${problem[0]}"]`); if (el) el.focus(); return; }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true; button.textContent = 'Enviando…'; status.textContent = ''; delete status.dataset.tone;
      try {
        const res = await fetch('/api/contact/commercial', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Não foi possível enviar agora. Tente de novo em instantes.');
        host.innerHTML = `<div class="dx-lead dx-lead--done" role="status"><strong>Recebemos seu contato.</strong><p>Vamos falar com você por ${pref === 'whatsapp' ? 'WhatsApp' : 'e-mail'}.</p></div>`;
      } catch (error) {
        button.disabled = false; button.textContent = 'Quero conversar';
        status.textContent = error.message; status.dataset.tone = 'error';
      }
    });
  }
  const mount = (host, family, moduleName) => {
    if (!host) return () => {};
    const familyConfig = families[family];
    if (!familyConfig) return () => {};
    let nav = host.querySelector('.dx-global');
    if (!nav) {
      host.dataset.mounted = 'true';
      document.body.classList.add('dx-marketing');
      document.body.dataset.dxFamily = family;
      const activeKey = moduleKey(family, moduleName);
      const actions = pageActions(family, moduleName);
      nav = document.createElement('div');
      nav.className = 'dx-global';
      nav.innerHTML = `<div class="dx-global-inner"><a class="dx-home" href="${familyConfig.href}">DACHBYTE <span>${familyConfig.label}</span></a><nav aria-label="Famílias DACHBYTE">${familyNav(family)}</nav><details class="dx-products"><summary><span class="dx-products-long">Explorar produtos</span><span class="dx-products-short">Produtos</span></summary><div>${productMenu(activeKey)}</div></details><div class="dx-global-actions"><a class="dx-login" href="${actions.login}">Entrar</a><a class="dx-talk" href="${actions.contact}"><span class="dx-talk-long">Falar com a DACHBYTE</span><span class="dx-talk-short">Contato</span></a></div></div></div>`;
      host.append(nav);
      nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => { nav.querySelector('details').open = false; }));
      nav.dxEscape = e => { if (e.key === 'Escape') nav.querySelector('details').open = false; };
      document.addEventListener('keydown', nav.dxEscape);
    }
    if (document.readyState === 'loading') return () => nav.remove();
    if (host.dataset.pageMounted === 'true') return () => {};
    host.dataset.pageMounted = 'true';
    const contact = document.createElement('section');
    contact.id = 'dachbyte-contact';
    contact.className = 'dx-contact';
    contact.innerHTML = `<div><span class="dx-eyebrow">Vamos olhar para sua operação</span><h2>Veja o produto com a sua rotina em mente.</h2><p>Conte qual produto procura e a tarefa que mais toma tempo. A equipe DACHBYTE responde por WhatsApp ou e-mail, como você preferir.</p></div><div data-dx-contact-form data-dx-interest="${moduleName || ''}"></div>`;
    const footer = document.createElement('footer');
    footer.className = 'dx-footer';
    footer.innerHTML = `<a href="${familyConfig.href}">← Todos os produtos ${familyConfig.label}</a><nav aria-label="Outros produtos">${linkList(family)}</nav><a href="/privacidade">Privacidade</a>`;
    const main = document.querySelector('main') || document.body;
    const hasContact = document.querySelector('#contato, #cta, .final-cta');
    const hasFooter = document.querySelector('footer');
    if (!hasContact) { main.append(contact); contactForm(contact.querySelector('[data-dx-contact-form]'), family, moduleName); } else contact.remove();
    if (!hasFooter) main.append(footer); else footer.remove();
    return () => { nav.remove(); contact.remove(); footer.remove(); document.removeEventListener('keydown', nav.dxEscape); document.body.classList.remove('dx-marketing'); delete document.body.dataset.dxFamily; delete host.dataset.mounted; delete host.dataset.pageMounted; };
  };
  function buildExperience(el, type) {
    if (el.dataset.dxExperienceMounted === 'true') return;
    el.dataset.dxExperienceMounted = 'true';
    el.classList.add('dx-experience');
    const title = type === 'business' ? 'Uma exceção. Três equipes conectadas.' : type === 'ml' ? 'Você vendeu. Quanto ficou?' : type === 'magalu' ? 'Você vendeu no Magalu. Quanto ficou?' : type === 'shopee' ? 'Qual pedido precisa de você agora?' : 'Da venda ao pedido, experimente a decisão.';
    const intro = type === 'business' ? 'Avance pelo cenário de reposição e veja como cada produto participa da rotina.' : 'Mude os controles e acompanhe o efeito. Uma prévia para explorar antes de conversar com a equipe.';
    el.innerHTML = `<header class="dx-section-head"><span class="dx-eyebrow">${type === 'business' ? 'Fluxo Business' : 'Laboratório Seller'} · interativo</span><h2>${title}</h2><p>${intro}</p><span class="dx-demo-label">Simulação local · dados fictícios · nenhuma ação na sua conta</span></header><div class="dx-workbench"></div>`;
    const bench = el.querySelector('.dx-workbench');
    if (type === 'business') return business(bench);
    const scene = ({ ml: calculator, magalu: calculator, shopee: queue })[type];
    if (scene) return scene(bench);
    const buttons = document.createElement('div');
    buttons.className = 'dx-switch';
    buttons.setAttribute('aria-label', 'Escolher demonstração');
    const panel = document.createElement('div');
    const scenes = [['Margem · Mercado Livre', calculator], ['Pedidos · Shopee', queue]];
    scenes.forEach(([label, fn], i) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.setAttribute('aria-pressed', String(i === 0));
      b.addEventListener('click', () => { buttons.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); panel.replaceChildren(); fn(panel); }); buttons.append(b);
    });
    bench.append(buttons, panel); calculator(panel);
  }
  function calculator(panel) {
    panel.innerHTML = `<div class="dx-grid"><div class="dx-controls"><h3>Uma venda de R$ 100 pode ter muitos resultados.</h3><p>Teste preço, desconto e mídia. Compare o que entra com o que sobra depois dos custos do exemplo.</p><label>Preço anunciado <output data-price-label></output><input aria-label="Preço anunciado" data-price type="range" min="70" max="200" value="100" step="1"></label><label>Desconto <output data-discount-label></output><input aria-label="Desconto" data-discount type="range" min="0" max="35" value="0" step="1"></label><label>Ads por venda <output data-ads-label></output><input aria-label="Ads por venda" data-ads type="range" min="0" max="30" value="8" step="1"></label><small>Hipóteses didáticas: produto R$ 45, frete R$ 12, taxa de 16% sobre a venda. Não é uma cotação do marketplace; impostos e outros custos não estão incluídos.</small></div><div class="dx-scene"><div class="dx-receipt"><span class="dx-eyebrow">Resultado estimado do cenário</span><strong class="dx-profit" data-profit></strong><p data-percent></p><div class="dx-waterfall" role="img" aria-label="Composição do valor da venda"><div><i data-cost-bar></i><span>Produto + frete</span></div><div><i data-fees-bar></i><span>Taxa + Ads</span></div><div><i data-profit-bar></i><span>Resultado</span></div></div><dl><div><dt>Venda após desconto</dt><dd data-revenue></dd></div><div><dt>Preço mínimo para empatar</dt><dd data-break-even></dd></div></dl><p class="dx-insight" role="status" data-insight></p></div></div></div>`;
    const update = () => {
      const p = +panel.querySelector('[data-price]').value, d = +panel.querySelector('[data-discount]').value, a = +panel.querySelector('[data-ads]').value;
      const r = margin(p, d, a);
      for (const [key, value] of Object.entries({ 'price-label': money(p), 'discount-label': d + '%', 'ads-label': money(a), profit: money(r.profit), percent: r.margin.toFixed(1).replace('.', ',') + '% de margem estimada', revenue: money(r.revenue), 'break-even': money(r.breakEven), insight: r.profit < 0 ? 'Neste cenário, cada venda dá prejuízo. Reveja desconto, preço ou custos.' : r.margin < 15 ? 'O desconto está consumindo o resultado. Compare uma condição diferente.' : 'Resultado positivo neste exemplo. Antes de decidir, considere todos os seus custos.' })) panel.querySelector(`[data-${key}]`).textContent = value;
      panel.querySelector('.dx-receipt').classList.toggle('dx-negative', r.profit < 0);
      [['cost', 57], ['fees', r.fees + a], ['profit', Math.max(0, r.profit)]].forEach(([key, value]) => panel.querySelector(`[data-${key}-bar]`).style.height = Math.max(2, Math.min(100, value / Math.max(r.revenue, 1) * 100)) + '%');
    };
    panel.querySelectorAll('input').forEach(input => input.addEventListener('input', update)); update();
  }
  function queue(panel) {
    const clock = m => { const d = ((m % 1440) + 1440) % 1440; return `${Math.floor(d / 60)}h${String(d % 60).padStart(2, '0')}`; };
    const day = m => m >= 1440 ? 'amanhã ' : m < 0 ? 'ontem ' : '';
    const leftLabel = left => left < 0 ? `atrasado há ${left > -60 ? -left + ' min' : Math.floor(-left / 60) + 'h' + String(-left % 60).padStart(2, '0')}` : left < 60 ? `vence em ${left} min` : `vence em ${Math.floor(left / 60)}h${String(left % 60).padStart(2, '0')}`;
    let mode = 'arrival', now = 10 * 60 + 30;
    panel.innerHTML = `<div class="dx-grid"><div class="dx-controls"><h3>A ordem da fila decide o que atrasa.</h3><p>Mesmos 6 pedidos, duas ordens. Mova o relógio e veja quais prazos de envio vencem enquanto a equipe trabalha de cima para baixo.</p><div class="dx-switch" role="group" aria-label="Ordem da fila"><button type="button" data-mode="arrival" aria-pressed="true">Mais recentes primeiro</button><button type="button" data-mode="deadline" aria-pressed="false">Por prazo (DACHBYTE)</button></div><label>Agora <output data-now-label></output><input aria-label="Horário agora" data-now type="range" min="540" max="1020" step="15" value="${now}"></label><small>Exemplo com dados fictícios. Prazos de envio são os que o marketplace define para cada pedido.</small></div><div class="dx-scene"><div class="dx-order"><span class="dx-eyebrow" data-queue-title></span><ol class="dx-queue" data-queue></ol><p class="dx-insight" role="status" data-queue-insight></p></div></div></div>`;
    const render = () => {
      const list = orderQueue(orders, mode);
      panel.querySelector('[data-now-label]').textContent = clock(now);
      panel.querySelector('[data-queue-title]').textContent = mode === 'deadline' ? 'Fila por prazo de envio' : 'Fila por chegada';
      panel.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
      panel.querySelector('[data-queue]').innerHTML = list.map((o, i) => { const st = deadlineState(o, now); return `<li class="dx-queue__row dx-queue__row--${st.state}"><span class="dx-queue__pos">${i + 1}</span><span class="dx-queue__main"><strong>${o.id} · ${o.title}</strong><small>chegou ${day(o.arrived)}${clock(o.arrived)} · enviar até ${day(o.shipBy)}${clock(o.shipBy)}</small></span><span class="dx-queue__badge">${st.state === 'ok' ? 'no prazo' : leftLabel(st.left)}</span></li>`; }).join('');
      const urgent = list.map((o, i) => ({ o, i, st: deadlineState(o, now) })).filter(x => x.st.state !== 'ok');
      const late = urgent.filter(x => x.st.state === 'late').length;
      const plural = urgent.length > 1;
      const nums = urgent.map(x => x.i + 1);
      const positions = nums.length > 1 ? nums.slice(0, -1).join(', ') + ' e ' + nums[nums.length - 1] : String(nums[0] || '');
      const insight = !urgent.length ? 'Nenhum prazo vence nas próximas 2 horas neste horário.'
        : mode === 'arrival' ? `${urgent.length} pedido${plural ? 's' : ''} ${late ? (plural ? 'atrasados ou vencendo' : 'atrasado ou vencendo') : 'vencendo em até 2h'} fica${plural ? 'm nas posições' : ' na posição'} ${positions} da lista. Trabalhando de cima para baixo, ${plural ? 'eles saem' : 'ele sai'} por último.`
        : `${plural ? `Os ${urgent.length} pedidos com prazo mais curto vêm` : 'O pedido com prazo mais curto vem'} primeiro. A equipe começa pelo que vence antes${late ? '; o que já atrasou fica visível no topo' : ''}.`;
      panel.querySelector('[data-queue-insight]').textContent = insight;
    };
    panel.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; render(); }));
    panel.querySelector('[data-now]').addEventListener('input', e => { now = +e.target.value; render(); });
    render();
  }
  function business(panel) {
    let step = 0;
    panel.innerHTML = `<div class="dx-grid"><div><h3>Da posição no estoque à decisão da equipe.</h3><p>Uma demonstração conceitual de reposição. Explore cada etapa para entender o papel dos produtos.</p><div class="dx-switch">${businessSteps.map((s, i) => `<button type="button" data-step="${i}" aria-pressed="${i === 0}">${s[0]}</button>`).join('')}</div><div class="dx-business-copy" aria-live="polite"><h3 data-step-title></h3><p data-step-copy></p></div><button class="dx-primary" type="button" data-advance>Próxima etapa →</button><button class="dx-reset" type="button" data-restart>Reiniciar</button></div><div class="dx-scene"><div class="dx-stack">${businessSteps.map((s, i) => `<div class="dx-stack-layer" data-layer="${i}"><span>${s[0]}</span><strong>${s[3]}</strong><small>${s[4]}</small></div>`).join('')}</div></div></div>`;
    const render = () => { panel.querySelector('[data-step-title]').textContent = businessSteps[step][1]; panel.querySelector('[data-step-copy]').textContent = businessSteps[step][2]; panel.querySelectorAll('[data-step]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.step === step))); panel.querySelectorAll('[data-layer]').forEach(l => l.classList.toggle('dx-layer-active', +l.dataset.layer === step)); panel.querySelector('[data-advance]').disabled = step === 2; panel.querySelector('[data-advance]').textContent = step === 2 ? 'Cenário completo' : 'Próxima etapa →'; };
    panel.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => { step = +b.dataset.step; render(); })); panel.querySelector('[data-advance]').addEventListener('click', () => { step = nextStep(step, 3); render(); }); panel.querySelector('[data-restart]').addEventListener('click', () => { step = 0; render(); }); render();
  }
  root.DachbyteLanding = { mount };
  const mountAll = () => {
    document.querySelectorAll('[data-dx-shell]').forEach(host => mount(host, host.dataset.dxShell, host.dataset.dxModule));
    if (document.readyState === 'loading') return;
    document.querySelectorAll('[data-dx-experience]').forEach(el => buildExperience(el, el.dataset.dxExperience));
    document.querySelectorAll('[data-dx-contact-form]').forEach(el => { const shell = document.querySelector('[data-dx-shell]'); contactForm(el, el.dataset.dxFamily || (shell && shell.dataset.dxShell) || 'seller', el.dataset.dxInterest); });
  };
  mountAll();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
