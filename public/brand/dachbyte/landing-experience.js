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
  const orders = [
    { id: 'SH-4821', title: 'Kit organizador', issue: 'Separar até 14h30', action: 'Conferir os 2 itens e encaminhar para embalagem.', steps: ['Separação', 'Embalagem', 'Pronto para coleta'] },
    { id: 'SH-4817', title: 'Garrafa térmica', issue: 'Etiqueta pendente', action: 'Conferir o endereço antes de preparar a etiqueta.', steps: ['Conferência', 'Etiqueta pronta', 'Pronto para coleta'] },
    { id: 'SH-4813', title: 'Luminária de mesa', issue: 'Coleta agendada', action: 'Conferir o pacote e registrar a entrega à transportadora.', steps: ['Pacote pronto', 'Conferido', 'Despachado'] }
  ];
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
  if (typeof module !== 'undefined' && module.exports) module.exports = { margin, nextStep, orders, businessSteps, loginDestination };
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
      <div class="dx-lead__grid">
        <label class="dx-field"><span>Nome</span><input name="name" autocomplete="name" required></label>
        <label class="dx-field"><span>Empresa <small>(opcional)</small></span><input name="company" autocomplete="organization"></label>
      </div>
      <fieldset class="dx-choice"><legend>Como prefere que a gente fale com você?</legend>
        <label><input type="radio" name="contact_preference" value="whatsapp" checked><span>WhatsApp</span></label>
        <label><input type="radio" name="contact_preference" value="email"><span>E-mail</span></label>
      </fieldset>
      <label class="dx-field" data-when="whatsapp"><span>WhatsApp com DDD</span><input name="cellphone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(11) 91234-5678"></label>
      <label class="dx-field" data-when="email" hidden><span>E-mail</span><input name="email" type="email" autocomplete="email" placeholder="voce@empresa.com.br"></label>
      <fieldset class="dx-chips"><legend>${family === 'seller' ? 'Onde você vende' : 'Produtos de interesse'}</legend>${options.map(o => `<label><input type="checkbox" name="channels" value="${escapeHtml(o)}"${checked(o)}><span>${escapeHtml(o)}</span></label>`).join('')}</fieldset>
      <label class="dx-field"><span>Pedidos por mês <small>(opcional)</small></span><select name="orders_volume"><option value="">Selecione</option>${leadVolumes.map(v => `<option>${v}</option>`).join('')}</select></label>
      <label class="dx-field"><span>O que mais toma tempo hoje? <small>(opcional)</small></span><textarea name="message" rows="3" maxlength="2000"></textarea></label>
      <input class="dx-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button class="dx-primary" type="submit">Enviar</button>
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
        name: field('name').value.trim(), company: field('company').value.trim(), contact_preference: pref,
        cellphone: field('cellphone').value.trim(), email: field('email').value.trim(), channels,
        orders_volume: field('orders_volume').value, message: field('message').value.trim(), website: field('website').value,
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
        button.disabled = false; button.textContent = 'Enviar';
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
    let selected = 0; const progress = [0, 0, 0];
    panel.innerHTML = `<div class="dx-grid"><div><h3>Comece pela pendência, não pela busca.</h3><p>Selecione um pedido. Avance o exemplo para acompanhar a mudança de etapa.</p><div class="dx-selection"></div><button class="dx-reset" type="button">Reiniciar exemplo</button></div><div class="dx-scene"><div class="dx-order"><div class="dx-package" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5"/><path d="M12 12v9"/><path d="M12 12L4 7.5"/><path d="M8 5.2l8 4.6"/></svg></div><span class="dx-eyebrow" data-id></span><h3 data-title></h3><p data-action></p><ol class="dx-stages"></ol><p role="status" data-status></p><button class="dx-primary" type="button" data-next>Avançar pedido simulado →</button></div></div></div>`;
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
