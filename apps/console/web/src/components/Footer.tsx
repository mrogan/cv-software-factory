import { Mark } from './Mark.tsx';

declare const __BUILD__: string;

export function Footer() {
  const build = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="left">
          <Mark />
          <span>Software Factory · Martin Rogan</span>
          <a href="https://github.com/mrogan/cv-software-factory">The source</a>
          <a href="https://github.com/mrogan/cv-software-factory/blob/main/docs/INTENT.md">Why it exists</a>
        </div>
        <a className="mono" href={`https://github.com/mrogan/cv-software-factory/commit/${build}`}>
          build {build.slice(0, 7)}
        </a>
      </div>
    </footer>
  );
}
