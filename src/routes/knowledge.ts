import { Hono } from 'hono';
import { canManageProject } from '../../shared/permissions.ts';
import {
  DecisionCreateSchema,
  DecisionQuerySchema,
  DecisionUpdateSchema,
  DocumentCreateSchema,
  DocumentQuerySchema,
  DocumentRestoreSchema,
  DocumentUpdateSchema,
} from '../../shared/schemas.ts';
import type { Role } from '../../shared/types.ts';
import type { AppEnv } from '../app-env.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { Store } from '../store.ts';
import {
  actorOf,
  canWriteWorkspace,
  conflict,
  visibleProjectIds,
  workspaceOf,
} from './enterprise-helpers.ts';

const DocumentListQuerySchema = DocumentQuerySchema.omit({ projectId: true });

export function knowledgeRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const projectOfDocument = (id: string, workspaceId: string, role: Role, userId: string) => {
    const document = store.knowledge.getDocument(id, workspaceId);
    if (!document) return null;
    const project = store.projects.get(document.projectId, role, userId);
    return project ? { document, project } : null;
  };

  app.get('/api/projects/:id/documents', (c) => {
    const parsed = readQuery(c, DocumentListQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    const documents = store.knowledge.listDocuments(project.id, workspaceOf(user), {
      status: parsed.data.status,
      q: parsed.data.q,
    });
    if (!documents) return notFound(c, '项目不存在');
    noStore(c);
    return c.json(documents);
  });

  app.post('/api/projects/:id/documents', async (c) => {
    const user = currentUser(c);
    const project = store.projects.get(c.req.param('id'), user.role, user.id);
    if (!project) return notFound(c, '项目不存在');
    if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, DocumentCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.knowledge.createDocument(
      project.id,
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '项目不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '文档已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.document, 201);
  });

  app.get('/api/documents/:id', (c) => {
    const user = currentUser(c);
    const found = projectOfDocument(c.req.param('id'), workspaceOf(user), user.role, user.id);
    if (!found) return notFound(c, '文档不存在');
    noStore(c);
    return c.json(found.document);
  });

  app.patch('/api/documents/:id', async (c) => {
    const user = currentUser(c);
    const found = projectOfDocument(c.req.param('id'), workspaceOf(user), user.role, user.id);
    if (!found) return notFound(c, '文档不存在');
    if (!canManageProject(user.role, found.project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, DocumentUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.knowledge.updateDocument(
      found.document.id,
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '文档不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '文档已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.document);
  });

  app.get('/api/documents/:id/versions', (c) => {
    const user = currentUser(c);
    const found = projectOfDocument(c.req.param('id'), workspaceOf(user), user.role, user.id);
    if (!found) return notFound(c, '文档不存在');
    const versions = store.knowledge.listDocumentVersions(found.document.id, workspaceOf(user));
    if (!versions) return notFound(c, '文档不存在');
    noStore(c);
    return c.json(versions);
  });

  app.post('/api/documents/:id/restore', async (c) => {
    const user = currentUser(c);
    const found = projectOfDocument(c.req.param('id'), workspaceOf(user), user.role, user.id);
    if (!found) return notFound(c, '文档不存在');
    if (!canManageProject(user.role, found.project.ownerId === user.id, user.permissions)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, DocumentRestoreSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.knowledge.restoreDocument(
      found.document.id,
      workspaceOf(user),
      parsed.data.version,
      parsed.data.changeSummary,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '文档不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '文档已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.document);
  });

  app.get('/api/decisions', (c) => {
    const parsed = readQuery(c, DecisionQuerySchema);
    if (!parsed.ok) return parsed.response;
    const user = currentUser(c);
    if (parsed.data.projectId && !store.projects.get(parsed.data.projectId, user.role, user.id)) {
      return notFound(c, '项目不存在');
    }
    noStore(c);
    return c.json(
      store.knowledge.listDecisions(workspaceOf(user), {
        projectId: parsed.data.projectId,
        status: parsed.data.status,
        q: parsed.data.q,
        visible: visibleProjectIds(store, user),
      }),
    );
  });

  app.post('/api/decisions', async (c) => {
    const user = currentUser(c);
    const parsed = await readBody(c, DecisionCreateSchema);
    if (!parsed.ok) return parsed.response;
    if (parsed.data.projectId) {
      const project = store.projects.get(parsed.data.projectId, user.role, user.id);
      if (!project) return notFound(c, '项目不存在');
      if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
        return forbidden(c);
      }
    } else if (!canWriteWorkspace(user)) {
      return forbidden(c);
    }
    const result = store.knowledge.createDecision(workspaceOf(user), parsed.data, actorOf(user));
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'missing') return notFound(c, '工作区不存在');
    if (result.status === 'conflict') {
      return conflict(c, '决策已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.decision, 201);
  });

  app.get('/api/decisions/:id', (c) => {
    const user = currentUser(c);
    const decision = store.knowledge.getDecision(
      c.req.param('id'),
      workspaceOf(user),
      visibleProjectIds(store, user),
    );
    if (!decision) return notFound(c, '决策不存在');
    noStore(c);
    return c.json(decision);
  });

  app.patch('/api/decisions/:id', async (c) => {
    const user = currentUser(c);
    const id = c.req.param('id');
    const decision = store.knowledge.getDecision(
      id,
      workspaceOf(user),
      visibleProjectIds(store, user),
    );
    if (!decision) return notFound(c, '决策不存在');
    if (decision.projectId) {
      const project = store.projects.get(decision.projectId, user.role, user.id);
      if (!project) return notFound(c, '决策不存在');
      if (!canManageProject(user.role, project.ownerId === user.id, user.permissions)) {
        return forbidden(c);
      }
    } else if (!canWriteWorkspace(user)) {
      return forbidden(c);
    }
    const parsed = await readBody(c, DecisionUpdateSchema);
    if (!parsed.ok) return parsed.response;
    const result = store.knowledge.updateDecision(
      id,
      workspaceOf(user),
      parsed.data,
      actorOf(user),
    );
    if (result.status === 'missing') return notFound(c, '决策不存在');
    if (result.status === 'invalid') return validationError(c, result.message);
    if (result.status === 'conflict') {
      return conflict(c, '决策已被其他会话修改，已返回最新版本', result.current);
    }
    noStore(c);
    return c.json(result.decision);
  });

  app.get('/api/decisions/:id/versions', (c) => {
    const user = currentUser(c);
    const decision = store.knowledge.getDecision(
      c.req.param('id'),
      workspaceOf(user),
      visibleProjectIds(store, user),
    );
    if (!decision) return notFound(c, '决策不存在');
    const versions = store.knowledge.listDecisionVersions(decision.id, workspaceOf(user));
    if (!versions) return notFound(c, '决策不存在');
    noStore(c);
    return c.json(versions);
  });

  return app;
}
