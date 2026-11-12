import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ResourceLimits, ServerOptions } from './config.js';
import type { RuleVersionManager } from './version-manager.js';
import type { StateJournal } from './state-journal.js';

interface RouteContext {
  readonly manager: RuleVersionManager;
  readonly journal: StateJournal;
  readonly options: ServerOptions;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function readLimitedBody(request: IncomingMessage, response: ServerResponse, limits: ResourceLimits): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('请求处理超时'), { statusCode: 408, code: 'request-timeout' }));
      request.destroy();
    }, limits.requestTimeoutMs);
    timer.unref?.();

    const fail = (statusCode: number, code: string, message: string): void => {
      if (rejected) return;
      rejected = true;
      clearTimeout(timer);
      // 排空已到达的数据再结束，避免直接 reset 让客户端拿到连接错误而不是明确状态码。
      request.resume();
      if (!response.headersSent) {
        sendJson(response, statusCode, { error: code, message });
      }
      reject(Object.assign(new Error(message), { statusCode, code, handled: true }));
    };

    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limits.maxBodyBytes) {
        fail(413, 'payload-too-large', `请求体超过 ${limits.maxBodyBytes} 字节上限`);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', (error) => {
      if (rejected) return;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function currentStatus(ctx: RouteContext) {
  const service = ctx.manager.attributeService;
  return {
    status: 'ready',
    activeVersion: ctx.manager.activeVersion,
    versionLabel: ctx.manager.activeBundle.label,
    state: service.getState(),
    attributes: service.listAttributes().map((entry) => ({
      id: entry.id,
      label: entry.label,
      value: entry.value,
    })),
    limits: ctx.options.limits,
  };
}

async function router(request: IncomingMessage, response: ServerResponse, ctx: RouteContext): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = request.method ?? 'GET';
  const service = ctx.manager.attributeService;

  if (method === 'GET' && (path === '/health' || path === '/ready')) {
    sendJson(response, 200, currentStatus(ctx));
    return;
  }

  if (method === 'GET' && path === '/version') {
    sendJson(response, 200, {
      activeVersion: ctx.manager.activeVersion,
      label: ctx.manager.activeBundle.label,
      createdAt: ctx.manager.activeBundle.createdAt,
      revision: service.getState().revision,
    });
    return;
  }

  if (method === 'GET' && path === '/attributes') {
    sendJson(response, 200, {
      activeVersion: ctx.manager.activeVersion,
      revision: service.getState().revision,
      attributes: service.listAttributes(),
    });
    return;
  }

  if (method === 'GET' && path.startsWith('/attributes/')) {
    const id = decodeURIComponent(path.slice('/attributes/'.length));
    try {
      sendJson(response, 200, {
        activeVersion: ctx.manager.activeVersion,
        revision: service.getState().revision,
        attribute: id,
        value: service.getValue(id),
        explanation: service.explain(id),
      });
    } catch (error) {
      sendJson(response, 404, { error: 'unknown-attribute', message: (error as Error).message });
    }
    return;
  }

  if (method === 'POST' && path === '/query') {
    const raw = await readLimitedBody(request, response, ctx.options.limits);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(response, 400, { error: 'malformed-json', message: '请求体不是合法 JSON' });
      return;
    }
    const ids = (body as { attributes?: unknown })?.attributes;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      sendJson(response, 400, { error: 'malformed-request', message: 'attributes 必须是字符串数组' });
      return;
    }
    try {
      const values = service.getValues(ids as string[]);
      sendJson(response, 200, {
        activeVersion: ctx.manager.activeVersion,
        revision: service.getState().revision,
        tick: service.getState().tick,
        values,
      });
    } catch (error) {
      sendJson(response, 404, { error: 'unknown-attribute', message: (error as Error).message });
    }
    return;
  }

  if (method === 'GET' && path === '/loadouts') {
    sendJson(response, 200, { loadouts: service.listLoadouts(), active: service.getActiveLoadoutId() });
    return;
  }

  if (method === 'POST' && path === '/loadouts/switch') {
    const raw = await readLimitedBody(request, response, ctx.options.limits);
    const body = JSON.parse(raw) as { loadoutId?: unknown };
    if (typeof body.loadoutId !== 'string') {
      sendJson(response, 400, { error: 'malformed-request', message: 'loadoutId 必须是字符串' });
      return;
    }
    const result = service.switchLoadout(body.loadoutId);
    sendJson(response, result.accepted ? 200 : 422, {
      ...result,
      activeVersion: ctx.manager.activeVersion,
      values: result.accepted ? service.listAttributes().map((a) => ({ id: a.id, value: a.value })) : undefined,
    });
    return;
  }

  /**
   * 候选规则热替换。先在版本管理器里隔离校验，失败时活动版本不变，
   * 并把结构化原因写入状态记录；绝不会把空属性表发布给调用方。
   */
  if (method === 'POST' && path === '/rules/reload') {
    const raw = await readLimitedBody(request, response, ctx.options.limits);
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      sendJson(response, 400, { error: 'malformed-json', message: '候选规则不是合法 JSON' });
      return;
    }
    const before = ctx.manager.activeVersion;
    const adoption = ctx.manager.adopt(document);
    if (!adoption.ok) {
      await ctx.journal.append('version-rejected', {
        activeVersion: before,
        revision: adoption.revision,
        detail: `候选规则被拒绝，活动版本仍为 ${before}`,
        issues: adoption.report.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      });
      sendJson(response, 422, {
        accepted: false,
        activeVersion: before,
        revision: adoption.revision,
        issues: adoption.report.issues,
      });
      return;
    }
    await ctx.journal.append('version-adopted', {
      activeVersion: adoption.version,
      revision: adoption.revision,
      detail: `规则版本由 ${before} 切换为 ${adoption.version}`,
    });
    sendJson(response, 200, {
      accepted: true,
      previousVersion: before,
      activeVersion: adoption.version,
      revision: adoption.revision,
      attributes: service.listAttributes().map((a) => ({ id: a.id, value: a.value })),
    });
    return;
  }

  sendJson(response, 404, { error: 'not-found', message: `无此路由：${method} ${path}` });
}

export interface StartedServer {
  readonly server: Server;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export function startHttpServer(ctx: RouteContext): Promise<StartedServer> {
  const server = createServer((request, response) => {
    Promise.resolve()
      .then(() => router(request, response, ctx))
      .catch((error: { statusCode?: number; code?: string; message?: string; handled?: boolean }) => {
        // 限流/超时已在 body 读取阶段发送过明确响应，这里不再二次写入。
        if (error.handled || response.headersSent) {
          if (!response.writableEnded) response.destroy();
          return;
        }
        const status = error.statusCode ?? 500;
        sendJson(response, status, {
          error: error.code ?? 'internal-error',
          message: error.message ?? '内部错误',
          activeVersion: ctx.manager.activeVersion,
        });
      });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ctx.options.port, ctx.options.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : ctx.options.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}
