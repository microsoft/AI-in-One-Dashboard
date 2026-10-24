// @ts-check
/**
 * The PAX route's preview: the task's script and definition, the app registration's permissions,
 * and the model and report when the files go to SharePoint. Where the install record has no value
 * yet it uses a placeholder. No sign-in, and nothing runs or changes on the PC.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { paxPermissions } from '../catalog.js';
import { emptyPax } from '../config.js';
import { loadTemplateModel } from '../transform/model.js';
import { loadTemplateReport, reportDefinition } from '../transform/report.js';
import { defaultLocalFolder, paxDir, SP_FOLDER, TASK_NAME, WRAPPER_FILE } from './names.js';
import { loadRelease } from './release.js';
import { buildPaxModel, paxModelUrls } from './report.js';
import { parseSiteUrl } from './site.js';
import { loadTemplate, renderWrapper, taskXmlBytes, wrapperSettings } from './wrapper.js';

/** @param {number} n */
const fake = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const SAMPLE_SITE = 'https://your-tenant.sharepoint.com/sites/AIinOne';
const SAMPLE_SID = 'S-1-5-21-1000000000-1000000000-1000000000-1001';
const SAMPLE_PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

/**
 * @param {{ ui: import('../ui.js').Ui, config: import('../config.js').InstallConfig, sources: import('../sources.js').Sources, outDir: string, now?: Date, env?: NodeJS.ProcessEnv }} o
 * @returns {string[]}  The files it wrote, relative to outDir.
 */
export function paxPreview(o) {
  const { ui, config, sources } = o;
  const out = resolve(o.outDir);
  const base = o.env ?? process.env;
  const env = { ...base, LOCALAPPDATA: base.LOCALAPPDATA || 'C:\\Users\\you\\AppData\\Local' };
  const release = loadRelease();
  const pax = { ...emptyPax(), ...config.pax };
  const sp = pax.destination === 'sharepoint';
  const at = parseSiteUrl(pax.site?.url ?? SAMPLE_SITE);
  const library = pax.site?.library ?? 'Documents';
  /** @type {import('../config.js').PaxSite | undefined} */
  const site = sp
    ? {
        ...pax.site,
        url: at.url,
        host: pax.site?.host ?? at.host,
        path: pax.site?.path ?? at.path,
        library,
        folder: pax.site?.folder || SP_FOLDER,
        driveWebUrl: pax.site?.driveWebUrl ?? `${at.url}/${library === 'Documents' ? 'Shared%20Documents' : encodeURIComponent(library)}`,
      }
    : undefined;
  const version = pax.version ?? release.version;
  /** @type {import('../config.js').InstallConfig} */
  const shown = {
    ...config,
    tenantId: config.tenantId ?? fake(0),
    app: { ...config.app, appId: config.app.appId ?? fake(1) },
    pax: {
      ...pax,
      site,
      localFolder: sp ? pax.localFolder : pax.localFolder ?? defaultLocalFolder(),
      certificateThumbprint: pax.certificateThumbprint ?? '0'.repeat(40),
      version,
      script: pax.script ?? join(paxDir(version, env), release.file),
      sha256: pax.sha256 ?? release.sha256,
    },
  };

  /** @type {string[]} */
  const written = [];
  /** @param {string} name @param {string | Buffer} data */
  const write = (name, data) => {
    const path = join(out, ...name.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    written.push(name);
  };
  write(WRAPPER_FILE, renderWrapper(loadTemplate(), wrapperSettings(shown, { env })));
  write('task.xml', taskXmlBytes({ sid: pax.userSid ?? SAMPLE_SID, pwsh: pax.pwsh ?? SAMPLE_PWSH, runAt: pax.runAt, env, now: o.now }));
  write(
    'graph-permissions.txt',
    `Microsoft Graph application permissions for the app registration:\n${paxPermissions(pax).map((p) => `  ${p}\n`).join('')}${
      sp ? `Sites.Selected gives it nothing until it has write permission on ${at.url} alone.\n` : ''
    }`,
  );
  const withModel = sp && config.semanticModel.enabled !== false && !!sources.paxModelFile;
  if (withModel) {
    const file = /** @type {string} */ (sources.paxModelFile);
    write('model.bim', `${JSON.stringify(buildPaxModel(loadTemplateModel(file), paxModelUrls(shown)), null, 2)}\n`);
    for (const p of reportDefinition(loadTemplateReport(file), config.semanticModel.id ?? fake(4)).parts) write(`report/${p.path}`, Buffer.from(p.payload, 'base64'));
  }

  ui.heading('Preview written');
  ui.info(out);
  ui.note(
    `${WRAPPER_FILE} (the script the task "${TASK_NAME}" runs), task.xml, graph-permissions.txt${withModel ? ', model.bim and the report (report folder)' : ''}, with placeholders where nothing is known yet.`,
  );
  return written;
}
