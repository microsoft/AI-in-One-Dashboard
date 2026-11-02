// @ts-check
/**
 * The PAX route's SharePoint site. The app gets write access to that one site through
 * Sites.Selected: the user gives it when they can manage the site's permissions, or else an admin
 * does, with the commands the installer shows. Then the task's own script signs in as the app and
 * checks that it can write to the folder, as every run will.
 */
import { createCredential } from '../auth.js';
import { appGrant, sitesApi } from '../clients/graph.js';
import { createClient, HttpError } from '../http.js';
import { retireCredentials } from './identity.js';
import { PAX_APP_NAME, SP_FOLDER } from './names.js';
import { runPwshOf } from './pc.js';
import { psQuote } from './ps.js';
import { checkAccess } from './scripts.js';
import { writeWrapper } from './wrapper.js';

/** @typedef {import('../install.js').Ctx} Ctx */
/** @typedef {import('../config.js').PaxSite} PaxSite */
/** @typedef {import('./scripts.js').AccessCheck} AccessCheck */

/** Microsoft Graph Command Line Tools: Microsoft's public client app, which may ask for any Graph permission. */
export const GRAPH_CLI_APP_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
/** What giving an app access to one site takes. Only an admin can consent to it. */
export const SITE_ADMIN_SCOPE = 'https://graph.microsoft.com/Sites.FullControl.All';
/** The site roles that let the app write. */
const WRITE_ROLES = ['write', 'owner', 'fullcontrol'];
/** How long the check keeps trying while a new grant, consent or certificate reaches SharePoint and Entra. */
export const CHECK_WAIT_MS = 3 * 60_000;
export const CHECK_EVERY_MS = 20_000;
const EXAMPLE = 'https://contoso.sharepoint.com/sites/AIinOne';
/** Parts of a site's address that aren't a document library. */
const NOT_LIBRARIES = new Set(['_layouts', '_api', '_vti_bin', 'sitepages', 'lists', 'forms', 'sites', 'teams']);

/** @param {string} s */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * @typedef {object} SiteAddress
 * @property {string} host  Such as contoso.sharepoint.com.
 * @property {string} path  Such as /sites/AIinOne. Empty for the root site.
 * @property {string} url  The site's own address.
 * @property {string} [library]  When the address is a link to a library or a folder in one, as the browser shows it.
 * @property {string} [folder]
 */

/**
 * The site in a SharePoint address, and the library and folder when it's a link to one.
 * @param {string} text  Such as https://contoso.sharepoint.com/sites/AIinOne.
 * @returns {SiteAddress}
 */
export function parseSiteUrl(text) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(String(text ?? '').trim());
  } catch {
    throw new Error(`"${text}" isn't a web address. Use the site's address, such as ${EXAMPLE}.`);
  }
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.sharepoint\.com$/i.test(u.hostname)) {
    throw new Error(`"${text}" isn't a SharePoint Online site. Use an address such as ${EXAMPLE}.`);
  }
  if (/-my\.sharepoint\.com$/i.test(u.hostname)) {
    throw new Error(`"${text}" is a OneDrive. Use a SharePoint site that the report's viewers can read, such as ${EXAMPLE}.`);
  }
  const host = u.hostname.toLowerCase();
  let full = decode(u.pathname).replace(/\/+$/, '');
  // A "Copy link" link. In /:f:/r/sites/AIinOne/Shared Documents/AI in One the rest is the folder's own
  // path. The other kinds, such as /:f:/s/AIinOne/<code>, end in a code that doesn't name the folder.
  if (full.startsWith('/:')) {
    const own = /^\/:[a-z]+:\/r(?=\/)/i.exec(full);
    if (!own) {
      throw new Error(`"${text}" is a sharing link, which doesn't say which folder it's for. Use the folder's address from the browser's address bar, or the site's address, such as ${EXAMPLE}.`);
    }
    full = full.slice(own[0].length);
  }
  const path = /^\/(sites|teams)\/[^/]+/i.exec(full)?.[0] ?? '';
  // A link to a folder, from a library's page, names the folder in its id parameter.
  const id = (u.searchParams.get('id') ?? '').replace(/\/+$/, '');
  const inSite = id.toLowerCase().startsWith(`${path.toLowerCase()}/`) ? id.slice(path.length) : full.slice(path.length);
  const [library, ...rest] = inSite.split('/').filter(Boolean);
  /** @type {SiteAddress} */
  const out = { host, path, url: `https://${host}${path}` };
  if (library && !NOT_LIBRARIES.has(library.toLowerCase()) && !/\.aspx$/i.test(library)) {
    out.library = library;
    const stop = rest.findIndex((s) => s.toLowerCase() === 'forms' || /\.aspx$/i.test(s));
    const folder = (stop === -1 ? rest : rest.slice(0, stop)).join('/');
    if (folder) out.folder = folder;
  }
  return out;
}

/** @param {{ host?: string, path?: string, url?: string }} site */
export const siteAddress = (site) => (site.host ? `https://${site.host}${site.path ?? ''}` : String(site.url ?? ''));

/** @param {PaxSite} site */
const siteLabel = (site) => site.webUrl ?? siteAddress(site);

/** The folder as people see it in SharePoint. @param {PaxSite} site */
export const folderLabel = (site) => `${site.library}/${site.folder || SP_FOLDER} in ${site.name ?? siteAddress(site)}`;

/** The last part of a library's address, decoded, as the report reads it. @param {string | undefined} webUrl */
const addressPart = (webUrl) => decode(String(webUrl ?? '').replace(/\/+$/, '').split('/').pop() ?? '');

/**
 * Whether a library has the name the user gave, or that name is the last part of its address
 * (such as Shared Documents, for the library called Documents). The task's script matches the
 * same way.
 * @param {{ name?: string, webUrl?: string }} drive
 * @param {string} library
 */
export function sameLibrary(drive, library) {
  const want = library.trim().toLowerCase();
  return String(drive.name ?? '').toLowerCase() === want || addressPart(drive.webUrl).toLowerCase() === want;
}

/**
 * Why the report can't read the files in the library at this address, or ''. The report decodes
 * the files' addresses, so a # or % in the library's part of it would break them. Renaming a
 * library doesn't change its address, so its name can have them when its address doesn't.
 * @param {string | undefined} webUrl
 */
export function libraryAddressProblem(webUrl) {
  return /[#%]/.test(addressPart(webUrl)) ? `its address, ${webUrl}, has a # or %` : '';
}

/**
 * The address of one of the files in the site's folder, as the report reads it.
 * @param {PaxSite} site
 * @param {string} name
 */
export function fileUrl(site, name) {
  if (!site.driveWebUrl) {
    throw new Error("The install record doesn't have the library's address yet. Run install again once the app can write to the folder.");
  }
  const folder = (site.folder || SP_FOLDER).split('/').filter(Boolean);
  return [site.driveWebUrl.replace(/\/+$/, ''), ...folder.map(encodeURIComponent), encodeURIComponent(name)].join('/');
}

/** The site's Graph address, by its path. @param {PaxSite} site */
const siteUri = (site) => {
  const path = (site.path ?? '').split('/').map(encodeURIComponent).join('/');
  return `https://graph.microsoft.com/v1.0/sites/${site.host}${path ? `:${path}` : ''}`;
};

/**
 * What an admin runs in PowerShell, with the Microsoft Graph PowerShell module, to give the app
 * write access to the site and no other. The same calls the installer makes.
 * @param {PaxSite} site
 * @param {string} appId
 */
export function grantCommands(site, appId) {
  const body = `@{ roles = @('write'); grantedToIdentities = @(@{ application = @{ id = ${psQuote(appId)}; displayName = ${psQuote(PAX_APP_NAME)} } }) } | ConvertTo-Json -Depth 5`;
  return [
    'Connect-MgGraph -Scopes Sites.FullControl.All',
    `$site = Invoke-MgGraphRequest -Method GET -Uri ${psQuote(siteUri(site))}`,
    `Invoke-MgGraphRequest -Method POST -Uri "https://graph.microsoft.com/v1.0/sites/$($site.id)/permissions" -ContentType 'application/json' -Body (${body})`,
  ];
}

/**
 * What an admin runs to take the app's access to the site away.
 * @param {PaxSite} site
 */
export const revokeCommands = (site) => [
  'Connect-MgGraph -Scopes Sites.FullControl.All',
  `Invoke-MgGraphRequest -Method DELETE -Uri ${psQuote(`https://graph.microsoft.com/v1.0/sites/${site.id}/permissions/${site.grantId}`)}`,
];

/**
 * What an admin runs to put the app's access to the site back to the roles an admin had given it,
 * before the installer raised them to write.
 * @param {PaxSite} site
 * @param {string[]} roles
 */
export const restoreCommands = (site, roles) => [
  'Connect-MgGraph -Scopes Sites.FullControl.All',
  `Invoke-MgGraphRequest -Method PATCH -Uri ${psQuote(`https://graph.microsoft.com/v1.0/sites/${site.id}/permissions/${site.grantId}`)} -ContentType 'application/json' -Body (@{ roles = @(${roles.map((r) => psQuote(r)).join(', ')}) } | ConvertTo-Json)`,
];

/**
 * SharePoint, signed in as the user with Sites.FullControl.All, which giving an app access to a
 * site takes. It's a second sign-in, through Microsoft Graph Command Line Tools, because the
 * installer's own sign-in can't ask for that permission.
 * @param {Ctx} ctx
 * @returns {import('../clients/graph.js').SitesApi}
 */
export function siteAdminApi(ctx) {
  if (ctx.sites) return ctx.sites;
  const credential = createCredential({ tenantId: ctx.user.tenantId, method: ctx.method, clientId: GRAPH_CLI_APP_ID, print: (m) => ctx.ui.line(m) });
  /** @type {{ token: string, expiresOn: number } | undefined} */
  let cached;
  const http = createClient({
    baseUrl: 'https://graph.microsoft.com/v1.0',
    getToken: async () => {
      if (!cached || cached.expiresOn - Date.now() < 5 * 60_000) {
        const t = await credential.getToken(SITE_ADMIN_SCOPE);
        if (!t) throw new Error('The sign-in gave no token for Sites.FullControl.All.');
        cached = { token: t.token, expiresOn: t.expiresOnTimestamp };
      }
      return cached.token;
    },
  });
  ctx.sites = sitesApi(http);
  return ctx.sites;
}

/** Whether a second sign-in can ask for Sites.FullControl.All. The Azure CLI's can't. @param {Ctx} ctx */
const canSignInForSites = (ctx) => !!ctx.sites || ctx.method !== 'azure-cli';

/** @param {unknown} err */
const firstLine = (err) => String(/** @type {any} */ (err)?.message ?? err).split(/\r?\n/)[0];

/** @param {Ctx} ctx */
function siteOf(ctx) {
  const site = ctx.config.pax?.site;
  if (!site) throw new Error('The install record has no SharePoint site yet.');
  if (!site.host) {
    const parsed = parseSiteUrl(site.url);
    site.host = parsed.host;
    site.path = parsed.path;
  }
  return site;
}

/**
 * Shows what to send an admin so the app gets write access to the site.
 * @param {Ctx} ctx
 * @param {PaxSite} site
 * @param {string} [why]
 * @returns {false}
 */
function handOff(ctx, site, why) {
  const { ui } = ctx;
  if (why) ui.warn(why);
  ui.info(`Ask a SharePoint admin to give "${PAX_APP_NAME}" write access to ${siteLabel(site)}, and to no other site. In PowerShell, with the Microsoft Graph PowerShell module:`);
  for (const line of grantCommands(site, /** @type {string} */ (ctx.config.app.appId))) ui.info(`  ${line}`);
  return false;
}

/**
 * Finds the library by its name or the last part of its address, as the task's script does.
 * When the site has none by that name, or the report can't read the address of the one it has,
 * asks which of the libraries the report can read to use.
 * @param {Ctx} ctx
 * @param {import('../clients/graph.js').SitesApi} sites
 * @param {PaxSite} site
 */
async function chooseLibrary(ctx, sites, site) {
  const drives = (await sites.drives(/** @type {string} */ (site.id))).filter((d) => !d.driveType || d.driveType === 'documentLibrary');
  let drive = drives.find((d) => sameLibrary(d, site.library));
  const unreadable = drive ? libraryAddressProblem(drive.webUrl) : '';
  if (!drive || unreadable) {
    const where = site.name ?? siteAddress(site);
    if (!drives.length) throw new Error(`${where} has no document library to put the files in.`);
    const why = unreadable ? `The report can't use the library "${site.library}": ${unreadable}.` : `${where} has no library called "${site.library}".`;
    const usable = drives.filter((d) => !libraryAddressProblem(d.webUrl));
    if (!usable.length) throw new Error(`${why} None of its libraries has an address the report can read.`);
    const names = `${usable.length < drives.length ? 'Libraries the report can use' : 'Its libraries'}: ${usable.map((d) => String(d.name)).join(', ')}.`;
    if (ctx.ui.yes) throw new Error(`${why} ${names} Run install again without --yes to choose one.`);
    const id = await ctx.ui.select(
      `${why} Which library should the files go in?`,
      usable.map((d) => ({ name: String(d.name), value: String(d.id) })),
      String(usable[0].id),
    );
    drive = usable.find((d) => d.id === id) ?? usable[0];
    site.library = String(drive.name);
  }
  site.driveId = drive.id;
  site.driveWebUrl = drive.webUrl;
  ctx.save();
}

/**
 * Gives the app write access to the site, signed in as the user. Returns false, having shown
 * what to send an admin, when the user can't or would rather an admin did it.
 * @param {Ctx} ctx
 * @param {PaxSite} site
 * @returns {Promise<boolean>}
 */
async function grantSiteAccess(ctx, site) {
  const { ui, config } = ctx;
  const appId = /** @type {string} */ (config.app.appId);
  if (!canSignInForSites(ctx)) return handOff(ctx, site, "You signed in with the Azure CLI, which can't ask for the SharePoint permission that giving the app access takes.");
  const who = await ui.select(
    `"${PAX_APP_NAME}" needs write access to ${siteLabel(site)}. Who gives it?`,
    [
      { name: 'I do: sign in again and allow Sites.FullControl.All. It needs admin consent, and rights to manage the site', value: 'me' },
      { name: 'An admin: show me what to send them', value: 'admin' },
    ],
    'me',
  );
  if (who === 'admin') return handOff(ctx, site);

  ui.note('Signing in again, through Microsoft Graph Command Line Tools with Sites.FullControl.All, to give the app access to this one site…');
  const sites = siteAdminApi(ctx);
  /** @type {any} */
  let found;
  try {
    found = await sites.siteByPath(/** @type {string} */ (site.host), site.path ?? '');
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new Error(`There's no SharePoint site at ${siteAddress(site)}, or you can't see it. Check the address, then run install again and change it.`);
    }
    if (err instanceof HttpError) return handOff(ctx, site, `You can't open ${siteAddress(site)} (HTTP ${err.status}).`);
    return handOff(ctx, site, `That sign-in didn't work: ${firstLine(err)}`);
  }
  site.id = found.id;
  site.name = found.displayName || found.name;
  site.webUrl = found.webUrl;
  ctx.save();
  try {
    await chooseLibrary(ctx, sites, site);
    const id = /** @type {string} */ (site.id);
    const mine = appGrant(await sites.permissions(id), appId);
    if (mine) {
      const roles = /** @type {string[]} */ ((await sites.permission(id, mine.id)).roles ?? []);
      if (site.grantId !== mine.id) {
        delete site.grantedByInstaller;
        delete site.previousRoles;
      }
      site.grantId = mine.id;
      if (roles.some((r) => WRITE_ROLES.includes(String(r).toLowerCase()))) {
        ui.ok(`The app can already write to ${site.name}`);
      } else {
        await sites.updateGrant(id, mine.id, ['write']);
        if (roles.length) site.previousRoles = roles;
        ui.ok(`Changed the app's access to ${site.name} from ${roles.join(', ') || 'none'} to write`);
      }
    } else {
      const made = await sites.grant(id, { appId, displayName: PAX_APP_NAME }, ['write']);
      site.grantId = made.id;
      site.grantedByInstaller = true;
      ui.ok(`Gave the app write access to ${site.name}, and to no other site`);
    }
    ctx.save();
    return true;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return handOff(ctx, site, err.status === 403 ? `You can't manage who has access to ${site.name}.` : `SharePoint refused (HTTP ${err.status}): ${firstLine(err)}`);
  }
}

/**
 * Whether a failed check may only be waiting for a new grant, consent or certificate to reach
 * SharePoint and Entra.
 * @param {AccessCheck} check
 */
export const mayBeLate = (check) =>
  !check.ok && (check.step === 'Signing in as the app' || check.status === 401 || check.status === 403 || (check.step === 'Finding the site' && check.status === 404));

/** @param {AccessCheck} check */
export const describeCheck = (check) => `${check.step ?? 'The check'} didn't work${check.status ? ` (HTTP ${check.status})` : ''}: ${check.error ?? 'no detail'}`;

/**
 * Runs the script's access check and, while the access looks to be on its way, again every 20
 * seconds until `waitMs` is up.
 * @param {Ctx} ctx
 * @param {number} waitMs
 */
async function checkUntil(ctx, waitMs) {
  const runPwsh = runPwshOf(ctx);
  const until = ctx.now().getTime() + waitMs;
  let waiting = false;
  for (;;) {
    const check = await checkAccess(runPwsh, ctx.env);
    if (check.ok || !mayBeLate(check) || ctx.now().getTime() + CHECK_EVERY_MS > until) return check;
    if (!waiting) ctx.ui.note('Waiting for the new access to reach SharePoint and Microsoft Entra. That can take a few minutes…');
    waiting = true;
    await ctx.sleep(CHECK_EVERY_MS);
  }
}

/** A file's size, in KB or MB. @param {number | undefined} bytes */
export const sizeOf = (bytes) => (bytes === undefined ? '' : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/**
 * A passing check fails at finding the library when the report can't read the library's address,
 * as when a library typed after a failed check has a # or % in it.
 * @param {PaxSite} site
 * @param {AccessCheck} check
 * @returns {AccessCheck}
 */
function readable(site, check) {
  const problem = check.ok ? libraryAddressProblem(check.driveWebUrl) : '';
  if (!problem) return check;
  return { ...check, ok: false, step: 'Finding the library', error: `The report can't use the library "${check.driveName ?? site.library}": ${problem}.` };
}

/**
 * Records what a passing check found, writes the script again with the library's ID, which each
 * run needs, and takes replaced keys off the app now the script signs in with the new one.
 * @param {Ctx} ctx
 * @param {PaxSite} site
 * @param {AccessCheck} check
 */
async function passed(ctx, site, check) {
  site.id = check.siteId ?? site.id;
  site.name = check.siteName ?? site.name;
  site.webUrl = check.siteWebUrl ?? site.webUrl;
  site.driveId = check.driveId;
  site.driveWebUrl = check.driveWebUrl;
  site.checkedAt = ctx.now().toISOString();
  ctx.save();
  writeWrapper(ctx.config, { env: ctx.env });
  ctx.ui.ok(`The app can write to ${folderLabel(site)}`);
  for (const f of check.files ?? []) {
    if (f.exists) ctx.ui.note(`${f.name} is there already (${sizeOf(f.size)}, changed ${String(f.lastModified ?? '').slice(0, 16).replace('T', ' ')})`);
  }
  await retireCredentials(ctx);
  return { ok: true, check };
}

/**
 * The SharePoint step on the PAX route. Writes the task's script, makes sure the app can write to
 * the site, and has the script check it can write to the folder, signed in as the app, as each
 * run will. A local folder needs only the script.
 * @param {Ctx} ctx
 * @param {{ consented: boolean }} o  consented: the app's Graph permissions have admin consent, so it can sign in.
 * @returns {Promise<{ ok: boolean, check?: AccessCheck }>}  ok: the check passed, or the files stay on this PC.
 */
export async function ensureSiteAccess(ctx, o) {
  const { ui, config } = ctx;
  const pax = config.pax;
  if (!pax) throw new Error('The install record has no PAX setup.');
  if (pax.destination === 'local') {
    writeWrapper(config, { env: ctx.env });
    ui.ok(`The task copies the files to ${pax.localFolder}`);
    await retireCredentials(ctx);
    return { ok: true };
  }
  const site = siteOf(ctx);
  writeWrapper(config, { env: ctx.env });

  // When it has worked before, there may be nothing to do.
  if (o.consented && site.checkedAt) {
    const check = readable(site, await checkAccess(runPwshOf(ctx), ctx.env));
    if (check.ok) return passed(ctx, site, check);
    ui.warn(describeCheck(check));
  }

  const granted = await grantSiteAccess(ctx, site);
  // Choosing a library there may have changed it, and found its ID.
  writeWrapper(config, { env: ctx.env });
  if (!o.consented) {
    ui.warn("The app can't sign in until an admin consents to its Graph permissions, so its access to the folder isn't checked yet.");
    return { ok: false };
  }
  let check = readable(site, await checkUntil(ctx, granted ? CHECK_WAIT_MS : 0));
  for (;;) {
    if (check.ok) return passed(ctx, site, check);
    ui.warn(describeCheck(check));
    if (ui.yes) {
      ui.warn("Carrying on without it. The task can't upload the files until the check passes: run install again then.");
      return { ok: false, check };
    }
    /** @type {{ name: string, value: string }[]} */
    const choices = [{ name: 'Check again', value: 'check' }];
    if (check.step === 'Finding the library') choices.push({ name: 'Change the library', value: 'library' });
    choices.push({ name: 'Carry on without it (the report and the first load wait until it works)', value: 'skip' });
    const next = await ui.select('Once that is sorted:', choices, 'check');
    if (next === 'skip') return { ok: false, check };
    if (next === 'library') {
      site.library = (await ui.input('The document library for the files', { default: site.library, validate: (v) => (v.trim() ? true : 'Enter the library name.') })).trim();
      delete site.driveId;
      delete site.driveWebUrl;
      ctx.save();
      writeWrapper(config, { env: ctx.env });
    }
    check = readable(site, await checkAccess(runPwshOf(ctx), ctx.env));
  }
}

/**
 * Uninstall: takes away the app's access to the site when the installer gave it, or puts it back
 * to the roles an admin had given it when the installer raised them to write, signed in again with
 * Sites.FullControl.All. Otherwise, or when that doesn't work, shows the admin command.
 * @param {Ctx} ctx
 */
export async function revokeSiteGrant(ctx) {
  const { ui } = ctx;
  const site = ctx.config.pax?.site;
  if (!site?.id || !site.grantId) return;
  const label = siteLabel(site);
  const before = !site.grantedByInstaller && site.previousRoles?.length ? site.previousRoles : undefined;
  const show = () => {
    for (const line of before ? restoreCommands(site, before) : revokeCommands(site)) ui.info(`  ${line}`);
  };
  if (!site.grantedByInstaller && !before) {
    ui.note(`The installer didn't give the app its access to ${label}, so it stays. An admin can take it away with:`);
    show();
    return;
  }
  const what = before ? `put the app's access to ${label} back to ${before.join(', ')}` : `take away the app's access to ${label}`;
  const signIn = canSignInForSites(ctx) && (await ui.confirm(`${what[0].toUpperCase()}${what.slice(1)}? You sign in again, with Sites.FullControl.All.`, true));
  if (!signIn) {
    ui.note(
      before
        ? `The app keeps write access to ${label}. An admin can put it back to ${before.join(', ')} with:`
        : `The app's access to ${label} stays. An admin can take it away with:`,
    );
    show();
    return;
  }
  try {
    const sites = siteAdminApi(ctx);
    const appId = ctx.config.app?.appId;
    if (!appId || !appGrant([await sites.permission(site.id, site.grantId)], appId)) {
      ui.warn(
        `The permission the install record names on ${label} (${site.grantId}) isn't the app's, so the installer left it alone and took it off the record. An admin can check the site's permissions.`,
      );
    } else if (before) {
      // The roles Graph gave the admin's permission, which held no write role.
      await sites.updateGrant(site.id, site.grantId, /** @type {('read' | 'write')[]} */ (before));
      ui.ok(`Put the app's access to ${label} back to ${before.join(', ')}`);
    } else {
      await sites.revoke(site.id, site.grantId);
      ui.ok(`Took away the app's access to ${label}`);
    }
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) {
      ui.warn(`Couldn't ${what} (${firstLine(err)}). An admin can, with:`);
      show();
      return;
    }
    ui.ok(`The app's access to ${label} was gone already`);
  }
  delete site.grantId;
  delete site.grantedByInstaller;
  delete site.previousRoles;
  delete site.left;
  ctx.save();
}

/**
 * Files that now stay on the PC no longer need the app's access to the SharePoint site they went
 * to, so the installer takes back what it gave there, or offers to, as uninstall does. It says so
 * once: access it leaves in place, an admin's or one the user keeps, is marked and left to
 * uninstall, until the files go back to SharePoint.
 * @param {Ctx} ctx
 */
export async function leaveSite(ctx) {
  const pax = ctx.config.pax;
  if (!pax?.site) return;
  const site = pax.site;
  if (pax.destination !== 'local') {
    if (site.left) {
      delete site.left;
      ctx.save();
    }
    return;
  }
  if (!site.grantId || site.left) return;
  ctx.ui.note('The files now stay on this PC, so the app no longer needs its access to the SharePoint site.');
  await revokeSiteGrant(ctx);
  if (site.grantId) {
    site.left = true;
    ctx.save();
  }
}
