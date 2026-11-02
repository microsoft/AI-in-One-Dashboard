(() => {
  'use strict';
  const pages = [
    { step: 'prepare', file: 'get-started.html', label: 'Choose', title: 'Choose your edition' },
    { step: 'collect', file: 'setup-collect.html', label: 'Collect', title: 'Prepare your report data' },
    { step: 'open-template', file: 'setup-open.html', label: 'Open', title: 'Open or refresh your report' },
    { step: 'share', file: 'setup-share.html', label: 'Share', title: 'Set up sharing and refresh' }
  ];
  const editions = ['sharepoint', 'local', 'fabric', 'pax-fabric', 'sample'];
  function href(step, { edition = null, run = null, back = null, next = null } = {}) {
    const page = pages.find(item => item.step === step);
    if (!page) throw new Error('Unsupported setup page.');
    if (edition !== null && !editions.includes(edition)) throw new Error('Unsupported setup edition.');
    if (run !== null && !['initial', 'update'].includes(run)) throw new Error('Unsupported collection choice.');
    const query = new URLSearchParams();
    if (edition) query.set('edition', edition);
    if (run === 'update') query.set('collection', 'update');
    if (back && pages.some(item => item.step === back)) query.set('back', back);
    if (next && pages.some(item => item.step === next)) query.set('next', next);
    return page.file + (query.size ? `?${query}` : '');
  }
  function resolveLegacy(url) {
    const target = new URL(url.href);
    if (!target.pathname.endsWith('/get-started.html')) return target;
    let hash;
    try { hash = decodeURIComponent(target.hash.slice(1)); }
    catch (error) {
      if (!(error instanceof URIError)) throw error;
      target.hash = '';
      target.searchParams.set('invalid', 'address');
      return target;
    }
    let edition = editions.includes(target.searchParams.get('edition')) ? target.searchParams.get('edition') : null;
    let step;
    let run = target.searchParams.get('collection') === 'update' ? 'update' : null;
    if (editions.includes(hash)) { edition = hash; step = 'collect'; }
    else if (pages.some(page => page.step === hash)) step = hash;
    else if (hash.startsWith('parameters-') && editions.includes(hash.slice(11))) {
      edition = hash.slice(11); step = 'open-template';
    } else if (hash === 'keep-current') { step = 'open-template'; run = 'update'; }
    else if (hash === 'notebook-setup') { step = 'collect'; edition = 'fabric'; }
    else if (hash === 'mini-kitchen') step = 'collect';
    else return target;
    const destination = step !== 'prepare' && !edition
      ? href('prepare', { next: step, run })
      : href(step, { edition, run });
    return new URL(destination, target);
  }
  window.AIO_SETUP_NAVIGATION = { pages, editions, href, resolveLegacy };
  if (typeof document === 'undefined') return;
  const current = new URL(location.href);
  const page = pages.find(item => current.pathname.endsWith(`/${item.file}`));
  if (!page) return;
  let target = resolveLegacy(current);
  const targetPage = pages.find(item => target.pathname.endsWith(`/${item.file}`));
  const edition = target.searchParams.get('edition');
  if (targetPage?.step !== 'prepare' && !editions.includes(edition)) {
    target = new URL(href('prepare', { next: targetPage.step, run: target.searchParams.get('collection') === 'update' ? 'update' : null }), current);
    if (edition) target.searchParams.set('invalid', 'edition');
  }
  if (target.href !== current.href) location.replace(target.href);
})();
