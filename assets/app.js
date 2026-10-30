(() => {
  'use strict';
  const content = window.AIO_CONTENT;
  const release = window.AIO_RELEASE;
  if (!content || !release) throw new Error('The website content could not be loaded. Reload this page.');
  document.documentElement.dataset.enhanced = 'true';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const announce = text => { $('#live-status').textContent = text; };
  document.addEventListener('toggle', event => {
    const panel = event.target;
    if (!(panel instanceof HTMLDetailsElement) || !panel.open) return;
    const name = panel.getAttribute('name');
    if (!name) return;
    $$('details[name]').forEach(other => {
      if (other !== panel && other.getAttribute('name') === name) other.open = false;
    });
  }, true);
  const downloadable = new Map([
    ...release.templates.filter(item => item.status === 'available'),
    ...release.downloads
  ].map(item => [item.href, item]));
  const activeDownloads = new Set();
  let toastTimer;
  function downloadMessage(message, original) {
    clearTimeout(toastTimer);
    let toast = $('#download-status');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'download-status';
      toast.className = 'site-toast';
      toast.setAttribute('role', 'status');
      const pause = () => clearTimeout(toastTimer);
      const resume = () => { toastTimer = setTimeout(() => toast.remove(), 6000); };
      toast.addEventListener('mouseenter', pause);
      toast.addEventListener('mouseleave', resume);
      toast.addEventListener('focusin', pause);
      toast.addEventListener('focusout', resume);
      document.body.append(toast);
    }
    toast.replaceChildren();
    const text = document.createElement('p');
    text.textContent = message;
    toast.append(text);
    if (original) {
      const source = document.createElement('a');
      source.href = original.href;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.dataset.downloadOriginal = 'true';
      source.textContent = 'Open the source file in a new tab';
      toast.append(source);
    }
    const close = document.createElement('button');
    close.textContent = 'Dismiss';
    close.className = 'text-button';
    close.addEventListener('click', () => { clearTimeout(toastTimer); toast.remove(); });
    toast.append(close);
    toastTimer = setTimeout(() => toast.remove(), original ? 12000 : 6000);
  }
  document.addEventListener('click', async event => {
    const anchor = event.target.closest('a[href]');
    if (!anchor || anchor.dataset.downloadOriginal || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const item = downloadable.get(anchor.href);
    if (!item) return;
    event.preventDefault();
    if (activeDownloads.has(item.href)) return;
    $('#site-search-dialog')?.close();
    activeDownloads.add(item.href);
    anchor.setAttribute('aria-busy', 'true');
    downloadMessage(`Preparing ${item.title}. Your download will start when the file is ready.`);
    try {
      const response = await fetch(item.href, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const save = document.createElement('a');
      save.href = url;
      save.download = item.file;
      document.body.append(save);
      save.click();
      save.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      downloadMessage(`Download started: ${item.title}. Check your browser's Downloads list.`);
    } catch (error) {
      downloadMessage(`We could not download ${item.title} (${error.message}). Please try again, or open the source file and use Save as.`, item);
    } finally {
      activeDownloads.delete(item.href);
      anchor.removeAttribute('aria-busy');
    }
  });

  const menu = $('#menu-toggle');
  menu?.addEventListener('click', () => {
    const expanded = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(expanded));
    menu.setAttribute('aria-label', expanded ? 'Close navigation' : 'Open navigation');
    $('#primary-nav').classList.toggle('open', expanded);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') menu.click();
  });
  const themeToggle = $('#theme-toggle');
  const themeLabel = () => themeToggle?.setAttribute('aria-label', `Switch to ${document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'} theme`);
  themeLabel();
  themeToggle?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('aio-theme', next); } catch { announce('Theme changed for this page. Your browser does not allow saving the preference.'); }
    themeLabel();
  });

  const searchDialog = $('#site-search-dialog');
  const searchToggle = $('#site-search-toggle');
  const searchInput = $('#site-search-input');
  const normalized = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const searchData = (window.AIO_SEARCH || []).map(item => ({ ...item, titleKey: normalized(item.title), textKey: normalized(item.text) }));
  function renderSearch() {
    const query = normalized(searchInput.value.trim());
    const words = query.split(/\s+/).filter(Boolean);
    if (!words.length) {
      $('#site-search-results').innerHTML = '<div class="search-suggestions"><p>Popular starting points</p><a href="downloads.html#templates">Report templates</a><a href="get-started.html">Setup guide</a><a href="downloads.html#sample-data">Sample data</a><a href="learn.html#privacy">Privacy and access</a></div>';
      $('#site-search-status').textContent = 'Search everything. Matching downloads appear first.';
      return;
    }
    const matches = searchData.filter(item => words.every(word => item.titleKey.includes(word) || item.textKey.includes(word)))
      .map(item => ({ ...item, score: (item.titleKey.includes(query) ? 80 : 0) + words.reduce((score, word) => score + (item.titleKey.includes(word) ? 20 : 1), 0) }))
      .sort((a, b) => Number(b.type === 'Download') - Number(a.type === 'Download') || b.score - a.score || a.title.localeCompare(b.title));
    const shown = matches.slice(0, 30);
    $('#site-search-status').textContent = matches.length ? `${matches.length} result${matches.length === 1 ? '' : 's'}${matches.length > shown.length ? `; showing the first ${shown.length}` : ''}. Downloads first.` : 'No results. Try a shorter word, such as "license", "sample" or "refresh".';
    $('#site-search-results').innerHTML = shown.map(item => `<a class="site-search-result" href="${e(item.href)}"><span class="search-result-type">${e(item.type)}${item.format ? ` &middot; ${e(item.format)}` : ''}</span><strong>${e(item.title)}</strong><span>${e((item.summary || '').slice(0, 180))}</span></a>`).join('');
  }
  searchToggle?.addEventListener('click', () => {
    searchDialog.showModal();
    searchToggle.setAttribute('aria-expanded', 'true');
    renderSearch();
    searchInput.focus();
  });
  $('#close-search')?.addEventListener('click', () => searchDialog.close());
  searchDialog?.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); searchDialog.close(); }
  });
  searchDialog?.addEventListener('close', () => {
    searchToggle.setAttribute('aria-expanded', 'false');
    searchToggle.focus({ preventScroll: true });
  });
  searchDialog?.addEventListener('click', event => {
    if (event.target === searchDialog) searchDialog.close();
    else if (event.target.closest('a')) searchDialog.close();
  });
  searchInput?.addEventListener('input', renderSearch);
  searchInput?.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      const first = $('#site-search-results a');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
  if (searchToggle && !searchData.length) {
    searchToggle.addEventListener('click', () => {
      $('#site-search-status').textContent = 'Search could not load. Reload this page, or use the page links below.';
    });
  }

  document.addEventListener('click', async event => {
    const copy = event.target.closest('[data-copy]');
    if (!copy) return;
    if (!navigator.clipboard?.writeText) {
      copy.textContent = 'Select and copy the text below';
      announce('Clipboard is unavailable. Select the text and copy it manually.');
      return;
    }
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      const previous = copy.textContent;
      copy.textContent = 'Copied';
      announce('Copied to clipboard.');
      setTimeout(() => { if (copy.isConnected) copy.textContent = previous; }, 1800);
    } catch {
      copy.textContent = 'Copy blocked - select the text below';
      announce('Your browser blocked clipboard access. Select the text and copy it manually.');
    }
  });

  const imageDialog = $('#image-dialog');
  document.addEventListener('click', event => {
    const zoom = event.target.closest('[data-zoom]');
    if (!zoom) return;
    $('#dialog-title').textContent = zoom.dataset.title;
    $('#dialog-image').src = zoom.dataset.zoom;
    $('#dialog-image').alt = `${zoom.dataset.title}, fictional example data`;
    imageDialog.showModal();
    document.body.classList.add('dialog-open');
  });
  $('#close-dialog')?.addEventListener('click', () => imageDialog.close());
  imageDialog?.addEventListener('click', event => { if (event.target === imageDialog) imageDialog.close(); });
  imageDialog?.addEventListener('close', () => document.body.classList.remove('dialog-open'));

  $$('[data-youtube]').forEach(container => {
    $('.video-play', container).addEventListener('click', () => {
      const frame = document.createElement('iframe');
      frame.src = container.dataset.youtube;
      frame.title = 'AI-in-One v2.0 setup walkthrough';
      frame.allow = 'encrypted-media; picture-in-picture';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      container.replaceChildren(frame);
      frame.focus();
    });
  });

  const showcase = $('[data-showcase]');
  if (showcase) {
    const tabs = $$('[role="tab"]', showcase);
    const activate = tab => {
      tabs.forEach(button => {
        const selected = button === tab;
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      });
      const panel = $('#highlight-panel');
      panel.setAttribute('aria-labelledby', tab.id);
      $('h3', panel).textContent = tab.dataset.title;
      $('p', panel).textContent = tab.dataset.description;
      $('#showcase-image').src = `assets/screenshots/${tab.dataset.image}`;
      $('#showcase-image').alt = `${tab.dataset.title} Fictional report example.`;
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab));
      tab.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next !== undefined) { event.preventDefault(); activate(tabs[next]); tabs[next].focus(); }
      });
    });
  }

  if ($('#tour-detail')) {
    let active = content.tour[0];
    const requested = () => {
      const id = location.hash.slice(1) || new URLSearchParams(location.search).get('page');
      return content.tour.find(page => page.id === id) || content.tour[0];
    };
    const render = (page, focus = false) => {
      active = page;
      $('#tour-detail').replaceChildren($(`#tour-template-${page.id}`).content.cloneNode(true));
      $$('#tour-nav a').forEach(item => {
        if (item.dataset.tour === page.id) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      });
      document.title = `${page.title} | AI-in-One v2.0`;
      if (focus) {
        const title = $('.tour-heading h2');
        title.tabIndex = -1;
        title.focus({ preventScroll: true });
        if (matchMedia('(max-width:620px)').matches) title.scrollIntoView({ block: 'start' });
      }
    };
    const navigate = page => {
      history.pushState(null, '', `explore.html#${page.id}`);
      render(page, true);
    };
    $('#tour-nav').addEventListener('click', event => {
      const anchor = event.target.closest('[data-tour]');
      if (!anchor) return;
      event.preventDefault();
      navigate(content.tour.find(page => page.id === anchor.dataset.tour));
    });
    $('#tour-detail').addEventListener('click', event => {
      if (event.target.closest('[data-tour-prev]') && active.number > 1) navigate(content.tour[active.number - 2]);
      if (event.target.closest('[data-tour-next]') && active.number < content.tour.length) navigate(content.tour[active.number]);
    });
    $('#tour-search').addEventListener('input', event => {
      const query = event.target.value.trim().toLowerCase();
      let count = 0;
      $$('#tour-nav a').forEach(anchor => {
        const page = content.tour.find(item => item.id === anchor.dataset.tour);
        anchor.hidden = !`${page.title} ${page.question} ${page.area}`.toLowerCase().includes(query);
        if (!anchor.hidden) count++;
      });
      $('#tour-empty').hidden = count !== 0;
      announce(`${count} report views match.`);
    });
    addEventListener('popstate', () => render(requested()));
    addEventListener('hashchange', () => render(requested()));
    render(requested());
  }

  if ($('#glossary-search')) {
    let category = 'All';
    const filterGlossary = () => {
      const query = $('#glossary-search').value.toLowerCase().trim();
      let count = 0;
      $$('.glossary-item').forEach(item => {
        item.hidden = !item.dataset.search.includes(query) || (category !== 'All' && item.dataset.category !== category);
        if (!item.hidden) count++;
      });
      $$('[data-glossary-group]').forEach(group => { group.hidden = !$('.glossary-item:not([hidden])', group); });
      $('#glossary-empty').hidden = count > 0;
      $('#glossary-count').textContent = `${count} definition${count === 1 ? '' : 's'}`;
      announce(`${count} definitions match.`);
    };
    $('#glossary-search').addEventListener('input', filterGlossary);
    $$('[data-glossary-category]').forEach(button => button.addEventListener('click', () => {
      category = button.dataset.glossaryCategory;
      $$('[data-glossary-category]').forEach(item => {
        item.classList.toggle('active', item === button);
        item.setAttribute('aria-pressed', String(item === button));
      });
      filterGlossary();
    }));
  }
  if ($('#download-search')) {
    $('#download-search').addEventListener('input', event => {
      const query = event.target.value.toLowerCase().trim();
      let count = 0;
      $$('.resource-row').forEach(item => { item.hidden = !item.dataset.search.includes(query); if (!item.hidden) count++; });
      $$('[data-download-group]').forEach(group => { group.hidden = !$('.resource-row:not([hidden])', group); });
      $('#downloads-empty').hidden = count > 0;
      announce(`${count} downloads match.`);
    });
  }
  if ($('#help-search')) {
    let category = 'Setup';
    const filterHelp = () => {
      const query = $('#help-search').value.toLowerCase().trim();
      let count = 0;
      $$('.faq').forEach(item => {
        item.hidden = !item.dataset.search.includes(query) || (!query && category !== 'All' && item.dataset.category !== category);
        if (!item.hidden) count++;
      });
      $$('[data-help-topic]').forEach(topic => { topic.hidden = !$('.faq:not([hidden])', topic); });
      $$('[data-help-category]').forEach(button => {
        const selected = button.dataset.helpCategory === (query ? 'All' : category);
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      $('#help-empty').hidden = count > 0;
      $('#help-results-status').textContent = query ? `${count} answer${count === 1 ? '' : 's'} across all topics` : `${count} answer${count === 1 ? '' : 's'} in ${category === 'All' ? 'all topics' : $(`[data-help-category="${category}"] span`).textContent.toLowerCase()}`;
    };
    $('#help-search').addEventListener('input', filterHelp);
    $$('[data-help-category]').forEach(button => button.addEventListener('click', () => {
      category = button.dataset.helpCategory;
      $('#help-search').value = '';
      filterHelp();
    }));
    filterHelp();
  }

  function revealAnchor() {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); }
    catch (error) { if (!(error instanceof URIError)) throw error; announce('This section address is invalid. Use the page navigation to find it.'); return; }
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    const helpTopic = target.closest('[data-help-topic]');
    if (helpTopic) {
      const categoryButton = $$('[data-help-category]').find(button => button.dataset.helpCategory === helpTopic.dataset.helpTopic);
      categoryButton?.click();
    }
    for (let ancestor = target; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      ancestor.hidden = false;
      if (ancestor.tagName === 'DETAILS') ancestor.open = true;
    }
    requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }
  if (document.documentElement.dataset.page === 'get-started' && !location.hash) {
    const edition = new URLSearchParams(location.search).get('edition');
    if (['sample', 'sharepoint', 'local', 'fabric', 'pax-fabric'].includes(edition)) history.replaceState(null, '', `get-started.html#${edition}`);
  }
  addEventListener('hashchange', revealAnchor);
  revealAnchor();
})();
