// Prints the turns of an agent conversation from a cassette mounted at /c: each tool call (name, short input) and
// its result size. Run in a pod with the cassettes volume at /c: node - <cassette hash prefix> < trace.js
const fs = require('node:fs');
const id = process.argv.at(-1);
const f = fs.readdirSync('/c', { recursive: true }).find((x) => x.includes(id));
const c = JSON.parse(fs.readFileSync(`/c/${f}`, 'utf8'));
const req = c.request?.body ?? c.request;
const msgs = req.messages ?? [];
const short = (s, n = 110) => String(s).replace(/\s+/g, ' ').slice(0, n);
console.log('keys:', Object.keys(c).join(','), '| messages:', msgs.length);
msgs.forEach((m, i) => {
  const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
  for (const p of parts) {
    if (p.type === 'text') console.log(i, m.role, 'text', p.text.length, short(p.text, 90));
    else if (p.type === 'tool_use') console.log(i, m.role, 'CALL', p.name, short(JSON.stringify(p.input)));
    else if (p.type === 'tool_result') {
      const t = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
      console.log(i, m.role, 'result', t.length, p.is_error ? `ERROR ${short(t, 150)}` : short(t, 70));
    } else console.log(i, m.role, p.type);
  }
});
const res = c.response?.body ?? c.response;
const rc = res?.content ?? [];
for (const p of rc)
  console.log(
    'RESPONSE',
    p.type,
    p.type === 'text'
      ? short(p.text, 300)
      : p.type === 'tool_use'
        ? `${p.name} ${short(JSON.stringify(p.input), 300)}`
        : '',
  );
