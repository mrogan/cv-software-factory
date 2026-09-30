import { describe, expect, it } from 'vitest';
import { problems } from './commit-msg.ts';

describe('commit messages', () => {
  it.each([
    'feat: add the scoreboard',
    'fix(console): keep the clock in step',
    'feat(gateway)!: replay cassettes by default',
    'chore(deps): bump vitest from 5.0.2 to 5.0.3',
    'docs: explain the promotion pull request\n\nWith a body that can be as long as it likes, and Ends with a full stop.',
  ])('accepts %j', (message) => {
    expect(problems(message)).toEqual([]);
  });

  it.each(['Merge branch main', 'Revert "feat: add the scoreboard"', 'fixup! feat: add the scoreboard'])(
    'leaves messages git writes itself alone: %j',
    (message) => {
      expect(problems(message)).toEqual([]);
    },
  );

  it('ignores comment lines git adds to the message file', () => {
    expect(problems('# Please enter the commit message\nfix: close the popover')).toEqual([]);
  });

  it('rejects a message with no type', () => {
    expect(problems('Update the README')).toEqual([
      '"Update the README" should look like "type(scope): subject", for example "fix(console): keep the clock in step"',
    ]);
  });

  it('names the types when one is unknown', () => {
    expect(problems('feature: add the scoreboard')[0]).toMatch(
      /^"feature" is not a type we use; choose one of feat, fix/,
    );
  });

  it('asks for a lower-case subject without a full stop', () => {
    expect(problems('fix: Close the popover.')).toEqual([
      'start the subject in lower case',
      'leave the full stop off the subject',
    ]);
  });

  it('allows an acronym at the start of the subject', () => {
    expect(problems('fix: CSP blocks the fonts')).toEqual([]);
  });

  it('limits the first line to 100 characters', () => {
    const long = `fix: ${'a'.repeat(96)}`;
    expect(problems(long)).toEqual(['keep the first line to 100 characters (it is 101)']);
  });
});
