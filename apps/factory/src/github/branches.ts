/**
 * The branches the factory owns, and so the only ones the GitHub worker will move, delete or commit to. Everything
 * the line makes is under `factory/` (a fix is `factory/1296-prices`, the smoke run's base is `factory/smoke`); the
 * deploy pull requests keep the branches they have always had, one per pin file (`deploys.ts`). Anything else, `main`
 * and Martin's branches above all, is refused before GitHub is asked, as a patch to a protected path is: the rulesets
 * guard `main` too, and this does not lean on them.
 */
import { DEPLOYS } from './deploys.ts';

/** Where every branch the line makes starts. */
export const FACTORY_PREFIX = 'factory/';

export class BranchRefused extends Error {
  override name = 'BranchRefused';
}

export const ownsBranch = (branch: string): boolean =>
  (branch.startsWith(FACTORY_PREFIX) && branch.length > FACTORY_PREFIX.length) ||
  DEPLOYS.some((target) => target.branch === branch);

/** Throws `BranchRefused` for a branch the factory does not own. */
export function guardBranch(branch: string): void {
  if (!ownsBranch(branch)) {
    throw new BranchRefused(
      `${branch} is not the factory's: it acts only on branches under ${FACTORY_PREFIX} and its deploy branches.`,
    );
  }
}
