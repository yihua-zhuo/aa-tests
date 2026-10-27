import { Hono } from 'hono';
import {
  AnomalyDetectSchema,
  AnomalyDismissSchema,
  ApprovalCreateSchema,
  ApprovalDecisionSchema,
  ApprovalMetricsQuerySchema,
  ApprovalRoutingRuleCreateSchema,
  ApprovalWithdrawSchema,
  AutomationRollbackSchema,
  BackgroundJobCreateSchema,
  BackgroundJobTickSchema,
  BaselineCreateSchema,
  BaselineDecisionSchema,
  BenefitRecordSchema,
  BudgetApprovalSchema,
  BudgetCategoryCreateSchema,
  BudgetCategoryUpdateSchema,
  CapacityPlanSchema,
  CapacityProfileUpdateSchema,
  CapacityQuerySchema,
  CapacityScenarioSchema,
  ChangeRequestCommentSchema,
  ChangeRequestDecisionSchema,
  ChangeRequestImplementSchema,
  ChannelMessageCreateSchema,
  ChannelMessageUpdateSchema,
  ChannelSearchQuerySchema,
  ClosureCreateSchema,
  ClosureReopenSchema,
  ConnectorCallSchema,
  ConnectorOAuthCallbackSchema,
  ConnectorOAuthStartSchema,
  ConnectorRotateSchema,
  DeliverableReviewSchema,
  DeliverableVersionCreateSchema,
  DepartmentCreateSchema,
  DispatchAcceptSchema,
  DispatchBatchSchema,
  DispatchRecommendSchema,
  DocumentCommentCreateSchema,
  DocumentCommentResolveSchema,
  DocumentDiffQuerySchema,
  EstimateScaleCreateSchema,
  EventPublishSchema,
  EventSubscriptionCreateSchema,
  FormValuesPutSchema,
  FunnelQuerySchema,
  GateDecisionSchema,
  HandoffCreateSchema,
  HandoffDecisionSchema,
  HealthConfigSchema,
  JitPostReviewSchema,
  JitUsageSchema,
  KnowledgeGraphQuerySchema,
  KnowledgeLinkCreateSchema,
  KnowledgeSearchQuerySchema,
  KnowledgeSynonymCreateSchema,
  LineageCreateSchema,
  MeetingActionConvertSchema,
  MeetingCompleteSchema,
  OrganizationCreateSchema,
  OrgMembershipCreateSchema,
  PermissionSampleRunSchema,
  PlaybookFeedbackSchema,
  PortalAccountCreateSchema,
  PortalCreateSchema,
  PortalDeliveryConfirmSchema,
  PortalInternalCommentSchema,
  PortalRequestCommentSchema,
  PortalRequestCreateSchema,
  PortalRequestUpdateSchema,
  QualityBatchFixSchema,
  QualityFixSchema,
  QualityRevertSchema,
  QualityScanSchema,
  QueryPreviewSchema,
  ReportSubscriptionCreateSchema,
  SandboxRunSchema,
  ScenarioCompareSchema,
  SlaTickSchema,
  TaskEstimateSchema,
  TaskSlaActionSchema,
  TaskSlaAttachSchema,
  TaskTemplateApplySchema,
  TaskTemplateCreateSchema,
  TaskTreeBulkSchema,
  TimeSummaryQuerySchema,
  TriggerFireSchema,
  WorkflowPublishSchema,
  WorkflowReplaySchema,
  WorkflowRetryNodeSchema,
  WorkflowRollbackSchema,
  WorkflowRunStartSchema,
  WorkflowTestSchema,
  WorkspaceMemberCreateSchema,
  WorkspaceSwitchSchema,
} from '../../shared/schemas.ts';
import type { AppEnv } from '../app-env.ts';
import type { ActionResult } from '../domain/actions.ts';
import { forbidden, noStore, notFound, readBody, readQuery, validationError } from '../http.ts';
import { currentUser } from '../middleware/auth.ts';
import type { Store } from '../store.ts';
import { conflict } from './enterprise-helpers.ts';

function send<T>(c: Parameters<typeof validationError>[0], result: ActionResult<T>, status = 200) {
  if (!result.ok) {
    if (result.status === 400) return validationError(c, result.message);
    if (result.status === 403) return forbidden(c);
    if (result.status === 404) return notFound(c, result.message);
    if (result.status === 409) return conflict(c, result.message, result.current);
    return c.json({ error: 'internal_error', message: result.message }, 500);
  }
  noStore(c);
  return c.json(result.data, status as 200);
}

export function domainActionRoutes(store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const actions = store.actions;

  app.post('/api/gates/:id/decisions', async (c) => {
    const parsed = await readBody(c, GateDecisionSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.decideGate(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.get('/api/projects/:id/health', (c) =>
    send(c, actions.latestHealth(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/projects/:id/health', (c) =>
    send(c, actions.computeHealth(currentUser(c), c.req.param('id'))),
  );

  app.get('/api/projects/:id/health/trend', (c) => {
    const limit = Number(c.req.query('limit') ?? 20);
    return send(
      c,
      actions.healthTrend(
        currentUser(c),
        c.req.param('id'),
        Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
      ),
    );
  });

  app.get('/api/projects/:id/health/config', (c) =>
    send(c, actions.healthConfig(currentUser(c), c.req.param('id'))),
  );

  app.put('/api/projects/:id/health/config', async (c) => {
    const parsed = await readBody(c, HealthConfigSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.updateHealthConfig(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/projects/:id/baselines', async (c) => {
    const parsed = await readBody(c, BaselineCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createBaseline(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/baselines/:id/decisions', async (c) => {
    const parsed = await readBody(c, BaselineDecisionSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.decideBaseline(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.get('/api/baselines/:id/variance', (c) =>
    send(c, actions.baselineVariance(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/changes/:id/decisions', async (c) => {
    const parsed = await readBody(c, ChangeRequestDecisionSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.decideChange(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.get('/api/changes/:id/comments', (c) =>
    send(c, actions.changeRequestComments(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/changes/:id/comments', async (c) => {
    const parsed = await readBody(c, ChangeRequestCommentSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.commentChangeRequest(currentUser(c), c.req.param('id'), parsed.data),
      201,
    );
  });

  app.post('/api/changes/:id/implement', async (c) => {
    const parsed = await readBody(c, ChangeRequestImplementSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.implementChangeRequest(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.put('/api/capacity/profiles/:userId', async (c) => {
    const parsed = await readBody(c, CapacityProfileUpdateSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.updateCapacityProfile(currentUser(c), c.req.param('userId'), parsed.data),
    );
  });

  app.get('/api/capacity', (c) => {
    const parsed = readQuery(c, CapacityQuerySchema);
    if (!parsed.ok) return parsed.response;
    const to = parsed.data.to ?? new Date().toISOString().slice(0, 10);
    const from =
      parsed.data.from ??
      new Date(Date.parse(`${to}T00:00:00.000Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    return send(c, actions.capacity(currentUser(c), from, to));
  });

  app.post('/api/capacity/scenarios', async (c) => {
    const parsed = await readBody(c, CapacityScenarioSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.capacityScenario(currentUser(c), parsed.data));
  });

  app.get('/api/capacity/plan', (c) => {
    const parsed = readQuery(c, CapacityPlanSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.capacityPlan(currentUser(c), parsed.data));
  });

  app.get('/api/projects/:id/closure', (c) =>
    send(c, actions.projectClosure(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/projects/:id/closure', async (c) => {
    const parsed = await readBody(c, ClosureCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.closeProject(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/closures/:id/reopen', async (c) => {
    const parsed = await readBody(c, ClosureReopenSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.reopenClosure(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/benefit-reviews/:id/records', async (c) => {
    const parsed = await readBody(c, BenefitRecordSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.recordBenefit(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/tasks/:id/sla', async (c) => {
    const parsed = await readBody(c, TaskSlaAttachSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.attachSla(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/tasks/:id/sla/:action', async (c) => {
    const action = c.req.param('action');
    if (
      action !== 'pause' &&
      action !== 'resume' &&
      action !== 'escalate' &&
      action !== 'respond' &&
      action !== 'review'
    ) {
      return notFound(c, '未知的 SLA 操作');
    }
    const parsed = await readBody(c, TaskSlaActionSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.slaAction(currentUser(c), c.req.param('id'), action, parsed.data));
  });

  app.post('/api/sla/tick', async (c) => {
    const parsed = await readBody(c, SlaTickSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.tickSla(currentUser(c), parsed.data));
  });

  app.post('/api/benefit-reviews/tick', (c) => send(c, actions.tickBenefitReviews(currentUser(c))));

  app.post('/api/documents/tick-reminders', (c) =>
    send(c, actions.tickDocumentReminders(currentUser(c))),
  );

  app.put('/api/tasks/:id/forms/:formId', async (c) => {
    const parsed = await readBody(c, FormValuesPutSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.putFormValues(currentUser(c), c.req.param('id'), c.req.param('formId'), parsed.data),
    );
  });

  app.post('/api/dispatch/recommend', async (c) => {
    const parsed = await readBody(c, DispatchRecommendSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.recommendDispatch(currentUser(c), parsed.data), 201);
  });

  app.post('/api/dispatch/decision', async (c) => {
    const parsed = await readBody(c, DispatchAcceptSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.decideDispatch(currentUser(c), parsed.data));
  });

  app.post('/api/dispatch/batch', async (c) => {
    const parsed = await readBody(c, DispatchBatchSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.decideDispatchBatch(currentUser(c), parsed.data));
  });

  app.post('/api/tasks/:id/handoffs', async (c) => {
    const parsed = await readBody(c, HandoffCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createHandoff(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/handoffs/:id/decision', async (c) => {
    const parsed = await readBody(c, HandoffDecisionSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.decideHandoff(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/handoffs/tick', (c) => send(c, actions.tickHandoffs(currentUser(c))));

  app.post('/api/deliverables/:id/versions', async (c) => {
    const parsed = await readBody(c, DeliverableVersionCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.addDeliverableVersion(currentUser(c), c.req.param('id'), parsed.data),
      201,
    );
  });

  app.post('/api/deliverables/:id/reviews', async (c) => {
    const parsed = await readBody(c, DeliverableReviewSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.reviewDeliverable(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/meetings/:id/complete', async (c) => {
    const parsed = await readBody(c, MeetingCompleteSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.completeMeeting(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/meeting-actions/:id/convert', async (c) => {
    const parsed = await readBody(c, MeetingActionConvertSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.convertMeetingAction(currentUser(c), c.req.param('id'), parsed.data),
      201,
    );
  });

  app.post('/api/tasks/tree/bulk', async (c) => {
    const parsed = await readBody(c, TaskTreeBulkSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.taskTreeBulk(currentUser(c), parsed.data));
  });

  app.patch('/api/tasks/:id/estimate', async (c) => {
    const parsed = await readBody(c, TaskEstimateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.updateEstimate(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.get('/api/task-templates', (c) => send(c, actions.listTaskTemplates(currentUser(c))));

  app.post('/api/task-templates', async (c) => {
    const parsed = await readBody(c, TaskTemplateCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createTaskTemplate(currentUser(c), parsed.data), 201);
  });

  app.delete('/api/task-templates/:id', (c) =>
    send(c, actions.deleteTaskTemplate(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/task-templates/:id/apply', async (c) => {
    const parsed = await readBody(c, TaskTemplateApplySchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.applyTaskTemplate(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.get('/api/estimate-scales', (c) => send(c, actions.listEstimateScales(currentUser(c))));

  app.post('/api/estimate-scales', async (c) => {
    const parsed = await readBody(c, EstimateScaleCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createEstimateScale(currentUser(c), parsed.data), 201);
  });

  app.get('/api/time/summary', (c) => {
    const parsed = readQuery(c, TimeSummaryQuerySchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.timeSummary(currentUser(c), parsed.data.projectId, parsed.data.taskId));
  });

  app.post('/api/knowledge/links', async (c) => {
    const parsed = await readBody(c, KnowledgeLinkCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.addKnowledgeLink(currentUser(c), parsed.data), 201);
  });

  app.get('/api/knowledge/graph', (c) => {
    const parsed = readQuery(c, KnowledgeGraphQuerySchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.knowledgeGraph(currentUser(c), parsed.data));
  });

  app.get('/api/knowledge/search', (c) => {
    const parsed = readQuery(c, KnowledgeSearchQuerySchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.knowledgeSearch(currentUser(c), parsed.data));
  });

  app.get('/api/knowledge/review', (c) => send(c, actions.knowledgeReviewQueue(currentUser(c))));

  app.get('/api/knowledge/synonyms', (c) => send(c, actions.listKnowledgeSynonyms(currentUser(c))));

  app.post('/api/knowledge/synonyms', async (c) => {
    const parsed = await readBody(c, KnowledgeSynonymCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createKnowledgeSynonym(currentUser(c), parsed.data), 201);
  });

  app.delete('/api/knowledge/synonyms/:term', (c) =>
    send(c, actions.deleteKnowledgeSynonym(currentUser(c), c.req.param('term'))),
  );

  app.get('/api/documents/:id/comments', (c) =>
    send(c, actions.listDocumentComments(currentUser(c), c.req.param('id'))),
  );

  app.get('/api/documents/:id/diff', (c) => {
    const parsed = readQuery(c, DocumentDiffQuerySchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.documentDiff(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/documents/:id/comments', async (c) => {
    const parsed = await readBody(c, DocumentCommentCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.createDocumentComment(currentUser(c), c.req.param('id'), parsed.data),
      201,
    );
  });

  app.post('/api/document-comments/:id/decisions', async (c) => {
    const parsed = await readBody(c, DocumentCommentResolveSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.resolveDocumentComment(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/channels/:id/subscription', (c) =>
    send(c, actions.subscribeChannel(currentUser(c), c.req.param('id'))),
  );

  app.delete('/api/channels/:id/subscription', (c) =>
    send(c, actions.unsubscribeChannel(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/channels/:id/messages', async (c) => {
    const parsed = await readBody(c, ChannelMessageCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.postChannelMessage(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.get('/api/channels/:id/messages/search', (c) => {
    const parsed = readQuery(c, ChannelSearchQuerySchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.searchChannelMessages(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.patch('/api/channel-messages/:id', async (c) => {
    const parsed = await readBody(c, ChannelMessageUpdateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.updateChannelMessage(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/channel-messages/:id/task', (c) => {
    const projectId = c.req.query('projectId');
    return send(
      c,
      actions.messageToTask(
        currentUser(c),
        c.req.param('id'),
        projectId && projectId.length > 0 ? projectId : undefined,
      ),
      201,
    );
  });

  app.post('/api/retrospectives/:id/publish', (c) =>
    send(c, actions.publishRetro(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/playbooks/:id/feedback', async (c) => {
    const parsed = await readBody(c, PlaybookFeedbackSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.playbookFeedback(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/projects/:id/portals', async (c) => {
    const parsed = await readBody(c, PortalCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createPortal(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/portals/:id/accounts', async (c) => {
    const parsed = await readBody(c, PortalAccountCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.createPortalAccount(currentUser(c), c.req.param('id'), parsed.data),
      201,
    );
  });

  app.get('/api/portal/:token', (c) => send(c, actions.portalView(c.req.param('token'))));

  app.post('/api/portal/:token/requests', async (c) => {
    const parsed = await readBody(c, PortalRequestCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.portalSubmit(c.req.param('token'), parsed.data), 201);
  });

  app.patch('/api/portal/:token/requests/:id', async (c) => {
    const parsed = await readBody(c, PortalRequestUpdateSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.portalUpdateRequest(c.req.param('token'), c.req.param('id'), parsed.data),
    );
  });

  app.get('/api/portal/:token/requests/:id/comments', (c) =>
    send(c, actions.portalRequestComments(c.req.param('token'), c.req.param('id'))),
  );

  app.post('/api/portal/:token/requests/:id/comments', async (c) => {
    const parsed = await readBody(c, PortalRequestCommentSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.portalAddComment(c.req.param('token'), c.req.param('id'), parsed.data),
      201,
    );
  });

  app.post('/api/portal/:token/requests/:id/confirm', async (c) => {
    const parsed = await readBody(c, PortalDeliveryConfirmSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.portalConfirmDelivery(c.req.param('token'), c.req.param('id'), parsed.data),
    );
  });

  app.get('/api/portals/:id/requests', (c) =>
    send(c, actions.listPortalRequests(currentUser(c), c.req.param('id'))),
  );

  app.get('/api/portal-requests/:id/comments', (c) =>
    send(c, actions.staffPortalRequestComments(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/portal-requests/:id/comments', async (c) => {
    const parsed = await readBody(c, PortalInternalCommentSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.addPortalInternalComment(currentUser(c), c.req.param('id'), parsed.data),
      201,
    );
  });

  app.post('/api/portal-requests/:id/deliver', async (c) => {
    const parsed = await readBody(c, PortalDeliveryConfirmSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.confirmPortalDelivery(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/workflows/:id/publish', async (c) => {
    const parsed = await readBody(c, WorkflowPublishSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.publishWorkflow(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/workflows/:id/test', async (c) => {
    const parsed = await readBody(c, WorkflowTestSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.testWorkflow(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/workflows/:id/runs', async (c) => {
    const parsed = await readBody(c, WorkflowRunStartSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.runWorkflow(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/workflows/:id/rollback', async (c) => {
    const parsed = await readBody(c, WorkflowRollbackSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.rollbackWorkflow(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/workflows/:id/replay', async (c) => {
    const parsed = await readBody(c, WorkflowReplaySchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.replayWorkflow(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/workflow-runs/:id/retry', async (c) => {
    const parsed = await readBody(c, WorkflowRetryNodeSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.retryWorkflowNode(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/approvals', async (c) => {
    const parsed = await readBody(c, ApprovalCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createApproval(currentUser(c), parsed.data), 201);
  });

  app.post('/api/approvals/:id/decisions', async (c) => {
    const parsed = await readBody(c, ApprovalDecisionSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.decideApproval(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/approvals/:id/withdraw', async (c) => {
    const parsed = await readBody(c, ApprovalWithdrawSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.withdrawApproval(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.get('/api/approvals/metrics', (c) => {
    const parsed = readQuery(c, ApprovalMetricsQuerySchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.approvalMetrics(currentUser(c), parsed.data));
  });

  app.get('/api/approval-routing-rules', (c) =>
    send(c, actions.listApprovalRoutingRules(currentUser(c))),
  );

  app.post('/api/approval-routing-rules', async (c) => {
    const parsed = await readBody(c, ApprovalRoutingRuleCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createApprovalRoutingRule(currentUser(c), parsed.data), 201);
  });

  app.delete('/api/approval-routing-rules/:id', (c) =>
    send(c, actions.deleteApprovalRoutingRule(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/triggers/:id/fire', async (c) => {
    const parsed = await readBody(c, TriggerFireSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.fireTrigger(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/triggers/tick', (c) => send(c, actions.tickTriggers(currentUser(c))));

  app.post('/api/connectors/:id/rotate', async (c) => {
    const parsed = await readBody(c, ConnectorRotateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.rotateConnector(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.get('/api/connectors/:id/health', (c) =>
    send(c, actions.connectorHealth(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/connectors/:id/oauth/start', async (c) => {
    const parsed = await readBody(c, ConnectorOAuthStartSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.connectorOauthStart(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/connectors/:id/oauth/callback', async (c) => {
    const parsed = await readBody(c, ConnectorOAuthCallbackSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      await actions.connectorOauthCallback(currentUser(c), c.req.param('id'), parsed.data),
    );
  });

  app.post('/api/connectors/:id/oauth/refresh', async (c) =>
    send(c, await actions.connectorOauthRefresh(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/connectors/:id/call', async (c) => {
    const parsed = await readBody(c, ConnectorCallSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, await actions.connectorCall(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/events', async (c) => {
    const parsed = await readBody(c, EventPublishSchema);
    if (!parsed.ok) return parsed.response;
    const result = actions.publishDomainEvent(currentUser(c), parsed.data);
    const duplicate = result.ok && result.data.duplicate === true;
    return send(c, result, duplicate ? 200 : 201);
  });

  app.post('/api/event-subscriptions', async (c) => {
    const parsed = await readBody(c, EventSubscriptionCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createEventSubscription(currentUser(c), parsed.data), 201);
  });

  app.post('/api/events/tick', async (c) =>
    send(c, await actions.tickEventDeliveries(currentUser(c))),
  );

  app.post('/api/event-deliveries/:id/retry', (c) =>
    send(c, actions.retryEventDelivery(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/jobs', async (c) => {
    const parsed = await readBody(c, BackgroundJobCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createBackgroundJob(currentUser(c), parsed.data), 201);
  });

  app.post('/api/jobs/tick', async (c) => {
    const parsed = await readBody(c, BackgroundJobTickSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, await actions.tickBackgroundJobs(currentUser(c), parsed.data));
  });

  app.post('/api/jobs/:id/retry', (c) =>
    send(c, actions.retryBackgroundJob(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/sandbox/run', async (c) => {
    const parsed = await readBody(c, SandboxRunSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.sandboxRun(currentUser(c), parsed.data));
  });

  app.post('/api/automation/rules/:id/rollback', async (c) => {
    const parsed = await readBody(c, AutomationRollbackSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.rollbackAutomationRule(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/anomalies/detect', async (c) => {
    const parsed = await readBody(c, AnomalyDetectSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.detectAnomalies(currentUser(c), parsed.data));
  });

  app.post('/api/anomalies/:id/dismiss', async (c) => {
    const parsed = await readBody(c, AnomalyDismissSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.dismissAnomaly(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/quality/scan', async (c) => {
    const parsed = await readBody(c, QualityScanSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.scanQuality(currentUser(c), parsed.data));
  });

  app.post('/api/quality/issues/batch-fix', async (c) => {
    const parsed = await readBody(c, QualityBatchFixSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.batchFixQuality(currentUser(c), parsed.data));
  });

  app.post('/api/quality/issues/:id/fix', async (c) => {
    const parsed = await readBody(c, QualityFixSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.fixQualityIssue(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/quality/issues/:id/revert', async (c) => {
    const parsed = await readBody(c, QualityRevertSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.revertQualityFix(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/scenarios/compare', async (c) => {
    const parsed = await readBody(c, ScenarioCompareSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.compareScenarios(currentUser(c), parsed.data.ids));
  });

  app.post('/api/scenarios/:id/evaluate', (c) =>
    send(c, actions.evaluateScenario(currentUser(c), c.req.param('id'))),
  );

  app.get('/api/crm/funnel', (c) => {
    const parsed = readQuery(c, FunnelQuerySchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.funnel(currentUser(c), parsed.data));
  });

  app.post('/api/query/preview', async (c) => {
    const parsed = await readBody(c, QueryPreviewSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.previewQuery(currentUser(c), parsed.data));
  });

  app.post('/api/query-reports/:id/run', (c) =>
    send(c, actions.runQueryReport(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/report-subscriptions', async (c) => {
    const parsed = await readBody(c, ReportSubscriptionCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createReportSubscription(currentUser(c), parsed.data), 201);
  });

  app.post('/api/report-subscriptions/run', (c) =>
    send(c, actions.runReportSubscriptions(currentUser(c))),
  );

  app.get('/api/metrics/:id/impact', (c) =>
    send(c, actions.lineageImpact(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/metrics/:id/lineage', async (c) => {
    const parsed = await readBody(c, LineageCreateSchema);
    if (!parsed.ok) return parsed.response;
    const result = actions.addLineage(currentUser(c), c.req.param('id'), parsed.data);
    const duplicate = result.ok && result.data.duplicate === true;
    return send(c, result, duplicate ? 200 : 201);
  });

  app.post('/api/budgets/:id/categories', async (c) => {
    const parsed = await readBody(c, BudgetCategoryCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.createBudgetCategory(currentUser(c), c.req.param('id'), parsed.data),
      201,
    );
  });

  app.patch('/api/budget-categories/:id', async (c) => {
    const parsed = await readBody(c, BudgetCategoryUpdateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.updateBudgetCategory(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.get('/api/projects/:id/budget-alerts', (c) =>
    send(c, actions.budgetAlerts(currentUser(c), c.req.param('id'))),
  );

  app.post('/api/projects/:id/budget/approval', async (c) => {
    const parsed = await readBody(c, BudgetApprovalSchema);
    if (!parsed.ok) return parsed.response;
    return send(
      c,
      actions.requestBudgetApproval(currentUser(c), c.req.param('id'), parsed.data),
      201,
    );
  });

  app.post('/api/organizations', async (c) => {
    const parsed = await readBody(c, OrganizationCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createOrganization(currentUser(c), parsed.data), 201);
  });

  app.post('/api/organizations/:id/departments', async (c) => {
    const parsed = await readBody(c, DepartmentCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createDepartment(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/organizations/:id/members', async (c) => {
    const parsed = await readBody(c, OrgMembershipCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.addOrgMembership(currentUser(c), c.req.param('id'), parsed.data), 201);
  });

  app.post('/api/workspace/members', async (c) => {
    const parsed = await readBody(c, WorkspaceMemberCreateSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.createWorkspaceMember(currentUser(c), parsed.data), 201);
  });

  app.post('/api/workspace/switch', async (c) => {
    const parsed = await readBody(c, WorkspaceSwitchSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.switchWorkspace(currentUser(c), parsed.data));
  });

  app.post('/api/permission-samples/run', async (c) => {
    const parsed = await readBody(c, PermissionSampleRunSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.runPermissionSamples(currentUser(c), parsed.data));
  });

  app.post('/api/governance/jit/use', async (c) => {
    const parsed = await readBody(c, JitUsageSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.consumeJitGrant(currentUser(c), undefined, parsed.data));
  });

  app.post('/api/governance/jit/:id/use', async (c) => {
    const parsed = await readBody(c, JitUsageSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.consumeJitGrant(currentUser(c), c.req.param('id'), parsed.data));
  });

  app.post('/api/governance/jit/:id/post-review', async (c) => {
    const parsed = await readBody(c, JitPostReviewSchema);
    if (!parsed.ok) return parsed.response;
    return send(c, actions.postReviewJitGrant(currentUser(c), c.req.param('id'), parsed.data));
  });

  return app;
}
