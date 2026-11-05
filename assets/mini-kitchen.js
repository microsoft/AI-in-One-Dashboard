(() => {
  'use strict';
  const root = document.querySelector('[data-mini-kitchen]');
  if (!root) return;
  const $ = selector => root.querySelector(selector);
  const contract = window.AIO_KITCHEN_CONTRACT;
  const guide = window.AIO_SETUP;
  if (!contract || !guide) throw new Error('The guided Mini-Kitchen connection could not load.');
  const destination = $('#kitchen-destination');
  const run = $('#kitchen-run');
  const inputs = [...run.querySelectorAll('input[type="radio"]')];
  const collectionType = () => inputs.find(input => input.checked)?.value ?? null;
  const nativeScreens = new Map([...root.querySelectorAll('[data-setup-native]')].map(node => [node.dataset.setupNative, node]));
  const editionInputs = [...root.querySelectorAll('[data-kitchen-edition]')];
  const selectedEdition = () => editionInputs.find(input => input.checked)?.value ?? null;
  const paxSelected = () => ['local', 'sharepoint', 'pax-fabric'].includes(selectedEdition());
  const configure = $('#kitchen-configure');
  const status = $('#kitchen-status');
  const dialog = $('#kitchen-builder');
  const discard = $('#kitchen-discard');
  const finish = $('#kitchen-finish');
  const finishStatus = $('#kitchen-finish-status');
  const finishCopy = $('#kitchen-finish-copy');
  const finishSave = $('#kitchen-finish-save');
  const quickCopy = $('#kitchen-copy-command');
  const viewport = $('#kitchen-viewport');
  const loading = $('#kitchen-loading');
  const modalStatus = $('#kitchen-modal-status');
  const back = $('#kitchen-back');
  const next = $('#kitchen-next');
  const nextReason = $('#kitchen-next-reason');
  const full = $('#kitchen-open-full');
  const saveOption = $('.kitchen-save-option');
  const retryConnection = $('#kitchen-retry-connection');
  const discardConnection = $('#kitchen-discard-connection');
  const discardRetry = $('#kitchen-discard-retry');
  const saveBeforeClose = $('#kitchen-save-before-close');
  const discardStatus = $('#kitchen-discard-status');
  const commandWarning = $('#kitchen-command-warning');
  const commandPreview = $('#kitchen-command-preview');
  const commandPreviewText = $('#kitchen-command-preview-text');
  const commandPreviewStatus = $('#kitchen-command-preview-status');
  const readyShortcut = $('#kitchen-ready-shortcut');
  const readyData = $('#kitchen-ready-data');
  const editions = { local: 'local', sharepoint: 'sharepoint', 'fabric-tables': 'pax-fabric' };
  const productionUrl = 'https://microsoft.github.io/PAX-Cookbook/mini-kitchen/';
  const developmentUrl = 'http://127.0.0.1:5173/PAX-Cookbook/mini-kitchen/';
  const development = ['http://127.0.0.1:8147', 'http://127.0.0.1:5174'].includes(location.origin);
  const source = development && root.dataset.miniKitchenSrc === productionUrl
    ? developmentUrl : root.dataset.miniKitchenSrc;
  if (source !== productionUrl && !(development && source === developmentUrl)) throw new Error('Unsupported Mini-Kitchen address.');
  const childUrl = new URL(source);
  let iframe = null, sessionId = null, activeContext = null, initialized = false;
  let screen = null, connectionTimer = null, navigationTimer = null, navigationFailed = false, handoff = null;
  let screenValidationBlocked = false;
  let mode = 'choices', childVisited = false, changePending = false, buildIncluded = true;
  let visitedSteps = new Set(['choices']), retainedVisited = null, pendingStep = null;
  let childCapabilities = new Set(), commandReviewReached = false, commandRequest = null, commandAction = null;
  let previewReceived = false;
  const context = () => ({
    destination: destination.value, run: collectionType() || 'initial',
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  });
  const sameContext = value => activeContext && value.destination === activeContext.destination &&
    value.run === activeContext.run && value.theme === activeContext.theme;
  const sameChoices = () => activeContext && paxSelected() &&
    activeContext.destination === context().destination && activeContext.run === context().run;
  const validChoices = () => Boolean(selectedEdition());
  const validCollection = () => paxSelected() ? Boolean(collectionType()) && contract.context(context()) : validChoices();
  const canConnectReadyData = () => paxSelected() && guide.getRoute(selectedEdition()).available;
  const canTransfer = () => initialized && !handoff && sameChoices();
  const hasReviewedCommand = () => commandReviewReached && initialized && buildIncluded && sameChoices();
  const lock = () => document.body.classList.toggle('dialog-open', Boolean(document.querySelector('dialog[open]')));
  const setStatus = text => { status.textContent = text; };
  function send(type, payload, ports = []) {
    if (!iframe || !sessionId) return false;
    iframe.contentWindow.postMessage({
      type: contract.prefix + type, version: contract.version, sessionId, payload
    }, childUrl.origin, ports);
    return true;
  }
  function finishHandoff(text) {
    if (handoff) {
      clearTimeout(handoff.timer);
      send('handoff-cancel', { handoffId: handoff.id });
      handoff.channel?.port1.close();
      handoff.channel?.port2.close();
      handoff = null;
    }
    modalStatus.textContent = text;
    discardStatus.textContent = text;
    renderHandoffControls();
  }
  function renderHandoffControls() {
    const transferable = canTransfer() || (changePending && initialized && !handoff);
    const relevant = paxSelected() && (initialized || (validCollection() && buildIncluded));
    const retry = relevant && navigationFailed && !initialized;
    saveOption.hidden = mode === 'choices' || !relevant;
    full.hidden = !transferable && !handoff;
    full.disabled = Boolean(handoff);
    $('#kitchen-handoff-why').hidden = !transferable && !handoff;
    retryConnection.hidden = !retry;
    const message = retry ? 'Mini-Kitchen could not connect. Your selections are still here.'
      : handoff ? 'Transferring your choices…' : relevant && !transferable ? 'Preparing your choices…' : '';
    $('#kitchen-handoff-requirement').textContent = message;
    $('#kitchen-handoff-requirement').hidden = !message;
    saveBeforeClose.hidden = !transferable && !handoff;
    saveBeforeClose.disabled = Boolean(handoff);
    discardConnection.textContent = message;
    discardConnection.hidden = !message;
    discardRetry.hidden = !retry;
    discard.querySelector('.kitchen-discard-save').hidden = changePending || !relevant;
    discard.toggleAttribute('data-choice-change', changePending);
    $('#kitchen-keep-building').classList.toggle('button-primary', !changePending);
    $('#kitchen-keep-building').classList.toggle('button-secondary', changePending);
    $('#kitchen-confirm-discard').className = changePending ? 'button button-primary' : 'text-button kitchen-discard-button';
  }
  function renderCommandControls() {
    quickCopy.hidden = !hasReviewedCommand();
    quickCopy.disabled = Boolean(commandAction || navigationTimer || handoff);
    finishCopy.disabled = finishSave.disabled = Boolean(commandAction) || !hasReviewedCommand() ||
      !childCapabilities.has('command-export');
  }
  function renderCommandPreview() {
    commandPreview.hidden = mode === 'choices' || !paxSelected() || !buildIncluded;
    if (!commandPreview.hidden && activeContext && !sameChoices()) {
      commandPreviewText.textContent = '';
      commandPreviewStatus.textContent = 'Apply your changed edition or collection choice to build its command.';
      return;
    }
    if (!commandPreview.hidden && !commandPreviewText.textContent && !previewReceived) {
      commandPreviewStatus.textContent = 'Preparing your storage-specific command preview…';
    }
  }
  function requestCommand() {
    if (!hasReviewedCommand()) return Promise.reject(new Error('Complete your PAX command before copying or saving it.'));
    if (!childCapabilities.has('command-export')) return Promise.reject(new Error('Mini-Kitchen needs an update for this action. Return to your command to copy it.'));
    if (commandRequest) return Promise.reject(new Error('A command request is already in progress.'));
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const requestId = crypto.randomUUID();
      const owner = sessionId;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        channel.port1.onmessage = channel.port1.onmessageerror = null;
        channel.port1.close();
        channel.port2.close();
        if (commandRequest === request) commandRequest = null;
      };
      const request = { cancel: error => { cleanup(); reject(error); } };
      commandRequest = request;
      channel.port1.onmessage = event => {
        const reply = contract.parseCommandResult(event.data, owner, requestId);
        if (!reply || event.ports.length) {
          event.ports.forEach(port => port.close());
          request.cancel(new Error('Mini-Kitchen returned an invalid command response. Nothing was copied or saved.'));
        } else if (reply.type === contract.prefix + 'command-unavailable') {
          request.cancel(new Error('Your command is not ready. Return to your command and complete the required details.'));
        } else {
          cleanup();
          resolve(reply.payload.command);
        }
      };
      channel.port1.onmessageerror = () => request.cancel(new Error('The command could not be received. Please try again.'));
      timer = setTimeout(() => request.cancel(new Error('Mini-Kitchen did not return your command. Please try again.')), 10000);
      try {
        if (!send('command-request', { requestId }, [channel.port2])) {
          request.cancel(new Error('Mini-Kitchen is not connected. Reopen your command and try again.'));
        }
      } catch {
        request.cancel(new Error('The command request could not be sent. Please try again.'));
      }
    });
  }
  async function copyCommand(command) {
    if (!navigator.clipboard) throw new Error('Clipboard access is unavailable. Save your command as a text file instead.');
    // Start the clipboard write during the click, before the private port reply arrives.
    if (typeof ClipboardItem === 'function' && typeof navigator.clipboard.write === 'function') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': command.then(text => new Blob([text], { type: 'text/plain' }))
      })]);
    } else {
      if (typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard access is unavailable. Save your command as a text file instead.');
      await navigator.clipboard.writeText(await command);
    }
  }
  function saveCommand(command) {
    const url = URL.createObjectURL(new Blob([command], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `PAX-Prompt-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.append(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  async function commandActionFromClick(action, returnToReview = false) {
    if (commandAction) return;
    const operation = { sessionId };
    const statusNode = finish.open ? finishStatus : modalStatus;
    commandAction = operation;
    statusNode.textContent = action === 'copy' ? 'Copying your command...' : 'Preparing your text file...';
    renderScreen();
    const command = requestCommand();
    const completion = action === 'copy'
      ? Promise.all([command, copyCommand(command)])
      : command.then(text => {
        if (commandAction !== operation || sessionId !== operation.sessionId) throw new Error('Setup changed. Nothing was saved.');
        saveCommand(text);
      });
    if (returnToReview && hasReviewedCommand()) enterChild('review');
    try {
      await completion;
      if (commandAction === operation && dialog.open) {
        statusNode.textContent = action === 'copy' ? 'PAX command copied.' : 'Text file download started.';
      }
    } catch (error) {
      commandRequest?.cancel(new Error('The command action was cancelled.'));
      if (commandAction === operation && dialog.open) {
        statusNode.textContent = error instanceof DOMException
          ? 'Your browser blocked this action. Copy from your command or save a text file instead.'
          : error.message;
      }
    } finally {
      if (commandAction === operation) {
        commandAction = null;
        renderScreen();
      }
    }
  }
  function renderScreen() {
    dialog.dataset.kitchenStage = mode;
    const native = mode !== 'child';
    const sequence = journey();
    const currentId = mode !== 'child' ? mode : screen?.id || contract.screens[0].id;
    const index = sequence.findIndex(item => item.id === currentId);
    if (dialog.open && (native || screen)) visitedSteps.add(currentId);
    const firstUnvisited = sequence.find(item => !visitedSteps.has(item.id))?.id;
    if (index < 0) throw new Error('Unsupported setup screen.');
    nativeScreens.forEach((node, id) => { node.hidden = mode !== id; });
    root.querySelectorAll('[data-setup-editions]').forEach(node => {
      node.hidden = !node.dataset.setupEditions.split(' ').includes(selectedEdition());
    });
    root.querySelectorAll('[data-setup-mode]').forEach(node => {
      node.hidden = node.dataset.setupMode !== (collectionType() === 'update' && paxSelected() ? 'update' : 'initial');
    });
    viewport.hidden = native || !initialized || !screen;
    loading.hidden = native || Boolean(initialized && screen);
    back.disabled = mode === 'choices' || Boolean(commandAction || navigationTimer) || (mode === 'child' && !initialized && !navigationFailed);
    next.disabled = Boolean(commandAction) || (mode === 'choices' ? !validChoices() : mode === 'prepare' ? !validCollection() :
      mode === 'open' || mode === 'share' ? !guide.getRoute(selectedEdition()).available :
        !initialized || !screen || (screen.id === 'review' ? !screen.commandReady : !screen.canNext) || screenValidationBlocked || Boolean(navigationTimer) || navigationFailed);
    next.textContent = mode === 'open' ? 'Finish setup' : 'Next';
    readyShortcut.hidden = mode !== 'prepare' || !paxSelected() || !guide.getRoute(selectedEdition()).available;
    readyData.disabled = !canConnectReadyData();
    renderHandoffControls();
    renderCommandControls();
    renderCommandPreview();
    $('#kitchen-screen-title').textContent = sequence[index]?.title || 'Opening your builder';
    $('#kitchen-progress').textContent = `Step ${index + 1} of ${sequence.length} · ${sequence[index].title}`;
    $('#kitchen-steps').replaceChildren(...sequence.map((item, itemIndex) => {
      const node = document.createElement('li');
      node.dataset.kitchenScreen = item.id;
      const reachable = itemIndex < index || visitedSteps.has(item.id) || item.id === firstUnvisited;
      const control = document.createElement(reachable && item.id !== currentId && !navigationTimer && !commandAction ? 'a' : 'span');
      control.textContent = String(itemIndex + 1);
      control.setAttribute('aria-label', `Step ${itemIndex + 1}: ${item.title}`);
      if (control.tagName === 'A') {
        control.href = `#kitchen-${nativeScreens.has(item.id) ? item.id : 'viewport'}`;
        control.dataset.kitchenTarget = item.id;
      }
      node.toggleAttribute('data-complete', visitedSteps.has(item.id) && item.id !== currentId);
      if (item.id === currentId) control.setAttribute('aria-current', 'step');
      node.append(control);
      return node;
    }));
    nextReason.textContent = mode === 'choices'
      ? validChoices() ? guide.getRoute(selectedEdition()).label : 'Choose an edition.'
      : mode === 'prepare' ? paxSelected() && !validCollection() ? 'Choose a collection type, or connect prepared data.' : ''
      : mode === 'open' || mode === 'share' ? ''
      : !screen ? 'Connecting the guided screens for your collection.' :
      screen.id === 'review' ? screen.commandReady
        ? ''
        : 'Complete the missing details before copying your command.' :
      screen.canNext ? '' : 'Complete the required fields.';
    if (mode === 'child' && screenValidationBlocked) {
      nextReason.textContent = 'Check the highlighted fields on this screen before continuing.';
    }
    const informational = mode === 'open' || (mode === 'prepare' && !paxSelected());
    nextReason.toggleAttribute('data-informational', informational && !next.disabled);
    if (informational && !next.disabled) {
      nextReason.textContent = mode === 'open'
        ? 'Information only. Click Finish setup when you are done.'
        : 'Information only. Click Next to continue.';
    }
    commandWarning.hidden = mode !== 'child' || screen?.id !== 'review';
    $('#kitchen-modal-context').textContent = selectedEdition()
      ? `${guide.getRoute(selectedEdition()).label}${paxSelected() && collectionType() ? ` · ${collectionType() === 'initial' ? 'First collection (seed)' : 'Update existing history (append)'}` : ''}`
      : '';
    $('#kitchen-open-title').textContent = collectionType() === 'update' && paxSelected() ? 'Refresh and share' : 'Connect and share';
    root.querySelectorAll('a[href*="setup-reference.html#it-request"], a[data-it-request-link]').forEach(link => {
      link.dataset.itRequestLink = '';
      link.href = `setup-reference.html${selectedEdition() && selectedEdition() !== 'sample' ? `?edition=${encodeURIComponent(selectedEdition())}` : ''}#it-request`;
    });
  }
  function journey() {
    return [
      { id: 'choices', title: 'Choose your edition' }, { id: 'prepare', title: paxSelected() ? 'First collection or update' : 'Prepare data' },
      ...(paxSelected() && buildIncluded ? contract.screens : []),
      { id: 'open', title: collectionType() === 'update' ? 'Refresh and share' : 'Connect and share' }
    ];
  }
  function invalidateJourney() {
    if (childVisited && !retainedVisited) retainedVisited = new Set(visitedSteps);
    visitedSteps = new Set(['choices', 'prepare']);
    pendingStep = null;
  }
  function goToStep(target) {
    if (navigationTimer) return;
    const sequence = journey();
    const current = mode === 'child' ? screen?.id || contract.screens[0].id : mode;
    const currentIndex = sequence.findIndex(item => item.id === current);
    const targetIndex = sequence.findIndex(item => item.id === target);
    const firstUnvisited = sequence.find(item => !visitedSteps.has(item.id))?.id;
    if (targetIndex < 0 || target === current ||
      !(targetIndex < currentIndex || visitedSteps.has(target) || target === firstUnvisited)) return;
    if (target === 'choices') { showNative(target); return; }
    if (!validChoices()) { modalStatus.textContent = 'Choose an edition first.'; return; }
    if (target === 'prepare') { commitChoices(); showNative(target); return; }
    if (contract.screens.some(item => item.id === target)) {
      if (!validCollection()) {
        showNative('prepare');
        modalStatus.textContent = 'Choose a collection type first.';
        return;
      }
      if (childVisited && !sameChoices()) { requestChangedChoices(); return; }
      enterChild(target);
      return;
    }
    if (!visitedSteps.has(target) && mode === 'child' && !screen?.commandReady) {
      modalStatus.textContent = 'Complete the command before opening the report connection.';
      return;
    }
    if (!visitedSteps.has(target) && target === 'open' && mode === 'prepare' && paxSelected()) return;
    commitChoices();
    showNative(target);
  }
  $('#kitchen-steps').addEventListener('click', event => {
    const link = event.target.closest('[data-kitchen-target]');
    if (!link) return;
    event.preventDefault();
    goToStep(link.dataset.kitchenTarget);
  });
  function unavailable(text) {
    clearTimeout(connectionTimer);
    clearTimeout(navigationTimer);
    connectionTimer = navigationTimer = null;
    if (initialized) {
      navigationFailed = true;
      modalStatus.textContent = text + ' Your choices are still here.';
      discardStatus.textContent = modalStatus.textContent;
      renderScreen();
      return;
    }
    screen = activeContext = sessionId = null;
    navigationFailed = true;
    iframe?.remove();
    iframe = null;
    viewport.hidden = true;
    loading.hidden = false;
    loading.textContent = text;
    finishHandoff(text);
    renderScreen();
  }
  function resetChild() {
    commandRequest?.cancel(new Error('Setup closed or changed. The command request was cancelled.'));
    commandAction = null;
    childCapabilities = new Set();
    commandPreviewText.textContent = '';
    commandPreviewStatus.textContent = '';
    previewReceived = false;
    commandReviewReached = false;
    clearTimeout(connectionTimer);
    clearTimeout(navigationTimer);
    finishHandoff('');
    connectionTimer = navigationTimer = null;
    initialized = false;
    screenValidationBlocked = false;
    screen = activeContext = sessionId = null;
    navigationFailed = false;
    iframe?.remove();
    iframe = null;
    viewport.replaceChildren();
  }
  function closeBuilder() {
    resetChild();
    mode = 'choices';
    childVisited = changePending = false;
    visitedSteps = new Set(['choices']);
    retainedVisited = pendingStep = null;
    if (finish.open) finish.close();
    if (discard.open) discard.close();
    if (dialog.open) dialog.close();
    configure.setAttribute('aria-expanded', 'false');
    lock();
    setStatus('Setup closed. Your choices were cleared; any copied command remains on your clipboard.');
    configure.focus({ preventScroll: true });
  }
  function requestClose() {
    if (!dialog.open || discard.open || finish.open) return;
    changePending = false;
    const finished = mode === 'open';
    $('#kitchen-confirm-discard').textContent = finished ? 'Finish and close' : 'Discard and close';
    const ready = mode === 'child' && Boolean(screen?.commandReady);
    $('#kitchen-discard-title').textContent = finished ? 'Finish setup?' : ready ? 'Have you copied your command?' : 'Keep your setup?';
    $('#kitchen-discard-message').textContent = ready
      ? 'Copy your command before closing. Closing clears your choices and command; a copied command stays on your clipboard.'
      : 'Closing clears your choices and any command. A copied command stays on your clipboard.';
    $('#kitchen-keep-building').textContent = ready ? 'Back to my command' : 'Keep working here';
    discardStatus.textContent = modalStatus.textContent;
    renderHandoffControls();
    discard.showModal();
    lock();
    $('#kitchen-keep-building').focus({ preventScroll: true });
  }
  function finishSetup() {
    if (!dialog.open || finish.open || discard.open) return;
    const command = hasReviewedCommand();
    $('#kitchen-finish-title').textContent = command ? 'Keep your PAX command' : 'Finish setup';
    $('#kitchen-finish-message').textContent = command
      ? 'Copy your command or save a text file before closing. Closing clears your setup.'
      : 'You have reached the end of the guide. Close to leave this setup.';
    finish.querySelector('.kitchen-finish-actions').hidden = !command;
    finishStatus.textContent = command && !childCapabilities.has('command-export')
      ? 'Mini-Kitchen needs an update for these actions. Your command is still available in the guide.'
      : '';
    renderCommandControls();
    finish.showModal();
    lock();
    $('#kitchen-finish-close').focus({ preventScroll: true });
  }
  function startChild() {
    resetChild();
    activeContext = context();
    modalStatus.textContent = '';
    discardStatus.textContent = '';
    screen = null;
    viewport.hidden = true;
    loading.hidden = false;
    loading.textContent = 'Opening Mini-Kitchen…';
    // A legacy embed is never initialized or displayed; it is not the guided experience.
    const url = new URL(childUrl);
    url.search = new URLSearchParams({ embed: 'aio', view: 'guided', ...activeContext }).toString();
    iframe = document.createElement('iframe');
    iframe.title = 'Mini-Kitchen: current PAX command builder step';
    iframe.allow = 'clipboard-write';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.src = url.href;
    viewport.append(iframe);
    connectionTimer = setTimeout(() => unavailable(
      'Mini-Kitchen could not connect. Retry the connection; your selections are still here.'
    ), 15000);
    renderScreen();
  }
  function showNative(id) {
    if (!nativeScreens.has(id)) throw new Error('Unsupported setup stage.');
    clearHandoffReceipt();
    mode = id;
    renderScreen();
    const node = nativeScreens.get(id);
    node.scrollTop = 0;
    $(`#kitchen-${id}-title`).focus({ preventScroll: true });
    if (id === 'prepare' && paxSelected() && !iframe) startChild();
  }
  function commitChoices() {
    guide.setBuilderSelection(selectedEdition(), paxSelected() ? collectionType() : null);
  }
  function enterChild(target = null) {
    buildIncluded = true;
    commitChoices();
    if (!sameChoices()) startChild();
    childVisited = true;
    mode = 'child';
    renderScreen();
    if (target && screen?.id !== target) {
      if (initialized && screen) navigateTo(target);
      else pendingStep = target;
    }
    iframe?.focus({ preventScroll: true });
  }
  function requestChangedChoices() {
    changePending = true;
    const collection = collectionType() === 'initial' ? 'first collection (seed)' : 'update existing history (append)';
    $('#kitchen-discard-title').textContent = 'Apply your new setup choices?';
    $('#kitchen-discard-message').textContent = `You selected ${guide.getRoute(selectedEdition()).label}: ${collection}. Applying these changes starts a new command and clears your current builder entries. Keep your current setup to leave it unchanged. A copied command stays on your clipboard.`;
    $('#kitchen-keep-building').textContent = 'Keep my current setup';
    $('#kitchen-confirm-discard').textContent = 'Apply changes and start again';
    renderHandoffControls();
    discardStatus.textContent = '';
    discard.showModal();
    discard.scrollTop = 0;
    lock();
    $('#kitchen-keep-building').focus({ preventScroll: true });
  }
  configure.addEventListener('click', () => {
    syncGuide(guide.getState());
    mode = 'choices';
    childVisited = changePending = false;
    visitedSteps = new Set(['choices']);
    retainedVisited = pendingStep = null;
    buildIncluded = paxSelected();
    modalStatus.textContent = discardStatus.textContent = '';
    dialog.showModal();
    lock();
    configure.setAttribute('aria-expanded', 'true');
    renderScreen();
    $('#kitchen-choices-title').focus({ preventScroll: true });
  });
  back.addEventListener('click', () => {
    if (mode === 'prepare') showNative('choices');
    else if (mode === 'open') {
      if (paxSelected() && buildIncluded && initialized) {
        mode = 'child';
        renderScreen();
        iframe?.focus({ preventScroll: true });
      } else showNative('prepare');
    } else if (mode === 'child' && (screen?.id === contract.screens[0].id || navigationFailed)) showNative('prepare');
    else if (mode === 'child') navigate('back');
  });
  next.addEventListener('click', () => {
    if (mode === 'choices') {
      if (!validChoices()) return;
      commitChoices();
      showNative('prepare');
    } else if (mode === 'prepare') {
      if (!validCollection()) return;
      if (paxSelected()) {
        if (childVisited && !sameChoices()) requestChangedChoices();
        else enterChild();
      } else { commitChoices(); showNative('open'); }
    } else if (mode === 'child' && screen?.id === 'review') {
      if (screen.commandReady) showNative('open');
    } else if (mode === 'child') navigate('next');
    else if (mode === 'open') finishSetup();
  });
  quickCopy.addEventListener('click', () => commandActionFromClick('copy', true));
  finishCopy.addEventListener('click', () => commandActionFromClick('copy'));
  finishSave.addEventListener('click', () => commandActionFromClick('save'));
  finish.addEventListener('cancel', event => event.preventDefault());
  finish.addEventListener('close', lock);
  for (const button of [$('#kitchen-finish-x'), $('#kitchen-finish-close')]) {
    button.addEventListener('click', closeBuilder);
  }
  readyData.addEventListener('click', () => {
    if (!canConnectReadyData()) return;
    if (!childVisited) resetChild();
    commitChoices();
    buildIncluded = false;
    showNative('open');
  });
  function navigate(direction) {
    if (!initialized || navigationTimer || !screen || (direction === 'next' && !screen.canNext)) return;
    clearHandoffReceipt();
    navigationTimer = setTimeout(() => unavailable(
      'The builder did not respond to the step change. Close and reopen it, or use the separate Mini-Kitchen website.'
    ), 15000);
    send('screen-request', { direction });
    renderScreen();
  }
  function navigateTo(target) {
    if (!initialized || navigationTimer || !screen) return;
    clearHandoffReceipt();
    navigationTimer = setTimeout(() => unavailable('The step could not open. Your entries are still here.'), 15000);
    send('screen-request', { target });
    renderScreen();
  }
  function clearHandoffReceipt() {
    if (modalStatus.textContent.startsWith('Your choices are ready in the new tab.')) modalStatus.textContent = '';
  }
  $('#kitchen-close').addEventListener('click', requestClose);
  $('#kitchen-confirm-discard').addEventListener('click', () => {
    if (!changePending) { closeBuilder(); return; }
    changePending = false;
    retainedVisited = null;
    discard.close();
    lock();
    enterChild();
  });
  $('#kitchen-keep-building').addEventListener('click', () => {
    const keepCurrentSetup = changePending;
    if (changePending) {
      changePending = false;
      if (retainedVisited) visitedSteps = retainedVisited;
      retainedVisited = null;
      const currentEdition = editions[activeContext.destination];
      editionInputs.forEach(input => { input.checked = input.value === currentEdition; });
      inputs.forEach(input => { input.checked = input.value === activeContext.run; });
      destination.value = activeContext.destination;
      commitChoices();
      renderChoices();
    }
    discard.close();
    lock();
    if (keepCurrentSetup) enterChild();
    else if (mode !== 'child') $(`#kitchen-${mode}-title`).focus({ preventScroll: true });
    else iframe?.focus({ preventScroll: true });
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  discard.addEventListener('cancel', event => {
    event.preventDefault();
    $('#kitchen-keep-building').click();
  });
  dialog.addEventListener('close', () => { if (!dialog.open && configure.getAttribute('aria-expanded') === 'true') closeBuilder(); else lock(); });
  discard.addEventListener('close', lock);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) requestClose();
  });
  window.addEventListener('beforeunload', event => {
    if (!dialog.open) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('pagehide', () => { if (dialog.open) closeBuilder(); });
  function openFullKitchen() {
    if (!initialized || handoff || (!changePending && !canTransfer())) return;
    const id = crypto.randomUUID();
    const url = new URL(childUrl);
    url.search = new URLSearchParams({ handoff: 'aio', handoffId: id }).toString();
    // The opener is retained only for a bounded, origin/source-checked handshake.
    const popup = window.open(url.href, '_blank');
    if (!popup) {
      modalStatus.textContent = discardStatus.textContent =
        'Your browser blocked the new tab. Allow pop-ups for this site, then try again. Your choices are still here.';
      return;
    }
    handoff = {
      id, popup, channel: null,
      timer: setTimeout(() => finishHandoff('Mini-Kitchen did not confirm receiving your entries. Keep this builder open; no successful transfer has been confirmed.'), 20000)
    };
    modalStatus.textContent = discardStatus.textContent = 'Opening full Mini-Kitchen with your current choices...';
    renderScreen();
  }
  full.addEventListener('click', openFullKitchen);
  saveBeforeClose.addEventListener('click', openFullKitchen);
  for (const button of [retryConnection, discardRetry]) button.addEventListener('click', () => {
    if (!paxSelected() || initialized) return;
    startChild();
  });
  window.addEventListener('message', event => {
    if (!dialog.open || event.origin !== childUrl.origin) return;
    const data = contract.parse(event.data);
    if (handoff && event.source === handoff.popup) {
      if (!data || data.sessionId !== handoff.id) return;
      if (data.type === contract.prefix + 'handoff-ready' && !handoff.channel) {
        const channel = new MessageChannel();
        handoff.channel = channel;
        send('handoff-connect', { handoffId: handoff.id }, [channel.port1]);
        handoff.popup.postMessage({
          type: contract.prefix + 'handoff-connect', version: contract.version,
          sessionId: handoff.id, payload: { handoffId: handoff.id }
        }, childUrl.origin, [channel.port2]);
      } else if (data.type === contract.prefix + 'handoff-complete' && handoff.channel) {
        finishHandoff('Your choices are ready in the new tab. Save a recipe there to keep them.');
      } else if (data.type === contract.prefix + 'handoff-failed') {
        finishHandoff('Mini-Kitchen could not apply your entries. Keep this builder open and try again; your current settings have not changed.');
      }
      return;
    }
    if (!iframe || event.source !== iframe.contentWindow) return;
    if (!data) {
      if (event.data?.type === contract.prefix + 'ready' && [1, 2].includes(event.data.version)) {
        unavailable('This Mini-Kitchen version still uses the old stacked builder. The guided-screen update is required; the old interface will not be shown here.');
      } else if (event.data?.type === contract.prefix + 'ready' && event.data.version === contract.version &&
        Array.isArray(event.data.payload?.capabilities) &&
        !contract.capabilities.every(name => event.data.payload.capabilities.includes(name))) {
        unavailable('Mini-Kitchen needs an update to support this guide. Refresh the pages or retry after it is updated.');
      }
      return;
    }
    if (data.type === contract.prefix + 'ready') {
      if (initialized || !sameContext(data.payload.context) || sessionId) return;
      childCapabilities = new Set(data.payload.capabilities);
      sessionId = data.sessionId;
      send('initialize', { context: activeContext, compact: true });
      return;
    }
    if (data.sessionId !== sessionId) return;
    if (data.type === contract.prefix + 'initialized' && sameContext(data.payload.context)) {
      initialized = true;
      renderScreen();
    } else if (data.type === contract.prefix + 'screen-changed' && initialized) {
      clearTimeout(connectionTimer);
      clearTimeout(navigationTimer);
      connectionTimer = navigationTimer = null;
      navigationFailed = false;
      if (screen?.id !== data.payload.screen.id || data.payload.screen.canNext || data.payload.screen.commandReady) screenValidationBlocked = false;
      screen = data.payload.screen;
      if (screen.id === 'review' && screen.commandReady) commandReviewReached = true;
      loading.hidden = true;
      renderScreen();
      if (pendingStep) {
        const target = pendingStep;
        pendingStep = null;
        if (screen.id !== target) navigateTo(target);
      }
    } else if (data.type === contract.prefix + 'command-preview' && initialized && sameChoices()) {
      previewReceived = true;
      commandPreviewText.textContent = data.payload.command;
      commandPreviewStatus.textContent = !data.payload.command.trim()
        ? 'Preview unavailable. Correct the flagged fields before continuing.'
        : data.payload.ready
        ? 'Complete command · review before running'
        : 'Live preview · replace placeholders and complete the remaining details';
      renderCommandPreview();
    } else if (data.type === contract.prefix + 'close-request') requestClose();
    else if (data.type === contract.prefix + 'error') {
      if (data.payload.code === 'screen-blocked') {
        clearTimeout(navigationTimer);
        navigationTimer = null;
        screenValidationBlocked = true;
        renderScreen();
      } else if (data.payload.code === 'handoff-failed') {
        finishHandoff('Mini-Kitchen could not apply your choices. Keep this builder open and try again; your current settings have not changed.');
      } else unavailable('The guided builder could not complete that request. Close and reopen it, or use the separate Mini-Kitchen website.');
    }
  });
  new MutationObserver(() => {
    if (!initialized) return;
    activeContext.theme = context().theme;
    send('theme', { theme: activeContext.theme });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  run.addEventListener('click', event => {
    const option = event.target.closest('.kitchen-collection-option');
    if (option && !event.target.closest('button, input, label, a')) {
      const input = option.querySelector('input[type="radio"]');
      input.focus({ preventScroll: true });
      input.click();
    }
  });
  run.addEventListener('change', event => {
    if (event.target.matches('input[name="kitchen-run"]')) { invalidateJourney(); renderChoices(); }
  });
  editionInputs.forEach(input => input.addEventListener('change', () => {
    invalidateJourney();
    inputs.forEach(option => { option.checked = false; });
    renderChoices();
  }));
  function renderChoices() {
    destination.value = Object.keys(editions).find(key => editions[key] === selectedEdition()) || '';
    buildIncluded = paxSelected();
    if (!childVisited) {
      if (!contract.context(context())) {
        if (iframe) resetChild();
      } else if (!sameChoices() && dialog.open && mode !== 'choices') startChild();
    }
    renderScreen();
  }
  function syncGuide(state) {
    if (dialog.open) { renderScreen(); return; }
    const target = Object.keys(editions).find(key => editions[key] === state.edition);
    destination.value = target || '';
    editionInputs.forEach(input => { input.checked = input.value === state.edition; });
    inputs.forEach(input => { input.checked = target && input.value === state.run; });
    renderChoices();
  }
  addEventListener('aio:setup-change', event => syncGuide(event.detail));
  addEventListener('aio:setup-request', event => {
    if (!dialog.open) configure.click();
    if (event.detail === 'prepare' && validChoices()) showNative('prepare');
  });
  syncGuide(guide.getState());
})();
