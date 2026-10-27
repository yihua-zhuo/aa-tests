import { useSearchParams } from 'react-router-dom';
import { canManageWorkspace, canViewUserDirectory } from '../../../shared/permissions.ts';
import { api } from '../api.ts';
import { DeliveryTab } from '../components/enterprise/DeliveryTab.tsx';
import { ExecutionTab } from '../components/enterprise/ExecutionTab.tsx';
import { GoalsTab } from '../components/enterprise/GoalsTab.tsx';
import { GovernanceTab } from '../components/enterprise/GovernanceTab.tsx';
import { InsightsTab } from '../components/enterprise/InsightsTab.tsx';
import { KnowledgeTab } from '../components/enterprise/KnowledgeTab.tsx';
import { OperationsTab } from '../components/enterprise/OperationsTab.tsx';
import { PlanningTab } from '../components/enterprise/PlanningTab.tsx';
import { PortfolioTab } from '../components/enterprise/PortfolioTab.tsx';
import { ErrorState, SegmentedControl, Skeleton } from '../components/ui.tsx';
import { useApi } from '../hooks/useApi.ts';
import { useAuth } from '../hooks/useAuth.tsx';

type Tab =
  | 'goals'
  | 'portfolio'
  | 'planning'
  | 'execution'
  | 'delivery'
  | 'knowledge'
  | 'insights'
  | 'operations'
  | 'governance';

const TAB_LABELS: Record<Tab, string> = {
  goals: '战略目标',
  portfolio: '项目组合',
  planning: '排期与风险',
  execution: '执行治理',
  delivery: '交付治理',
  knowledge: '知识库',
  insights: '指标与预算',
  operations: '流程与数据',
  governance: '权限治理',
};

function parseTab(value: string | null): Tab {
  return value === 'portfolio' ||
    value === 'planning' ||
    value === 'execution' ||
    value === 'delivery' ||
    value === 'knowledge' ||
    value === 'insights' ||
    value === 'operations' ||
    value === 'governance'
    ? value
    : 'goals';
}

export default function EnterprisePage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = parseTab(params.get('tab'));
  const governanceAllowed = Boolean(user && canManageWorkspace(user.role, user.permissions));
  const tab: Tab = requested === 'governance' && !governanceAllowed ? 'goals' : requested;

  const projectsState = useApi((signal) => api.projects({ pageSize: 50 }, signal), []);
  const peopleState = useApi((signal) => api.userOptions(signal), [], {
    skip: !user || !canViewUserDirectory(user.role, user.permissions),
  });

  const projects = projectsState.data?.projects ?? [];
  const people = peopleState.data?.users ?? [];

  const options = (Object.keys(TAB_LABELS) as Tab[])
    .filter((value) => value !== 'governance' || governanceAllowed)
    .map((value) => ({ value, label: TAB_LABELS[value] }));

  const select = (next: Tab) => {
    setParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.set('tab', next);
        return params;
      },
      { replace: true },
    );
  };

  return (
    <div className="page enterprise-page">
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">Enterprise</p>
          <h1>企业工作台</h1>
          <p className="page-sub">
            统一管理战略目标、项目组合、排期风险、执行与交付治理、知识沉淀、指标预算与权限治理；所有写操作均带版本校验与审计记录。
          </p>
        </div>
      </header>

      <div className="enterprise-tabs">
        <SegmentedControl options={options} value={tab} onChange={select} label="企业工作台页签" />
      </div>

      {projectsState.error && !projectsState.data ? (
        <div className="card card-pad">
          <ErrorState message={projectsState.error} onRetry={projectsState.reload} />
        </div>
      ) : null}

      {!projectsState.data && projectsState.loading ? (
        <div className="card card-pad enterprise-loading" aria-hidden="true">
          <Skeleton height={18} width="30%" />
          <Skeleton height={12} width="80%" />
          <Skeleton height={12} width="64%" />
        </div>
      ) : null}

      {projectsState.data ? (
        <div className="tab-panel" key={tab}>
          {tab === 'goals' ? <GoalsTab projects={projects} people={people} /> : null}
          {tab === 'portfolio' ? <PortfolioTab projects={projects} people={people} /> : null}
          {tab === 'planning' ? <PlanningTab projects={projects} people={people} /> : null}
          {tab === 'execution' ? <ExecutionTab projects={projects} people={people} /> : null}
          {tab === 'delivery' ? <DeliveryTab projects={projects} people={people} /> : null}
          {tab === 'knowledge' ? <KnowledgeTab projects={projects} people={people} /> : null}
          {tab === 'insights' ? <InsightsTab projects={projects} people={people} /> : null}
          {tab === 'operations' ? <OperationsTab projects={projects} people={people} /> : null}
          {tab === 'governance' && governanceAllowed ? (
            <GovernanceTab projects={projects} people={people} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
