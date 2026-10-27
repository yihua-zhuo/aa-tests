import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app-env.ts';
import { openApiDocument } from '../src/openapi.ts';
import { testApp, testStore } from './helpers.ts';

type Operation = {
  summary?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: {
    name: string;
    in: 'path' | 'query';
    required?: boolean;
    schema?: Record<string, unknown>;
  }[];
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: Record<string, unknown> }>;
  };
  responses?: Record<string, unknown>;
};

type Spec = {
  openapi: string;
  info: { title: string; version: string };
  security?: unknown[];
  tags?: { name: string; description?: string }[];
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    schemas: Record<string, Record<string, unknown>>;
  };
  paths: Record<string, Record<string, Operation>>;
};

const HTTP_METHODS = new Set(['get', 'post', 'patch', 'delete']);

const PUBLIC_OPERATIONS = new Set([
  'GET /api/health',
  'GET /api/health/ready',
  'GET /metrics',
  'GET /api/openapi.json',
  'GET /api/doc',
  'GET /api/auth/demo-users',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/mfa',
  'POST /api/auth/password-reset/request',
  'POST /api/auth/password-reset/confirm',
  'GET /files/attachments/{id}',
  'GET /api/portal/{token}',
  'POST /api/portal/{token}/requests',
  'PATCH /api/portal/{token}/requests/{id}',
  'GET /api/portal/{token}/requests/{id}/comments',
  'POST /api/portal/{token}/requests/{id}/comments',
  'POST /api/portal/{token}/requests/{id}/confirm',
]);

const SESSION_ONLY_OPERATIONS = new Set([
  'GET /api/profile/tokens',
  'POST /api/profile/tokens',
  'DELETE /api/profile/tokens/{id}',
  'GET /api/profile/webhooks',
  'POST /api/profile/webhooks',
  'PATCH /api/profile/webhooks/{id}',
  'DELETE /api/profile/webhooks/{id}',
  'GET /api/profile/webhooks/{id}/deliveries',
  'POST /api/profile/email',
  'POST /api/profile/delete',
  'POST /api/profile/password',
  'GET /api/profile/mfa',
  'POST /api/profile/mfa/setup',
  'POST /api/profile/mfa/enable',
  'POST /api/profile/mfa/disable',
  'GET /api/sessions',
  'DELETE /api/sessions/{id}',
  'POST /api/sessions/revoke-others',
  'GET /api/ops',
  'GET /api/ops/integrity',
  'POST /api/ops/backups',
  'POST /api/ops/restore',
  'PATCH /api/ops/settings',
  'PATCH /api/ops/features/{key}',
  'POST /api/ops/demo-data',
  'GET /api/ops/users/{id}/export',
  'POST /api/ops/users/{id}/erase',
]);

function documentedOperations(spec: Spec): Set<string> {
  const result = new Set<string>();
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.has(method)) result.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return result;
}

function mountedOperations(app: Hono<AppEnv>): Set<string> {
  const result = new Set<string>();
  for (const route of app.routes) {
    const method = route.method.toLowerCase();
    if (!HTTP_METHODS.has(method)) continue;
    if (route.path.includes('*')) continue;
    result.add(`${method.toUpperCase()} ${route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
  }
  return result;
}

function collectRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string') refs.add(child);
    else collectRefs(child, refs);
  }
}

function operationAt(spec: Spec, path: string, method: string): Operation {
  const operation = spec.paths[path]?.[method];
  assert.ok(operation, `expected ${method.toUpperCase()} ${path} in the OpenAPI document`);
  return operation;
}

function parameter(operation: Operation, name: string, location: 'path' | 'query') {
  return operation.parameters?.find((item) => item.name === name && item.in === location);
}

describe('OpenAPI document', () => {
  const store = testStore();
  const { app } = testApp(store);
  const spec = openApiDocument() as unknown as Spec;

  after(() => store.close());

  test('is served by the app and matches every mounted route', async () => {
    const response = await app.request('/api/openapi.json');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(spec)));
  });

  test('documents exactly the routes Hono mounts, minus middleware', () => {
    const documented = documentedOperations(spec);
    const mounted = mountedOperations(app);
    const missing = [...mounted].filter((route) => !documented.has(route)).sort();
    const stale = [...documented].filter((route) => !mounted.has(route)).sort();
    assert.deepEqual(missing, [], `undocumented routes: ${missing.join(', ')}`);
    assert.deepEqual(stale, [], `documented but not mounted: ${stale.join(', ')}`);
  });

  test('every operation has a summary, tags, parameters and responses', () => {
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const label = `${method.toUpperCase()} ${path}`;
        assert.ok(operation.summary, `${label} is missing a summary`);
        assert.ok(operation.tags?.length, `${label} is missing tags`);
        assert.ok(operation.responses?.['200'], `${label} needs a 200 response`);
        assert.ok(operation.responses?.default, `${label} needs a default error response`);

        const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
        for (const name of pathNames) {
          const param = parameter(operation, name, 'path');
          assert.ok(param, `${label} is missing path parameter ${name}`);
          assert.equal(param.required, true, `${label} path parameter ${name} must be required`);
        }
        for (const param of operation.parameters ?? []) {
          if (param.in === 'path') continue;
          assert.ok(param.schema, `${label} query parameter ${param.name} needs a schema`);
        }
      }
    }
  });

  test('security is inherited but public and session-only endpoints opt out', () => {
    assert.deepEqual(spec.security, [{ cookieAuth: [] }, { bearerAuth: [] }]);
    assert.equal(spec.components.securitySchemes.cookieAuth?.in, 'cookie');
    assert.equal(spec.components.securitySchemes.cookieAuth?.name, 'np_session');
    assert.equal(spec.components.securitySchemes.bearerAuth?.type, 'http');
    assert.equal(spec.components.securitySchemes.bearerAuth?.scheme, 'bearer');

    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!HTTP_METHODS.has(method)) continue;
        const label = `${method.toUpperCase()} ${path}`;
        if (PUBLIC_OPERATIONS.has(label)) {
          assert.deepEqual(operation.security, [], `${label} should not require a session`);
        } else if (SESSION_ONLY_OPERATIONS.has(label)) {
          assert.deepEqual(
            operation.security,
            [{ cookieAuth: [] }],
            `${label} must reject bearer tokens`,
          );
        } else {
          assert.equal(operation.security, undefined, `${label} should inherit session or token`);
        }
      }
    }
  });

  test('request schemas are generated from the shared Zod definitions', () => {
    const login = operationAt(spec, '/api/auth/login', 'post');
    assert.equal(login.requestBody?.required, true);
    assert.deepEqual(login.requestBody?.content['application/json']?.schema, {
      $ref: '#/components/schemas/Login',
    });
    const loginSchema = spec.components.schemas.Login as
      | {
          required?: string[];
          properties?: Record<string, unknown>;
        }
      | undefined;
    assert.deepEqual(loginSchema?.required?.sort(), ['email', 'password']);
    assert.ok(loginSchema?.properties?.email, 'Login schema should document the email field');

    const create = operationAt(spec, '/api/projects', 'post');
    assert.deepEqual(create.requestBody?.content['application/json']?.schema, {
      $ref: '#/components/schemas/ProjectCreate',
    });
    const projectCreate = spec.components.schemas.ProjectCreate as {
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
    };
    assert.deepEqual(progressKeys(projectCreate.properties?.status), [
      'active',
      'archived',
      'completed',
      'on_hold',
      'planning',
    ]);

    const importRoute = operationAt(spec, '/api/projects/import', 'post');
    assert.ok(importRoute.requestBody?.content['multipart/form-data']);
  });

  test('query parameters reflect Zod defaults, enums and required fields', () => {
    const search = operationAt(spec, '/api/search', 'get');
    const q = parameter(search, 'q', 'query');
    assert.equal(q?.required, true);
    assert.deepEqual(q?.schema, { type: 'string', minLength: 1, maxLength: 120 });

    const projects = operationAt(spec, '/api/projects', 'get');
    assert.equal(parameter(projects, 'page', 'query')?.required, undefined);
    assert.equal(parameter(projects, 'page', 'query')?.schema?.default, 1);
    assert.equal(parameter(projects, 'pageSize', 'query')?.schema?.maxLength, undefined);
    assert.deepEqual(parameter(projects, 'status', 'query')?.schema?.enum, [
      'all',
      'planning',
      'active',
      'on_hold',
      'completed',
      'archived',
    ]);

    const revenue = operationAt(spec, '/api/analytics/revenue', 'get');
    assert.deepEqual(parameter(revenue, 'compare', 'query')?.schema?.enum, ['0', '1']);
    assert.ok(parameter(revenue, 'granularity', 'query'));
  });

  test('every component is a valid JSON Schema and every $ref resolves', () => {
    const refs = new Set<string>();
    collectRefs(spec, refs);
    for (const ref of refs) {
      const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
      assert.ok(match, `unsupported $ref ${ref}`);
      assert.ok(spec.components.schemas[match[1] as string], `unresolved $ref ${ref}`);
    }
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      assert.equal(schema.$schema, undefined, `${name} should not embed $schema`);
      assert.ok(
        schema.type === 'object' || typeof schema.$ref === 'string',
        `${name} should describe an object`,
      );
    }
    assert.ok(spec.components.schemas.Error, 'the shared error component is required');
  });
});

function progressKeys(schema: { enum?: string[] } | undefined): string[] | undefined {
  return schema?.enum ? [...schema.enum].sort() : undefined;
}
