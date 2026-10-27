import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon.tsx';

export function NotFoundPage() {
  return (
    <div className="page">
      <section className="card card-pad not-found-card">
        <span className="not-found-code" aria-hidden="true">
          404
        </span>
        <span className="not-found-icon" aria-hidden="true">
          <Icon name="search" size={30} />
        </span>
        <h1>页面走丢了</h1>
        <p>你访问的地址不存在，或者已经被移动到新的位置。</p>
        <div className="not-found-actions">
          <Link to="/" className="btn btn-primary">
            <Icon name="overview" size={16} />
            返回 Overview
          </Link>
          <Link to="/projects" className="btn btn-ghost">
            浏览项目
            <Icon name="arrowRight" size={16} />
          </Link>
        </div>
      </section>
    </div>
  );
}

export function ForbiddenPage() {
  return (
    <div className="page">
      <section className="card card-pad not-found-card">
        <span className="not-found-code" aria-hidden="true">
          403
        </span>
        <span className="not-found-icon" aria-hidden="true">
          <Icon name="lock" size={30} />
        </span>
        <h1>没有访问权限</h1>
        <p>你的角色无法访问此页面。需要管理员或业务经理权限。</p>
        <div className="not-found-actions">
          <Link to="/" className="btn btn-primary">
            <Icon name="overview" size={16} />
            返回 Overview
          </Link>
        </div>
      </section>
    </div>
  );
}
