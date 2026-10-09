/**
 * After the move to the private store (docs/PAYWALL.md): delete the census files from the PUBLIC store, so the old
 * public URLs stop working. Refuses unless the private store already holds every file the public one does.
 *
 *   BLOB_READ_WRITE_TOKEN=… CENSUS_BLOB_TOKEN=… pnpm census:delete-public --yes
 *
 * Without --yes it only reports. Normally run from GitHub → Actions → "census storage".
 */
import { deletePublicCopies } from '@aegis/census/node';

deletePublicCopies({ yes: process.argv.includes('--yes') }).catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
