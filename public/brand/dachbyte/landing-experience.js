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
      { label: 'Magalu · em breve', href: '/seller/magalu', key: 'magalu' },
      { label: 'Rastreio', href: '/seller/rastreio', login: '/avantracking', key: 'tracking' }
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
  const orders = [
    { id: 'SH-4821', title: 'Kit organizador', issue: 'Separar até 14h30', action: 'Conferir os 2 itens e encaminhar para embalagem.', steps: ['Separação', 'Embalagem', 'Pronto para coleta'] },
    { id: 'SH-4817', title: 'Garrafa térmica', issue: 'Etiqueta pendente', action: 'Conferir o endereço antes de preparar a etiqueta.', steps: ['Conferência', 'Etiqueta pronta', 'Pronto para coleta'] },
    { id: 'SH-4813', title: 'Luminária de mesa', issue: 'Coleta agendada', action: 'Conferir o pacote e registrar a entrega à transportadora.', steps: ['Pacote pronto', 'Conferido', 'Despachado'] }
  ];
  const deliveries = [
    { id: 'PED-1048', title: 'Sem atualização', place: 'Centro de distribuição', age: 'Há 3 dias', state: 1, advice: 'Consultar a transportadora e avisar o cliente sobre o acompanhamento.' },
    { id: 'PED-1039', title: 'Previsão ultrapassada', place: 'Unidade de destino', age: 'Prazo excedido em 1 dia', state: 2, advice: 'Solicitar uma nova previsão e manter o cliente informado.' },
    { id: 'PED-1022', title: 'Entrega confirmada', place: 'Destino', age: 'Hoje, às 09h06', state: 3, advice: 'Encerrar o acompanhamento e preservar o histórico da entrega.' }
  ];
  const businessSteps = [
    ['Stock', 'Uma posição pede reposição.', 'O setor A-01 chegou a 8 unidades no exemplo. O estoque dá contexto à decisão.', '8 unidades', 'Estoque disponível'],
    ['Chat', 'A exceção ganha um responsável.', 'A equipe recebe uma solicitação com setor, prioridade e histórico. Nada depende de uma mensagem solta.', '1 solicitação', 'Responsável: operações'],
    ['Core', 'A equipe avalia a próxima compra.', 'A necessidade chega à gestão para análise e aprovação. Este cenário ilustra a jornada; confirme as integrações disponíveis na demonstração.', 'Em análise', 'Decisão da equipe']
  ];
  const nextStep = (step, total) => total > 0 ? Math.min(step + 1, total - 1) : 0;
  if (typeof module !== 'undefined' && module.exports) module.exports = { margin, nextStep, orders, deliveries, businessSteps };
  if (!root.document) return;
  const money = value => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const linkList = (family, activeKey) => (products[family] || []).map(({ label, href, key }) => `<a href="${href}"${key === activeKey ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const moduleKey = (family, moduleName) => {
    const normalized = String(moduleName || '').toLowerCase();
    if (family === 'seller') return ({ 'mercado livre': 'ml', shopee: 'shopee', magalu: 'magalu', rastreio: 'tracking', tracking: 'tracking' })[normalized];
    if (family === 'business') return normalized === 'business' ? undefined : normalized;
    if (family === 'ads') return normalized === 'ads' || normalized === 'dach ads' ? 'ads' : normalized;
    return undefined;
  };
  const familyNav = activeFamily => Object.entries(families).map(([key, config]) => `<a href="${config.href}" ${key === activeFamily ? 'aria-current="page"' : ''}>${config.label}</a>`).join('');
  const productMenu = activeKey => Object.entries(families).map(([key, config]) => `<strong>${config.label} · ${config.section}</strong>${linkList(key, activeKey)}`).join('');
  const pageActions = (family, moduleName) => {
    const active = products[family].find(product => product.key === moduleKey(family, moduleName));
    const contactSection = document.querySelector('#contato, #cta, .final-cta');
    return {
      login: active ? active.login : '/login',
      contact: contactSection && contactSection.id ? '#' + contactSection.id : `mailto:contato@davanttisuite.com.br?subject=${encodeURIComponent('Demonstração DACHBYTE ' + (moduleName || family))}`
    };
  };
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
      nav.innerHTML = `<div class="dx-global-inner"><a class="dx-home" href="${familyConfig.href}">DACHBYTE <span>${familyConfig.label}</span></a><nav aria-label="Famílias DACHBYTE">${familyNav(family)}</nav><details class="dx-products"><summary>Explorar produtos</summary><div>${productMenu(activeKey)}</div></details><div class="dx-global-actions"><a class="dx-login" href="${actions.login}">Entrar</a><a class="dx-talk" href="${actions.contact}">Falar com a DACHBYTE</a></div></div></div>`;
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
    contact.innerHTML = `<div><span class="dx-eyebrow">Vamos olhar para sua operação</span><h2>Veja o produto com a sua rotina em mente.</h2><p>Conte qual módulo procura, o tamanho da equipe e a tarefa que mais toma tempo. Use o e-mail abaixo para solicitar uma demonstração.</p></div><div><a class="dx-primary" href="mailto:contato@davanttisuite.com.br?subject=${encodeURIComponent('Demonstração DACHBYTE ' + (moduleName || family))}">Solicitar demonstração por e-mail ↗</a><p><a href="mailto:contato@davanttisuite.com.br">contato@davanttisuite.com.br</a></p><small>O botão abre seu aplicativo de e-mail. Você também pode copiar o endereço.</small></div>`;
    const footer = document.createElement('footer');
    footer.className = 'dx-footer';
    footer.innerHTML = `<a href="${familyConfig.href}">← Todos os produtos ${familyConfig.label}</a><nav aria-label="Outros produtos">${linkList(family)}</nav><a href="/privacidade">Privacidade</a>`;
    const main = document.querySelector('main') || document.body;
    const hasContact = document.querySelector('#contato, #cta, .final-cta');
    const hasFooter = document.querySelector('footer');
    if (!hasContact) main.append(contact); else contact.remove();
    if (!hasFooter) main.append(footer); else footer.remove();
    return () => { nav.remove(); contact.remove(); footer.remove(); document.removeEventListener('keydown', nav.dxEscape); document.body.classList.remove('dx-marketing'); delete document.body.dataset.dxFamily; delete host.dataset.mounted; delete host.dataset.pageMounted; };
  };
  function buildExperience(el, type) {
    if (el.dataset.dxExperienceMounted === 'true') return;
    el.dataset.dxExperienceMounted = 'true';
    el.classList.add('dx-experience');
    const title = type === 'business' ? 'Uma exceção. Três equipes conectadas.' : type === 'ml' ? 'Você vendeu. Quanto ficou?' : type === 'shopee' ? 'Qual pedido precisa de você agora?' : type === 'tracking' ? 'Uma entrega saiu da rota. E agora?' : 'Da venda à entrega, experimente a decisão.';
    const intro = type === 'business' ? 'Avance pelo cenário de reposição e veja como cada produto participa da rotina.' : 'Mude os controles e acompanhe o efeito. Uma prévia para explorar antes de conversar com a equipe.';
    el.innerHTML = `<header class="dx-section-head"><span class="dx-eyebrow">${type === 'business' ? 'Fluxo Business' : 'Laboratório Seller'} · interativo</span><h2>${title}</h2><p>${intro}</p><span class="dx-demo-label">Simulação local · dados fictícios · nenhuma ação na sua conta</span></header><div class="dx-workbench"></div>`;
    const bench = el.querySelector('.dx-workbench');
    if (type === 'business') return business(bench);
    if (type !== 'seller') return ({ ml: calculator, shopee: queue, tracking: tracking })[type](bench);
    const buttons = document.createElement('div');
    buttons.className = 'dx-switch';
    buttons.setAttribute('aria-label', 'Escolher demonstração');
    const panel = document.createElement('div');
    const scenes = [['Margem · Mercado Livre', calculator], ['Pedidos · Shopee', queue], ['Entregas · Rastreio', tracking]];
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
    let selected = 0; const progress = [0, 0, 0];
    panel.innerHTML = `<div class="dx-grid"><div><h3>Comece pela pendência, não pela busca.</h3><p>Selecione um pedido. Avance o exemplo para acompanhar a mudança de etapa.</p><div class="dx-selection"></div><button class="dx-reset" type="button">Reiniciar exemplo</button></div><div class="dx-scene"><div class="dx-order"><div class="dx-package" aria-hidden="true">↗</div><span class="dx-eyebrow" data-id></span><h3 data-title></h3><p data-action></p><ol class="dx-stages"></ol><p role="status" data-status></p><button class="dx-primary" type="button" data-next>Avançar pedido simulado →</button></div></div></div>`;
    const render = () => {
      const item = orders[selected];
      panel.querySelector('.dx-selection').innerHTML = orders.map((o, i) => `<button type="button" data-order="${i}" aria-pressed="${selected === i}"><span>${o.id} · ${o.title}</span><small>${progress[i] === 2 ? o.steps[2] : o.issue}</small></button>`).join('');
      panel.querySelectorAll('[data-order]').forEach(b => b.addEventListener('click', () => { selected = +b.dataset.order; render(); panel.querySelector(`[data-order="${selected}"]`).focus({ preventScroll: true }); }));
      panel.querySelector('[data-id]').textContent = item.id;
      panel.querySelector('[data-title]').textContent = item.title;
      panel.querySelector('[data-action]').textContent = item.action;
      panel.querySelector('.dx-stages').innerHTML = item.steps.map((s, i) => `<li ${i === progress[selected] ? 'aria-current="step"' : ''}>${s}</li>`).join('');
      panel.querySelector('[data-status]').textContent = 'Etapa atual: ' + item.steps[progress[selected]];
      panel.querySelector('[data-next]').disabled = progress[selected] === 2;
      panel.querySelector('[data-next]').textContent = progress[selected] === 2 ? 'Exemplo concluído' : 'Avançar pedido simulado →';
    };
    panel.querySelector('[data-next]').addEventListener('click', () => { progress[selected] = nextStep(progress[selected], 3); render(); });
    panel.querySelector('.dx-reset').addEventListener('click', () => { progress.fill(0); selected = 0; render(); }); render();
  }
  function tracking(panel) {
    panel.innerHTML = `<div class="dx-grid"><div><h3>Três trajetos. Prioridades diferentes.</h3><p>Escolha uma entrega para localizar a exceção e entender o próximo contato.</p><div class="dx-selection">${deliveries.map((d, i) => `<button type="button" data-delivery="${i}" aria-pressed="${i === 0}"><span>${d.id}</span><small>${d.title}</small></button>`).join('')}</div><p class="dx-insight" role="status" data-advice></p></div><div class="dx-logistics"><div class="dx-route-map" aria-label="Etapas da entrega"><div class="dx-route-line"></div>${['Origem', 'Distribuição', 'Unidade local', 'Destino'].map((s, i) => `<div class="dx-node" data-node="${i}"><span aria-hidden="true">${i === 3 ? '⌂' : '▣'}</span><b>${s}</b></div>`).join('')}</div><div class="dx-location"><strong data-place></strong><span data-age></span></div></div></div>`;
    const select = index => { const d = deliveries[index]; panel.querySelectorAll('[data-delivery]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.delivery === index))); panel.querySelectorAll('[data-node]').forEach(n => { n.classList.toggle('dx-node-active', +n.dataset.node === d.state); n.classList.toggle('dx-node-passed', +n.dataset.node < d.state); }); panel.querySelector('[data-place]').textContent = d.place; panel.querySelector('[data-age]').textContent = d.age; panel.querySelector('[data-advice]').textContent = d.advice; };
    panel.querySelectorAll('[data-delivery]').forEach(b => b.addEventListener('click', () => select(+b.dataset.delivery))); select(0);
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
  };
  mountAll();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
