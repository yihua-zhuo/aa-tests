import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, test } from 'node:test';
import { SpecializedClient, VlmClient } from '../src/ocr-adapters.ts';

type Captured = {
  url: string;
  token: string | undefined;
  body: Record<string, unknown>;
};

const servers: Server[] = [];

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<{ url: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      captured.push({
        url: request.url ?? '',
        token: request.headers['x-ocr-token'] as string,
        body,
      });
      handler(request, response, raw);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind');
  return { url: `http://127.0.0.1:${address.port}`, captured };
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

test('VLM adapter posts the region plus context and parses the repair', async () => {
  const { url, captured } = await serve((_request, response) => {
    json(response, 200, {
      text: '  合计 1,280 元 ',
      confidence: 0.92,
      model: 'vlm-x',
      seconds: 2.8,
      engine: 'vlm',
    });
  });
  const client = new VlmClient({ url, token: 'secret', model: 'vlm-x' });
  assert.equal(client.configured, true);
  const bbox = { x: 10, y: 40, width: 200, height: 30 };
  const result = await client.repair({
    path: '/tmp/report.png',
    name: 'report.png',
    page: 2,
    bbox,
    kind: 'amount',
    context: '合计 1,2?0 元',
  });

  assert.deepEqual(result, {
    text: '合计 1,280 元',
    confidence: 0.92,
    model: 'vlm-x',
    seconds: 2.8,
    engine: 'vlm',
  });
  assert.equal(captured[0]?.url, '/repair');
  assert.equal(captured[0]?.token, 'secret');
  assert.equal(captured[0]?.body.page, 2);
  assert.deepEqual(captured[0]?.body.bbox, bbox);
  assert.equal(captured[0]?.body.kind, 'amount');
  assert.equal(captured[0]?.body.context, '合计 1,2?0 元');
  assert.equal(captured[0]?.body.padding, 0.35);
  assert.equal(captured[0]?.body.model, 'vlm-x');
});

test('specialized adapter posts the region category', async () => {
  const { url, captured } = await serve((_request, response) => {
    json(response, 200, {
      text: '合同专用章',
      confidence: 0.8,
      model: 'special-v1',
      seconds: 0.4,
      engine: 'specialized',
    });
  });
  const client = new SpecializedClient({ url, token: 'token-2' });
  const bbox = { x: 700, y: 1100, width: 180, height: 180 };
  const result = await client.recognize({
    path: '/tmp/report.png',
    name: 'report.png',
    page: 1,
    bbox,
    type: 'stamp',
  });

  assert.equal(result.text, '合同专用章');
  assert.equal(captured[0]?.url, '/recognize');
  assert.equal(captured[0]?.token, 'token-2');
  assert.equal(captured[0]?.body.type, 'stamp');
  assert.deepEqual(captured[0]?.body.bbox, bbox);
});

test('adapters surface HTTP errors and empty bodies', async () => {
  let mode: 'error' | 'empty' = 'error';
  const { url } = await serve((_request, response) => {
    if (mode === 'error') {
      json(response, 503, { message: '模型未加载' });
      return;
    }
    json(response, 200, { text: '   ' });
  });
  const client = new VlmClient({ url });
  const input = {
    path: '/tmp/a.png',
    name: 'a.png',
    page: 1,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
  };
  await assert.rejects(client.repair(input), /vlm: 模型未加载/);
  mode = 'empty';
  await assert.rejects(client.repair(input), /vlm: empty response/);
});

test('unconfigured adapters stay inert', async () => {
  const vlm = new VlmClient({ url: '' });
  const specialized = new SpecializedClient({ url: '' });
  assert.equal(vlm.configured, false);
  assert.equal(specialized.configured, false);
  await assert.rejects(
    vlm.repair({
      path: '/tmp/a.png',
      name: 'a.png',
      page: 1,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    }),
    /未配置 VLM 服务/,
  );
  await assert.rejects(
    specialized.recognize({
      path: '/tmp/a.png',
      name: 'a.png',
      page: 1,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      type: 'chart',
    }),
    /未配置专用区域识别服务/,
  );
});
