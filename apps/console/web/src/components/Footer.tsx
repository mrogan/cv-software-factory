import { doorHref } from '../admin.ts';
import { Glyph } from './Glyph.tsx';
import { LogoMark } from './Logos.tsx';
import { Mark } from './Mark.tsx';

declare const __BUILD__: string;

const REPO = 'https://github.com/the-roganator/cv-software-factory';

/**
 * The foot of every page: the copyright and the licence, the source and Martin on LinkedIn, and the way to the audit
 * log and the privacy page, for everyone. A visitor, where there is an admin service to sign in to, sees the key to
 * Martin's sign-in. The icons are links named in words, with the same words on a hover.
 */
export function Footer({ signIn }: { signIn: boolean }) {
  const build = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
  return (
    <footer className="foot">
      <div className="wrap">
        {/* Two groups, which a phone puts one above the other: who made it, and the pages anyone may read. */}
        <div className="left">
          <span className="foot-group">
            <Mark />
            <span>
              © 2026 Martin Rogan · <a href={`${REPO}/blob/main/LICENSE`}>MIT</a>
            </span>
            <span className="foot-icons">
              <a href={REPO} aria-label="The source on GitHub" title="The source on GitHub">
                <LogoMark name="github" className="logo foot-icon" />
              </a>
              <a
                href="https://www.linkedin.com/in/martinrogan/"
                aria-label="Martin Rogan on LinkedIn"
                title="Martin Rogan on LinkedIn"
              >
                <LogoMark name="linkedin" className="logo foot-icon" />
              </a>
            </span>
          </span>
          <span className="foot-group">
            <a href="?view=audit">Audit log</a>
            <a href="?view=privacy">Privacy</a>
            {signIn && (
              <a href={doorHref('sign-in')} className="foot-key" aria-label="Martin’s sign-in" title="Martin’s sign-in">
                <Glyph name="key" className="glyph foot-icon" />
              </a>
            )}
          </span>
        </div>
        <a className="mono" href={`${REPO}/commit/${build}`}>
          build {build.slice(0, 7)}
        </a>
      </div>
    </footer>
  );
}
