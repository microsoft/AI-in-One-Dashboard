(() => {
  'use strict';
  const prefix = 'pax-mini-kitchen.aio.';
  const version = 3;
  const capabilities = ['guided-screens', 'ephemeral-state', 'full-site-handoff', 'step-navigation', 'live-preview'];
  const optionalCapabilities = ['command-export'];
  const maxCommandBytes = 65536;
  const screens = [
    { id: 'collection', title: 'Dates and people' },
    { id: 'output', title: 'Storage and sign-in' },
    { id: 'review', title: 'Your PAX command' }
  ];
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = (value, names) => record(value) && Object.keys(value).length === names.length &&
    names.every(name => Object.hasOwn(value, name));
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
  const context = value => keys(value, ['destination', 'run', 'theme']) &&
    ['local', 'sharepoint', 'fabric-tables'].includes(value.destination) &&
    ['initial', 'update'].includes(value.run) && ['light', 'dark'].includes(value.theme);
  const screen = value => keys(value, ['id', 'canNext', 'commandReady']) &&
    screens.some(item => item.id === value.id) && typeof value.canNext === 'boolean' &&
    typeof value.commandReady === 'boolean' && (value.id === 'review' || !value.commandReady);
  function parse(value) {
    if (!keys(value, ['type', 'version', 'sessionId', 'payload']) || value.version !== version ||
      !uuid(value.sessionId)) return null;
    const payload = value.payload;
    switch (value.type) {
      case prefix + 'ready':
        if (!keys(payload, ['context', 'capabilities']) || !context(payload.context) ||
          !Array.isArray(payload.capabilities) ||
          new Set(payload.capabilities).size !== payload.capabilities.length ||
          !capabilities.every(name => payload.capabilities.includes(name)) ||
          !payload.capabilities.every(name => capabilities.includes(name) || optionalCapabilities.includes(name))) return null;
        break;
      case prefix + 'initialized':
        if (!keys(payload, ['context']) || !context(payload.context)) return null;
        break;
      case prefix + 'screen-changed':
        if (!keys(payload, ['screen']) || !screen(payload.screen)) return null;
        break;
      case prefix + 'command-preview':
        if (!keys(payload, ['command', 'ready']) || typeof payload.ready !== 'boolean' ||
          typeof payload.command !== 'string' || (payload.ready && !payload.command.trim()) ||
          payload.command.length > maxCommandBytes || /\0/.test(payload.command) ||
          new TextEncoder().encode(payload.command).length > maxCommandBytes) return null;
        break;
      case prefix + 'error':
        if (!keys(payload, ['code']) || !['unsupported-context', 'invalid-message', 'screen-blocked', 'handoff-failed'].includes(payload.code)) return null;
        break;
      case prefix + 'handoff-ready':
      case prefix + 'handoff-complete':
      case prefix + 'handoff-failed':
      case prefix + 'close-request':
        if (!keys(payload, [])) return null;
        break;
      default: return null;
    }
    return value;
  }
  function parseCommandResult(value, sessionId, requestId) {
    if (!keys(value, ['type', 'version', 'sessionId', 'payload']) || value.version !== version ||
      value.sessionId !== sessionId || !uuid(sessionId) || !uuid(requestId)) return null;
    const payload = value.payload;
    if (value.type === prefix + 'command-unavailable') {
      return keys(payload, ['requestId', 'code']) && payload.requestId === requestId && payload.code === 'not-ready' ? value : null;
    }
    if (value.type !== prefix + 'command-result' || !keys(payload, ['requestId', 'command']) ||
      payload.requestId !== requestId || typeof payload.command !== 'string' || !payload.command.trim() ||
      payload.command.length > maxCommandBytes || /[\r\n\0]/.test(payload.command) ||
      new TextEncoder().encode(payload.command).length > maxCommandBytes) return null;
    return value;
  }
  window.AIO_KITCHEN_CONTRACT = { prefix, version, capabilities, screens, parse, parseCommandResult, context, uuid };
})();
