/**
 * A scripted model: a stand-in for the gateway's Messages API that answers the Agent SDK with hand-written turns, in
 * order, as Anthropic streams them. The runner's tests run the real Agent SDK against it, with no key and no network.
 *
 * Only the agent's own loop takes turns from the script: a request with no tools (Claude Code asks the model small
 * things of its own, such as a title) is answered with a word.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Turn = { text: string } | { tool: string; input: Record<string, unknown> };

let ids = 0;

function sse(content: Turn, model: string): string {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${++ids}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
    ],
  ];
  if ('text' in content) {
    events.push(
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content.text } },
      ],
    );
  } else {
    events.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: `toolu_${++ids}`, name: content.tool, input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(content.input) },
        },
      ],
    );
  }
  events.push(
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'text' in content ? 'end_turn' : 'tool_use', stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  );
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

export interface ScriptedModel {
  url: string;
  /** Every request, with the path and headers it came with. */
  requests: { path: string; headers: Record<string, unknown>; body: Record<string, unknown> }[];
  close(): Promise<void>;
}

export async function scriptedModel(script: Turn[], { repeat = false } = {}): Promise<ScriptedModel> {
  const requests: ScriptedModel['requests'] = [];
  let at = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf-8');
    const body = text ? JSON.parse(text) : {};
    requests.push({ path: req.url ?? '', headers: req.headers, body });
    if (req.url?.startsWith('/health')) return void res.end('{"status":"ok"}');
    if (!req.url?.startsWith('/v1/messages')) return void res.writeHead(404).end();
    if (req.url.includes('count_tokens')) return void res.end(JSON.stringify({ input_tokens: 100 }));
    const agentTurn = Array.isArray(body.tools) && body.tools.length > 0;
    const turn = agentTurn ? (script[repeat ? at++ % script.length : at++] ?? { text: 'Done.' }) : { text: 'Fixing' };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return void res.end(sse(turn, String(body.model)));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `msg_${++ids}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'text' in turn ? turn.text : 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
