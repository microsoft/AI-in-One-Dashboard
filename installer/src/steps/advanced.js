// @ts-check
/**
 * The advanced settings: one question in the plan. With No, the default and with --yes, the settings
 * behind it keep their saved value, or the default, without being asked. The plan review still shows them.
 */

/** @typedef {import('../install.js').Ctx} Ctx */

/**
 * @param {Ctx} ctx
 * @param {string} what  The settings behind the question, for the note above it.
 */
export async function askAdvanced(ctx, what) {
  const { ui } = ctx;
  ui.heading('Advanced settings');
  ui.note(`The defaults suit most organisations. Choose Yes to change ${what}.`);
  ctx.advanced = await ui.confirm('Change the advanced settings?', false);
}

/**
 * Whether to ask an advanced question. Outside the plan (e.g. the access command) there was no
 * Advanced question, so it asks.
 * @param {Ctx} ctx
 */
export const asksAdvanced = (ctx) => ctx.advanced !== false;
