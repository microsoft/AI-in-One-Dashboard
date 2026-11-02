(() => {
  'use strict';
  const flow = document.querySelector('[data-setup-flow]');
  if (!flow) return;
  const $ = selector => flow.querySelector(selector);
  const routes = new Map([...flow.querySelectorAll('[data-setup-edition]')].map(node => [
    node.dataset.setupEdition, {
      title: node.dataset.editionTitle,
      label: node.dataset.editionLabel || node.dataset.editionTitle,
      available: node.dataset.editionAvailable === 'true'
    }
  ]));
  const url = new URL(location.href);
  let edition = routes.has(url.searchParams.get('edition')) ? url.searchParams.get('edition') : null;
  let run = ['local', 'sharepoint', 'pax-fabric'].includes(edition) && url.searchParams.get('collection') === 'update' ? 'update' : null;
  const editionDialog = $('#edition-dialog');
  const editionBody = $('.edition-dialog-body');
  const paxDialog = $('#pax-dialog');
  let previewEdition, editionOpener, paxOpener, savedScroll;
  const lock = () => document.body.classList.toggle('dialog-open', Boolean(document.querySelector('dialog[open]')));
  const snapshot = () => ({ edition, run });
  const getRoute = id => {
    if (!routes.has(id)) throw new Error('Unsupported setup edition.');
    return routes.get(id);
  };
  function preparePaxLinks(root) {
    root.querySelectorAll('a[data-open-pax]').forEach(link => {
      link.href = '#about-pax';
      link.removeAttribute('target');
    });
  }
  function renderPreview(detail = false) {
    const template = $(`#edition-${detail ? 'detail' : 'overview'}-${previewEdition}`);
    if (!template) throw new Error('The edition overview could not be loaded.');
    $('#edition-dialog-content').replaceChildren(template.content.cloneNode(true));
    preparePaxLinks($('#edition-dialog-content'));
    $('#edition-dialog-title').textContent = getRoute(previewEdition).title;
    $('#edition-dialog-back').hidden = !detail;
    $('#edition-dialog-choose').textContent = `Use ${getRoute(previewEdition).label}`;
    editionBody.scrollTop = 0;
  }
  function openPax(trigger) {
    if (paxDialog.open) return;
    paxOpener = trigger;
    savedScroll = editionDialog.open ? editionBody.scrollTop : null;
    paxDialog.querySelector('.edition-dialog-body').scrollTop = 0;
    paxDialog.showModal();
    lock();
    $('#pax-dialog-close').focus({ preventScroll: true });
  }
  window.AIO_SETUP = {
    getState: snapshot,
    getRoute,
    setBuilderSelection(id, value) {
      getRoute(id);
      if (value !== null && (!['local', 'sharepoint', 'pax-fabric'].includes(id) || !['initial', 'update'].includes(value))) {
        throw new Error('Unsupported collection intent.');
      }
      edition = id;
      run = value;
      window.dispatchEvent(new CustomEvent('aio:setup-change', { detail: snapshot() }));
    },
    openPaxOverview: openPax
  };
  document.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const pax = event.target.closest('[data-open-pax]');
    if (pax) { event.preventDefault(); openPax(pax); return; }
    const overview = event.target.closest('[data-edition-preview]');
    if (overview && flow.contains(overview)) {
      event.preventDefault();
      previewEdition = overview.dataset.editionPreview;
      editionOpener = overview;
      renderPreview();
      editionDialog.showModal();
      lock();
      $('#edition-dialog-close').focus({ preventScroll: true });
    } else if (event.target.closest('[data-edition-show-detail]')) renderPreview(true);
    else if (event.target.closest('[data-pax-collect]')) {
      event.preventDefault();
      paxDialog.close();
      if (editionDialog.open) editionDialog.close();
      window.dispatchEvent(new CustomEvent('aio:setup-request', { detail: 'prepare' }));
    }
  });
  $('#edition-dialog-choose').addEventListener('click', () => {
    const input = flow.querySelector(`[data-kitchen-edition][value="${previewEdition}"]`);
    if (!input) throw new Error('The selected edition is missing from this setup.');
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    editionDialog.close();
  });
  $('#edition-dialog-back').addEventListener('click', () => renderPreview());
  $('#edition-dialog-close').addEventListener('click', () => editionDialog.close());
  editionDialog.addEventListener('close', () => {
    lock();
    if (editionOpener?.isConnected && editionOpener.getClientRects().length) editionOpener.focus({ preventScroll: true });
  });
  $('#pax-dialog-close').addEventListener('click', () => paxDialog.close());
  $('#pax-dialog-return').addEventListener('click', () => paxDialog.close());
  paxDialog.addEventListener('close', () => {
    lock();
    if (editionDialog.open && savedScroll !== null) editionBody.scrollTop = savedScroll;
    if (paxOpener?.isConnected && paxOpener.getClientRects().length) paxOpener.focus({ preventScroll: true });
  });
  preparePaxLinks(document);
  flow.dataset.setupEnhanced = 'true';
})();
