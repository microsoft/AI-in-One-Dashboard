// @ts-check
/**
 * The installer's output and questions as events, for the browser wizard. It has the same
 * methods as the terminal UI, so every step runs unchanged; each question waits until the
 * page answers it. Answers are checked here, with the step's own validation.
 */
import { parseForm } from './ui.js';

/**
 * @typedef {'red' | 'green' | 'yellow' | 'cyan'} Colour
 * @typedef {{ text: string, bold?: boolean, dim?: boolean, colour?: Colour }} Segment
 * @typedef {{ type: string, seq: number, at: number, [key: string]: any }} UiEvent
 * @typedef {{ value?: any, display?: string, error?: string }} Parsed
 * @typedef {{ kind: string, message: string, parse: (raw: unknown) => Parsed, resolve: (v: any) => void, reject: (e: Error) => void }} Pending
 * @typedef {{ kind: string, message: string, value: any }} Recorded  An answer given since begin(). Held in memory only.
 * @typedef {{ toRaw: (value: any) => unknown, prefill: (value: any) => Record<string, any> }} Memory  How a recorded answer is given again, or shown as the starting answer.
 */

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
/** @type {Record<number, Colour>} */
const COLOURS = { 31: 'red', 32: 'green', 33: 'yellow', 36: 'cyan' };
/** How a sign-in code reads in the device-code message. */
const DEVICE_CODE = /(https:\/\/\S+)\s.*?\bcode\s+([A-Z0-9-]{6,})/i;
export const SECRET_MASK = '••••••••';

/**
 * Splits text with ANSI colour codes into styled runs.
 * @param {string} s
 * @returns {Segment[]}
 */
export function toSegments(s) {
  /** @type {Segment[]} */
  const out = [];
  /** @type {Omit<Segment, 'text'>} */
  let style = {};
  let last = 0;
  const push = (/** @type {string} */ text) => {
    const clean = text.replace(OTHER_ESCAPES, '');
    if (clean) out.push({ text: clean, ...style });
  };
  for (const m of s.matchAll(SGR)) {
    push(s.slice(last, m.index));
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) style = {};
      else if (code === 1) style = { ...style, bold: true };
      else if (code === 2) style = { ...style, dim: true };
      else if (code === 22) style = { colour: style.colour };
      else if (code === 39) style = { bold: style.bold, dim: style.dim };
      else if (COLOURS[code]) style = { ...style, colour: COLOURS[code] };
    }
    last = (m.index ?? 0) + m[0].length;
  }
  push(s.slice(last));
  return out.map((seg) => /** @type {Segment} */ (Object.fromEntries(Object.entries(seg).filter(([, v]) => v !== undefined))));
}

/** @param {string} s */
export const plainText = (s) => s.replace(SGR, '').replace(OTHER_ESCAPES, '');

/** @param {unknown} a @param {unknown} b */
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** @type {Memory} */
const AS_TYPED = { toRaw: (v) => v, prefill: (v) => ({ default: v }) };

/**
 * @template T
 * @typedef {import('./ui.js').Choice<T>} Choice
 */

/**
 * @param {{ now?: () => number }} [opts]
 */
export function createWebUi(opts = {}) {
  const now = opts.now ?? Date.now;
  /** @type {UiEvent[]} */
  const history = [];
  /** @type {Set<(e: UiEvent) => void>} */
  const listeners = new Set();
  /** @type {Map<number, Pending>} */
  const pending = new Map();
  let seq = 0;
  let ids = 0;
  // Going back. Between begin() and end() every answer is recorded. Back asks the questions
  // again from the start: each recorded answer is given again, up to the question before the
  // open one, which opens with the answer it had. A secret is recorded too, so it isn't pasted
  // twice, but it stays here: events only carry its mask.
  let recording = false;
  let editingSection = false;
  let mark = 0;
  /** @type {Recorded[]} */
  let answers = [];
  /** @type {Recorded[]} */
  let replay = [];
  /** @type {Recorded | null} */
  let recall = null;

  /**
   * @param {{ type: string, [key: string]: any }} event
   * @returns {UiEvent}
   */
  function emit(event) {
    const e = { seq: ++seq, at: now(), ...event };
    history.push(e);
    for (const fn of listeners) fn(e);
    return e;
  }

  /** @param {string} kind @param {string} s */
  const say = (kind, s) => {
    emit({ type: 'line', kind, text: plainText(s), segments: toSegments(s) });
  };

  /**
   * @param {string} kind
   * @param {string} message
   * @param {Record<string, any>} extra
   * @param {(raw: unknown) => Parsed} parse
   * @param {Memory} [memory]  Without one, a recorded answer can't be given again.
   * @returns {Promise<any>}
   */
  function ask(kind, message, extra, parse, memory) {
    const id = ++ids;
    const text = plainText(message);
    const same = (/** @type {Recorded | null | undefined} */ r) => !!r && r.kind === kind && r.message === text;
    let shown = extra;
    if (replay.length) {
      const head = replay[0];
      const r = same(head) && memory ? parse(memory.toRaw(head.value)) : null;
      if (r && r.error === undefined) {
        replay.shift();
        emit({ type: 'prompt', id, kind, message: text, ...extra, replayed: true });
        emit({ type: 'answered', id, display: r.display, replayed: true });
        answers.push({ kind, message: text, value: r.value });
        return Promise.resolve(r.value);
      }
      // The questions changed, so the answers left may not fit them.
      replay = [];
      recall = null;
    }
    if (recall) {
      if (same(recall) && memory) shown = { ...extra, ...memory.prefill(recall.value) };
      recall = null;
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { kind, message: text, parse, resolve, reject });
      emit({ type: 'prompt', id, kind, message: text, ...shown, ...(recording && answers.length ? { back: true } : {}), ...(editingSection ? { settingsBack: true } : {}) });
    });
  }

  /**
   * @param {{ name: string, description?: string, disabled?: boolean | string, checked?: boolean }} ch
   */
  const choiceView = (ch) => ({
    name: plainText(ch.name),
    ...(ch.description ? { description: plainText(ch.description) } : {}),
    ...(ch.disabled ? { disabled: typeof ch.disabled === 'string' ? ch.disabled : true } : {}),
    ...(ch.checked !== undefined ? { checked: !!ch.checked } : {}),
  });

  return {
    yes: false,
    web: true,
    beginSection() { editingSection = true; },
    endSection() { editingSection = false; },
    cancelSection() {
      if (!editingSection || !pending.size) return false;
      for (const [id, p] of pending) {
        pending.delete(id);
        emit({ type: 'answered', id, display: 'Changes cancelled' });
        p.reject(Object.assign(new Error('Changes cancelled'), { name: 'SettingsCancelled' }));
      }
      return true;
    },
    /**
     * @param {import('./ui.js').SettingsCategory[]} categories
     * @param {{ notice?: string, changes: string[] }} state
     * @returns {Promise<string>}
     */
    settings(categories, state) {
      return ask('settings', 'Review and fix setup', { categories, ...state }, (raw) =>
        typeof raw === 'string' && (['deploy', 'close'].includes(raw) || categories.some((cat) => cat.id === raw))
          ? { value: raw, display: categories.find((cat) => cat.id === raw)?.title ?? raw }
          : { error: 'Choose a settings category or review the deployment.' });
    },
    /**
     * @param {string} message
     * @param {import('./ui.js').FormField[]} fields
     * @returns {Promise<Record<string, string> | null>}
     */
    form(message, fields) {
      return ask('form', message, { fields: fields.map(({ validate, ...field }) => field) }, (raw) => {
        if (raw === null) return { value: null, display: 'Changes cancelled' };
        const parsed = parseForm(raw, fields);
        if (parsed.error !== undefined) return { error: parsed.error };
        const values = parsed.value;
        return { value: values, display: fields.map((f) => `${f.label}: ${values[f.id]}`).join(', ') };
      });
    },
    /** @param {string} [s] */
    line(s = '') {
      const text = plainText(s);
      const code = DEVICE_CODE.exec(text);
      if (code) emit({ type: 'device-code', url: code[1], code: code[2], text });
      else if (text.trim()) say('line', s);
    },
    /** @param {string} title */
    heading: (title) => {
      emit({ type: 'heading', title: plainText(title) });
    },
    /** @param {number} n @param {number} total @param {string} title */
    step: (n, total, title) => {
      emit({ type: 'step', n, total, title: plainText(title) });
    },
    /** @param {string} s */
    ok: (s) => say('ok', s),
    /** @param {string} s */
    warn: (s) => say('warn', s),
    /** @param {string} s */
    fail: (s) => say('fail', s),
    /** @param {string} s */
    info: (s) => say('info', s),
    /** @param {string} s */
    note: (s) => say('note', s),
    /** @param {import('./steps/plan.js').PlanReview} plan */
    review: (plan) => {
      emit({ type: 'review', plan });
    },
    /** @param {import('./loads.js').LoadCard[]} cards */
    loads: (cards) => {
      emit({ type: 'loads', cards });
    },
    /** @param {string} title @param {import('./steps/next-steps.js').NextStep[]} steps */
    nextSteps: (title, steps) => {
      emit({ type: 'next-steps', title, steps });
    },
    /** @param {import('./prereqs.js').Prereq[]} items */
    prereqs: (items) => {
      emit({ type: 'prereqs', items });
    },

    /**
     * @template T
     * @param {string} message
     * @param {Choice<T>[]} choices
     * @param {T} [defaultValue]
     * @returns {Promise<T>}
     */
    async select(message, choices, defaultValue) {
      const open = choices.filter((ch) => !ch.disabled);
      if (open.length === 1) {
        emit({ type: 'auto', message: plainText(message), display: plainText(open[0].name) });
        return open[0].value;
      }
      const at = (/** @type {unknown} */ v) => choices.findIndex((ch) => !ch.disabled && sameValue(ch.value, v));
      const preferred = choices.findIndex((ch) => !ch.disabled && ch.value === defaultValue);
      return ask('select', message, { choices: choices.map(choiceView), default: preferred >= 0 ? preferred : choices.findIndex((ch) => !ch.disabled) }, (raw) => {
        const ch = Number.isInteger(raw) ? choices[/** @type {number} */ (raw)] : undefined;
        if (!ch || ch.disabled) return { error: 'Choose one of the options.' };
        return { value: ch.value, display: plainText(ch.name) };
      }, { toRaw: at, prefill: (v) => (at(v) >= 0 ? { default: at(v) } : {}) });
    },

    /**
     * @param {string} message
     * @param {boolean} defaultValue
     * @returns {Promise<boolean>}
     */
    async confirm(message, defaultValue) {
      return ask('confirm', message, { default: defaultValue }, (raw) =>
        typeof raw === 'boolean' ? { value: raw, display: raw ? 'Yes' : 'No' } : { error: 'Answer yes or no.' },
      AS_TYPED);
    },

    /**
     * @param {string} message
     * @param {{ default?: string, validate?: (v: string) => true | string }} [o]
     * @returns {Promise<string>}
     */
    async input(message, o = {}) {
      return ask('input', message, o.default !== undefined ? { default: o.default } : {}, (raw) => {
        if (typeof raw !== 'string') return { error: 'Type an answer.' };
        const value = raw === '' && o.default !== undefined ? o.default : raw;
        const verdict = o.validate ? o.validate(value) : true;
        if (verdict !== true) return { error: verdict };
        return { value, display: value };
      }, AS_TYPED);
    },

    /**
     * The history and the page only ever see a mask. Going back gives the secret again from
     * memory, and back at this question an empty answer keeps it.
     * @param {string} message
     * @returns {Promise<string>}
     */
    async secret(message) {
      /** @type {string | undefined} */
      let kept;
      return ask('secret', message, {}, (raw) => {
        if (raw === '' && kept !== undefined) return { value: kept, display: SECRET_MASK };
        return typeof raw === 'string' && raw.trim() ? { value: raw, display: SECRET_MASK } : { error: 'Required' };
      }, {
        toRaw: (v) => v,
        prefill: (v) => {
          kept = v;
          return { keep: true };
        },
      });
    },

    /**
     * Options that are ticked and can't be changed are always in the answer, as in the terminal.
     * @template T
     * @param {string} message
     * @param {(Choice<T> & { checked?: boolean })[]} choices
     * @returns {Promise<T[]>}
     */
    async checkbox(message, choices) {
      const locked = (/** @type {Choice<T> & { checked?: boolean }} */ ch) => !!ch.disabled && !!ch.checked;
      const has = (/** @type {unknown} */ v, /** @type {T} */ value) => Array.isArray(v) && v.some((x) => sameValue(x, value));
      return ask('checkbox', message, { choices: choices.map(choiceView) }, (raw) => {
        if (!Array.isArray(raw)) return { error: 'Choose from the options.' };
        if (raw.some((i) => !Number.isInteger(i) || !choices[i] || (choices[i].disabled && !locked(choices[i])))) return { error: 'Choose from the options.' };
        const picked = choices.flatMap((ch, i) => (locked(ch) || raw.includes(i) ? [i] : []));
        return {
          value: picked.map((i) => choices[i].value),
          display: picked.length ? picked.map((i) => plainText(choices[i].name)).join(', ') : 'None',
        };
      }, {
        toRaw: (v) => {
          const at = Array.isArray(v) ? v.map((x) => choices.findIndex((ch) => sameValue(ch.value, x))) : [-1];
          return at.every((i) => i >= 0) ? at : null;
        },
        prefill: (v) => ({ choices: choices.map((ch) => choiceView({ ...ch, checked: locked(ch) || has(v, ch.value) })) }),
      });
    },

    /**
     * A long wait. The page counts the elapsed time itself, so only a new status is sent.
     * @param {string} label
     */
    progress(label) {
      const id = ++ids;
      const startedAt = now();
      let last = '';
      emit({ type: 'progress', id, label: plainText(label), status: '', startedAt });
      return {
        /** @param {string} status */
        update(status) {
          const s = plainText(status);
          if (s === last) return;
          last = s;
          emit({ type: 'progress', id, label: plainText(label), status: s, startedAt });
        },
        done() {
          const ms = now() - startedAt;
          emit({ type: 'progress-done', id, ms });
          return ms;
        },
      };
    },

    /** Session events, such as a command starting or finishing. */
    emit,

    /**
     * Answers an open question. A rejected answer leaves it open.
     * @param {number} id
     * @param {unknown} raw
     * @returns {{ ok: boolean, error?: string }}
     */
    answer(id, raw) {
      const p = pending.get(id);
      if (!p) return { ok: false, error: 'That question isn\'t open any more.' };
      const r = p.parse(raw);
      if (r.error !== undefined) {
        emit({ type: 'invalid', id, error: r.error });
        return { ok: false, error: r.error };
      }
      pending.delete(id);
      emit({ type: 'answered', id, display: r.display });
      if (recording) answers.push({ kind: p.kind, message: p.message, value: r.value });
      p.resolve(r.value);
      return { ok: true };
    },

    /** Records the answers from here, so Back can go through them. */
    begin() {
      recording = true;
      mark = seq;
      answers = [];
      replay = [];
      recall = null;
    },

    /** Stops recording. There's no going back past this point. */
    end() {
      recording = false;
      answers = [];
      replay = [];
      recall = null;
    },

    /**
     * Back to the question before the open one. The open question fails with a GoBack error,
     * so the caller can ask again from begin(). The events since then are dropped, and the
     * page is told to drop them too.
     */
    back() {
      if (!recording || !answers.length || !pending.size) return false;
      replay = answers.slice(0, -1);
      recall = answers[answers.length - 1];
      answers = [];
      const cut = history.findIndex((e) => e.seq > mark);
      if (cut >= 0) history.splice(cut);
      const open = [...pending.values()];
      pending.clear();
      emit({ type: 'rewind', to: mark });
      for (const p of open) {
        const err = new Error('Back');
        err.name = 'GoBack';
        p.reject(err);
      }
      return true;
    },

    /** Stops at the open question, the way Ctrl+C does in the terminal. */
    cancel() {
      if (!pending.size) return false;
      for (const [id, p] of pending) {
        pending.delete(id);
        emit({ type: 'answered', id, display: 'Cancelled', cancelled: true });
        const err = new Error('Cancelled');
        err.name = 'ExitPromptError';
        p.reject(err);
      }
      return true;
    },

    /** Events after `since`, for a page that connects or reconnects. @param {number} [since] */
    history: (since = 0) => history.filter((e) => e.seq > since),

    /**
     * @param {(e: UiEvent) => void} fn
     * @returns {() => void} Unsubscribes.
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** @typedef {ReturnType<typeof createWebUi>} WebUi */
