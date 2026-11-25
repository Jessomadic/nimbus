import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Test-only: allocate unique attempts and retain all prior evidence.
export function artifactDirectory(suite, {exportRoot=process.env.NIMBUS_TEST_ARTIFACTS}={}) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(suite)) throw new Error('Invalid artifact suite');
  const root=exportRoot ? path.resolve(exportRoot) : os.tmpdir();
  fs.mkdirSync(root,{recursive:true});
  const canonical=fs.realpathSync(root);
  const directory=fs.mkdtempSync(path.join(canonical,'nimbus-'+suite+'-'));
  if (path.dirname(fs.realpathSync(directory))!==canonical) throw new Error('Artifact root escape');
  console.log('[test artifacts] '+suite+': '+directory);
  return directory;
}
