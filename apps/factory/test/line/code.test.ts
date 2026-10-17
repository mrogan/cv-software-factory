import { describe, expect, it } from 'vitest';
import { outsideCode } from '../../src/line/agents/code.ts';

const lines = (...l: string[]) => l.join('\n');
const spaces = (text: string) => text.replace(/[^\n]/g, ' ');

describe('Markdown outside code', () => {
  it('blanks inline code of any number of backticks, and keeps what stood beside it in place', () => {
    expect(outsideCode('a `b` c')).toBe('a     c');
    expect(outsideCode('a ``b ` c`` d')).toBe(`a ${spaces('``b ` c``')} d`);
    expect(outsideCode('a `b\nc` d')).toBe('a   \n   d');
  });

  it('leaves a run of backticks with no run as long to close it, and a span across a blank line, as text', () => {
    expect(outsideCode('a ``b` c')).toBe('a ``b` c');
    expect(outsideCode('a `b\n\nc` d')).toBe('a `b\n\nc` d');
  });

  it('blanks fenced code, fences included, closed by the same character at least as long with nothing after', () => {
    const fenced = lines('````', '```', '~~~', '```` not yet', '`````', 'after');
    expect(outsideCode(fenced)).toBe(lines(...spaces(fenced).split('\n').slice(0, 5), 'after'));
    const tilde = lines('~~~', '```', '~~~', 'after');
    expect(outsideCode(tilde)).toBe(lines('   ', '   ', '   ', 'after'));
  });

  it('knows a fence indented by three spaces at most, or inside a quote', () => {
    expect(outsideCode(lines('   ```', 'code', '   ```', 'after'))).toBe(lines('      ', '    ', '      ', 'after'));
    expect(outsideCode(lines('    ```', 'text'))).toBe(lines('    ```', 'text'));
    expect(outsideCode(lines('> ```', '> code', '> ```', 'after'))).toBe(lines('     ', '      ', '     ', 'after'));
  });

  it('runs a fence left open to the end, as CommonMark does', () => {
    expect(outsideCode(lines('before', '```', 'code', '`x` and more'))).toBe(
      lines('before', '   ', '    ', '            '),
    );
  });

  it('reads a backtick fence with a backtick after it as inline code', () => {
    expect(outsideCode('```npm test``` runs it')).toBe(`${spaces('```npm test```')} runs it`);
  });
});
