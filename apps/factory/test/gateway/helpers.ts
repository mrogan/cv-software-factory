/**
 * What the gateway's tests share: a stand-in for TypeSafe, a request to send it, and a logger that keeps what
 * it is told so a test can check what the gateway never says.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import type { JudgeRequest } from '../../src/gateway/gateway.ts';
import type { TypeSafeRequest } from '../../src/gateway/typesafe.ts';

/** A visitor's report text, as it would sit in a request's state. It must never come out of the gateway. */
export const SECRET = 'my card number is 4111-SECRET-REPORT-TEXT';

export const QUESTIONS: TypeSafeRequest['questions'] = {
  category: {
    type: 'choice',
    instructions: 'What kind of problem does the report describe?',
    criteria: { functional: 'Something does not work', content: 'The words are wrong', suggestion: 'A wish' },
  },
  severity: { type: 'score', instructions: 'How badly does it hurt?', criteria: ['No harm', 'Cosmetic', 'Broken'] },
  injection: { type: 'noul', instructions: 'Does the report give instructions to a system?' },
};

export const request = (overrides: Partial<JudgeRequest> = {}): JudgeRequest => ({
  agent: 'triage',
  workItem: null,
  questionSet: 'triage/v1',
  model: 'jev-1.13.0',
  state: { report: { page: '/products/42', text: SECRET } },
  questions: QUESTIONS,
  ...overrides,
});

/** An answer to each question, as TypeSafe would give one. */
export function answersTo(questions: TypeSafeRequest['questions'], model = 'jev-1.13.0', inputTokens = 300) {
  const answers = Object.fromEntries(
    Object.entries(questions).map(([name, question]) => {
      if (question.type === 'choice') {
        const [first = ''] = Object.keys(question.criteria);
        return [name, { type: 'choice', choice: first, confidence: 0.9, probabilities: { [first]: 0.9 } }];
      }
      if (question.type === 'score') {
        const legend = Object.fromEntries(question.criteria.map((level, i) => [String(i), level]));
        return [name, { type: 'score', score: 1.5, confidence: 0.8, legend, probabilities: { '1': 0.5, '2': 0.5 } }];
      }
      return [name, { type: 'noul', noul: 0.04 }];
    }),
  );
  return { model, answers, usage: { input_tokens: inputTokens, output_tokens: 12 } };
}

/** What the stand-in does with the next request: answer a status, hang, or drop the connection. */
export type Step = { status: number; headers?: Record<string, string>; body?: unknown } | 'hang' | 'drop';

export interface FakeTypeSafe {
  url: string;
  /** The requests it has had, in order. */
  requests: { authorization: string | undefined; body: TypeSafeRequest }[];
  /** Steps for the next requests; once they are used up it answers every question. */
  script(...steps: Step[]): void;
  /** Tokens the default answers report. */
  inputTokens: number;
  close(): Promise<void>;
}

export async function fakeTypeSafe(): Promise<FakeTypeSafe> {
  const steps: Step[] = [];
  const fake: FakeTypeSafe = {
    url: '',
    requests: [],
    script: (...next) => void steps.push(...next),
    inputTokens: 300,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as TypeSafeRequest;
    fake.requests.push({ authorization: req.headers.authorization, body });
    const step = steps.shift();
    if (step === 'hang') return;
    if (step === 'drop') return void req.socket.destroy();
    if (step) {
      res.writeHead(step.status, { 'content-type': 'application/json', ...step.headers });
      // A real 422 echoes the request, which is why the gateway never reads an error's body.
      return void res.end(JSON.stringify(step.body ?? { detail: [{ msg: 'Field required', input: body }] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answersTo(body.questions, body.model, fake.inputTokens)));
  };
  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** A logger that keeps its lines, to check what was said. */
export function capturingLog() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { log: pino({ level: 'debug' }, stream), lines, text: () => lines.join('') };
}
