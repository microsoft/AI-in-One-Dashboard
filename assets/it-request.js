(() => {
  'use strict';
  const root = document.querySelector('.it-runbook');
  if (!root) return;
  const form = root.querySelector('#it-request-form');
  const route = root.querySelector('#it-runbook-route');
  const auth = root.querySelector('#it-auth-path');
  const result = root.querySelector('#it-request-result');
  const output = root.querySelector('#it-request-text');
  const copy = root.querySelector('#it-request-copy');
  const status = root.querySelector('#it-request-status');
  const labels = Object.fromEntries([...route.options].map(option => [option.value, option.textContent]));
  const tasks = {
    sharepoint: 'For this edition, the report reads data files kept in a SharePoint document library. Please use PAX (Portable Audit eXporter) to collect and prepare those files, give the collection account permission to update them, and give Power BI permission to read them.',
    local: 'I want to open the report in Power BI Desktop using data files stored on my computer. Please collect and prepare those files with PAX (Portable Audit eXporter), then help me connect them to the report.',
    fabric: 'Please use the supplied Fabric notebooks to collect our Microsoft 365 data and prepare it in a Fabric Lakehouse. Set up the required application permissions and secure credentials, then connect the Power BI report to the prepared data.',
    'pax-fabric': 'Please use PAX (Portable Audit eXporter) to prepare our report data as tables in Fabric OneLake, then give Power BI permission to read those tables. Please agree on a supported way to update the tables before scheduling refreshes.'
  };
  const controls = root.querySelector('.it-runbook-controls');
  const header = document.querySelector('.site-header');
  const updateStickyLayout = () => {
    root.style.setProperty('--it-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`);
    root.style.setProperty('--it-controls-height', `${Math.ceil(controls.getBoundingClientRect().height)}px`);
  };
  const layoutObserver = new ResizeObserver(updateStickyLayout);
  layoutObserver.observe(header);
  layoutObserver.observe(controls);
  updateStickyLayout();
  const resizeNote = () => {
    if (result.hidden) return;
    output.style.height = 'auto';
    const style = getComputedStyle(output);
    output.style.height = `${output.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
  };
  let noteWidth = 0;
  const noteObserver = new ResizeObserver(entries => {
    const width = entries[0].contentRect.width;
    if (width !== noteWidth) {
      noteWidth = width;
      resizeNote();
    }
  });
  noteObserver.observe(output);
  const invalidate = () => {
    if (result.hidden) return;
    result.hidden = true;
    output.value = '';
    copy.removeAttribute('data-copy');
    status.textContent = 'Choices changed. Generate an updated note before copying.';
  };
  const render = () => {
    root.querySelectorAll('[data-it-current-route]').forEach(node => { node.textContent = labels[route.value]; });
    root.querySelectorAll('[data-it-routes], [data-it-auth]').forEach(node => {
      node.hidden = Boolean(node.dataset.itRoutes && !node.dataset.itRoutes.split(' ').includes(route.value) ||
        node.dataset.itAuth && !node.dataset.itAuth.split(' ').includes(auth.value));
    });
  };
  const updateLink = () => {
    const url = new URL(location.href);
    url.searchParams.set('edition', route.value);
    const target = document.getElementById(location.hash.slice(1));
    if (target && !target.getClientRects().length) url.hash = '';
    history.replaceState(history.state, '', url);
  };
  const revealAnchor = () => {
    const target = document.getElementById(location.hash.slice(1));
    if (!target) return;
    const previousRoute = route.value;
    for (let node = target; node && node !== root; node = node.parentElement) {
      const routes = node.dataset.itRoutes?.split(' ');
      if (routes && !routes.includes(route.value)) route.value = routes[0];
      const methods = node.dataset.itAuth?.split(' ');
      if (methods && !methods.includes(auth.value)) auth.value = methods[0];
    }
    // PAX authentication sections sit inside a multi-route source-data block.
    if (target.closest('[data-it-auth]') && route.value === 'fabric') route.value = 'sharepoint';
    render();
    if (previousRoute !== route.value) invalidate();
    updateLink();
    target.scrollIntoView({ block: 'start' });
  };
  const edition = new URLSearchParams(location.search).get('edition');
  if (Object.hasOwn(labels, edition)) route.value = edition;
  render();
  if (location.hash) revealAnchor();
  route.addEventListener('change', () => {
    const left = scrollX, top = scrollY;
    render();
    invalidate();
    updateLink();
    root.style.minHeight = '';
    const missingHeight = top + innerHeight - document.documentElement.scrollHeight;
    // A shorter route must not make the browser clamp the saved scroll position.
    if (missingHeight > 0) root.style.minHeight = `${root.getBoundingClientRect().height + missingHeight}px`;
    window.scrollTo({ left, top, behavior: 'instant' });
  });
  auth.addEventListener('change', render);
  addEventListener('hashchange', revealAnchor);
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const audience = form.elements.namedItem('audience').value.trim();
    const notes = form.elements.namedItem('notes').value.trim();
    output.value = `Help setting up AI-in-One - ${labels[route.value]} edition

Hi IT team,

I'd like to use AI-in-One, a Power BI dashboard for understanding Microsoft 365 Copilot and agent usage. Please help me set up the ${labels[route.value]} edition.

${tasks[route.value]}
${audience ? '\nThe report is intended for:\n' + audience + '\n' : ''}${notes ? '\nA few details that may help:\n' + notes + '\n' : ''}
This guide explains the permissions, data preparation and report connection for this edition:
https://microsoft.github.io/AI-in-One-Dashboard/setup-reference.html?edition=${route.value}

Before collecting data, please confirm the reporting period, people to include, who may see the report and how often it should update, following our organization's approval process. Please preserve any existing reporting history and privacy settings.

When it is ready, please let me know how to open the report and who will keep its data up to date.

Thank you.`;
    copy.dataset.copy = output.value;
    copy.textContent = 'Copy note';
    result.hidden = false;
    resizeNote();
    status.textContent = 'Note generated below. Nothing has been sent or submitted.';
    result.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  root.querySelector('#it-request-select').addEventListener('click', () => {
    output.focus();
    output.select();
  });
  form.querySelector('[type="submit"]').disabled = false;
})();
