(() => {
  const experienceByPath = {
    '/seller': 'seller',
    '/seller/mercado-livre': 'ml',
    '/seller/shopee': 'shopee',
    '/seller/magalu': 'magalu',
  };
  const experience = experienceByPath[window.location.pathname.replace(/\/$/, '') || '/seller'];
  if (experience) {
    let host = document.querySelector('[data-dx-shell]');
    if (!host) {
      host = document.createElement('div');
      host.dataset.dxShell = 'seller';
      host.dataset.dxModule = experience === 'seller' ? 'Seller' : experience;
      document.body.prepend(host);
    }
    if (!document.querySelector('[data-dx-experience]')) {
      const section = document.createElement('section');
      section.dataset.dxExperience = experience;
      // A simulação entra depois de explicar o produto: funções (canais) ou módulos (página geral).
      const anchor = document.querySelector('#funcoes, #modulos') || document.querySelector('.seller-hero');
      if (anchor) anchor.after(section);
    }
  }
  const initSellerDemos = () => document.querySelectorAll('[data-seller-demo]').forEach((demo) => {
    const tabs = Array.from(demo.querySelectorAll('[data-seller-demo-tab]'));
    const panels = Array.from(demo.querySelectorAll('[data-seller-demo-panel]'));
    const select = (tab, focus) => {
      const target = tab.getAttribute('data-seller-demo-tab');
      tabs.forEach((item) => { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; });
      panels.forEach((panel) => { panel.hidden = panel.getAttribute('data-seller-demo-panel') !== target; });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (event) => {
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        select(tabs[(next + tabs.length) % tabs.length], true);
      });
    });
  });

  initSellerDemos();

  const main = document.querySelector('main');
  if (main && !document.querySelector('.seller-skip')) {
    if (!main.id) main.id = 'conteudo';
    main.tabIndex = -1;
    const skip = document.createElement('a');
    skip.className = 'seller-skip';
    skip.href = '#' + main.id;
    skip.textContent = 'Pular para o conteúdo';
    document.body.prepend(skip);
  }

  // Teste grátis de 7 dias, igual em todas as landings e na vitrine da landing geral:
  // [data-trial-start="<marketplace>"]. Com o teste ligado no servidor, o botão vira
  // "Testar grátis por 7 dias"; sem teste, o botão do topo continua no contato e os
  // demais (com hidden) ficam escondidos. Marketplace sem fluxo de teste ainda: sem
  // entrada aqui, o botão fica como está até o fluxo existir.
  const TRIAL_FLOWS = {
    ml: {
      availability: '/ml/api/meli/oauth/trial/availability',
      start: () => window.location.assign('/ml/teste-gratis'),
    },
    shopee: {
      availability: '/shopee/auth/trial/availability',
      start: async (link) => {
        link.textContent = 'Conectando à Shopee…';
        const response = await fetch('/shopee/auth/trial/start', { credentials: 'same-origin', cache: 'no-store' });
        const payload = response.ok ? await response.json() : null;
        if (!payload?.ok || !/^https:\/\//.test(payload.auth_url || '')) throw new Error('trial_start_unavailable');
        window.location.assign(payload.auth_url);
      },
    },
  };
  const trialAvailability = {};
  const isTrialAvailable = (slug) => {
    if (!trialAvailability[slug]) {
      trialAvailability[slug] = fetch(TRIAL_FLOWS[slug].availability, { credentials: 'same-origin', cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : { available: false }))
        .then((state) => state.available === true)
        .catch(() => false);
    }
    return trialAvailability[slug];
  };
  document.querySelectorAll('[data-trial-start]').forEach((link) => {
    const slug = link.dataset.trialStart;
    const flow = TRIAL_FLOWS[slug];
    if (!flow) return;
    isTrialAvailable(slug).then((available) => {
      if (!available) return;
      link.hidden = false;
      link.textContent = 'Testar grátis por 7 dias';
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        if (link.dataset.loading === 'true') return;
        link.dataset.loading = 'true';
        try {
          await flow.start(link);
        } catch (_error) {
          link.textContent = 'Tentar de novo';
          link.dataset.loading = 'false';
        }
      });
    });
  });
})();
