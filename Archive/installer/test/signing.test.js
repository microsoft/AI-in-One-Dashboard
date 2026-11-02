// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXE_NAME } from '../src/launch.js';
import { RELEASE_VERSION, checkSignature, commonName, isReleaseCandidate, parseSha256, releaseNotes, sha256Line } from '../packaging/signing.js';

const HASH = '748ed2f139d14f8babdabea867a809c4fe6da12ef9da3d07ecd93dba616224db';
const MICROSOFT = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
const TIMESTAMPER = 'CN=Microsoft Public RSA Time Stamping Authority, O=Microsoft Corporation, C=US';

test('signing: the .sha256 line reads back, in the format sha256sum -c expects', () => {
  assert.equal(sha256Line(HASH.toUpperCase()), `${HASH}  ${EXE_NAME}\n`);
  assert.equal(parseSha256(sha256Line(HASH)), HASH);
  assert.equal(parseSha256(HASH.toUpperCase()), HASH);
  assert.equal(parseSha256(''), undefined);
  assert.equal(parseSha256('not a hash'), undefined);
});

test('signing: reads the common name from a certificate subject', () => {
  assert.equal(commonName(MICROSOFT), 'Microsoft Corporation');
  assert.equal(commonName('O=Contoso, CN="Contoso, Ltd", C=US'), 'Contoso, Ltd');
  assert.equal(commonName(null), undefined);
});

test('signing: a valid, timestamped Microsoft signature passes', () => {
  assert.deepEqual(checkSignature({ status: 'Valid', signer: MICROSOFT, timestamper: TIMESTAMPER }), { signed: true, ok: true, problems: [] });
});

test('signing: an unsigned exe is reported as unsigned, not as broken', () => {
  assert.deepEqual(checkSignature({ status: 'NotSigned', signer: null, timestamper: null }), { signed: false, ok: false, problems: ['it isn\'t signed'] });
});

test('signing: a broken, foreign or untimestamped signature fails', () => {
  const tampered = checkSignature({ status: 'HashMismatch', signer: MICROSOFT, timestamper: TIMESTAMPER });
  assert.equal(tampered.signed, true);
  assert.equal(tampered.ok, false);
  assert.match(tampered.problems.join(), /HashMismatch/);

  const foreign = checkSignature({ status: 'Valid', signer: 'CN=Contoso Ltd, O=Contoso Ltd', timestamper: TIMESTAMPER });
  assert.equal(foreign.ok, false);
  assert.match(foreign.problems.join(), /Contoso Ltd, not Microsoft Corporation/);
  assert.equal(checkSignature({ status: 'Valid', signer: 'CN=Contoso Ltd' }, { publisher: 'Contoso Ltd' }).ok, false);

  const noTimestamp = checkSignature({ status: 'Valid', signer: MICROSOFT, timestamper: null });
  assert.equal(noTimestamp.ok, false);
  assert.match(noTimestamp.problems.join(), /no timestamp/);
});

test('signing: unsigned release notes check the hash and send blocked users to another route, not past the warnings', () => {
  const notes = releaseNotes({ repo: 'octo/hub', sha256: HASH.toUpperCase(), signed: false });
  assert.match(notes, /https:\/\/github\.com\/octo\/hub\/blob\/main\/installer\/README\.md/);
  assert.ok(notes.includes(`\`${HASH}\``));
  assert.ok(notes.includes(`Get-FileHash .\\${EXE_NAME} -Algorithm SHA256`));
  assert.match(notes, /confirms the file is the one in this release, not who published it/);
  assert.match(notes, /don't work around it/);
  assert.match(notes, /ask your IT team/);
  assert.match(notes, /octo\/hub\/blob\/main\/installer\/README\.md#without-the-exe/);
  assert.doesNotMatch(notes, /docs\/INSTALL\.md|releases\/latest/);
  assert.doesNotMatch(notes, /Keep anyway|Run anyway|More info|Bypass|ExecutionPolicy|AllSigned/);
  assert.doesNotMatch(notes, /Digital Signatures/);
});

test('signing: signed release notes point to the signature', () => {
  const notes = releaseNotes({ repo: 'octo/hub', sha256: HASH, signed: true });
  assert.match(notes, /signed by Microsoft Corporation/);
  assert.match(notes, /\*\*Digital Signatures\*\*/);
  assert.ok(notes.includes(HASH));
  assert.doesNotMatch(notes, /Keep anyway|Run anyway/);
  assert.doesNotMatch(notes, /install\.ps1/, 'no PowerShell section without the version');
});

test('signing: release notes with a version lead with the pinned PowerShell command, and keep the exe as an option', () => {
  const notes = releaseNotes({ repo: 'octo/hub', sha256: HASH, signed: true, version: '1.2.3' });
  const cmd = 'irm https://github.com/octo/hub/releases/download/installer-v1.2.3/install.ps1 | iex';
  assert.ok(notes.includes(cmd));
  assert.ok(notes.indexOf(cmd) < notes.indexOf(`Download **${EXE_NAME}**`), 'the one-liner comes first');
  assert.ok(notes.includes('run `.\\install.ps1 -ZipPath .\\AIInOneInstaller.zip`'));
  assert.match(notes, /-UseInstalledNode/);
  assert.match(notes, /octo\/hub\/blob\/main\/installer\/README\.md#from-powershell/);
  assert.match(notes, /octo\/hub\/blob\/main\/installer\/README\.md#it-approved-nodejs/);
  assert.doesNotMatch(notes, /releases\/latest/, 'the repo\'s Latest release is the dashboard\'s');
  assert.doesNotMatch(notes, /Bypass|ExecutionPolicy|AllSigned/);
  const unsigned = releaseNotes({ repo: 'octo/hub', sha256: HASH, signed: false, version: '1.2.3' });
  assert.match(unsigned, /Use the PowerShell command above, another route/);
  assert.doesNotMatch(unsigned, /Keep anyway|Run anyway|Bypass/);
  assert.doesNotMatch(notes, /Release candidate/);
});

test('signing: a release version is x.y.z, or x.y.z-rc.N for a release candidate', () => {
  for (const v of ['0.6.8', '10.0.12', '0.6.8-rc.1', '0.6.8-rc.12']) assert.ok(RELEASE_VERSION.test(v), v);
  for (const v of ['0.6', 'v0.6.8', '0.6.8-beta', '0.6.8-rc', '0.6.8-rc.1+abc1234', '0.6.8 ']) assert.ok(!RELEASE_VERSION.test(v), v);
  assert.equal(isReleaseCandidate('0.6.8-rc.1'), true);
  assert.equal(isReleaseCandidate('0.6.8'), false);
});

test('signing: release candidate notes say it is a pre-release, and pin its own install.ps1', () => {
  const notes = releaseNotes({ repo: 'octo/hub', sha256: HASH, signed: true, version: '1.2.3-rc.2' });
  assert.ok(notes.startsWith('**Release candidate.**'), 'the notice comes first');
  assert.match(notes, /for testing 1\.2\.3 before it's released/);
  assert.ok(notes.includes('The installer doesn\'t offer it as an update.'));
  assert.doesNotMatch(notes, /releases\/latest/);
  assert.ok(notes.includes('irm https://github.com/octo/hub/releases/download/installer-v1.2.3-rc.2/install.ps1 | iex'));
});
