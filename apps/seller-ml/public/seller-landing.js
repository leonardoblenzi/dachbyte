(() => {
  const button = document.querySelector('[data-seller-menu]');
  const nav = document.querySelector('[data-seller-nav]');
  if (!button || !nav) return;
  button.addEventListener('click', () => nav.classList.toggle('is-open'));
})();
