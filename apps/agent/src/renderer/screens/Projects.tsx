import { useQuery } from '@tanstack/react-query';
import { FolderKanban } from 'lucide-react';
import { projectStyle } from '../lib/projectStyle';

export default function Projects() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => window.agent.projects.list() });

  return (
    <>
      <div className="toolbar">
        <span className="h1 no-drag">Projects</span>
      </div>
      <div className="content-scroll">
        <div className="content-narrow">
          {projects.isLoading && <div className="callout secondary" style={{ padding: '0 4px' }}>Loading…</div>}
          {projects.data && projects.data.length > 0 ? (
            <div className="task-list">
              {projects.data.map((p, i) => {
                const st = projectStyle(p.id);
                const Icon = st.icon;
                return (
                  <div key={p.id} className={`task rise rise-${Math.min(i + 1, 3)}`}>
                    <span className="task-icon" style={{ background: st.color }}>
                      <Icon size={20} strokeWidth={2} />
                    </span>
                    <span className="task-main">
                      <span className="task-title" style={{ display: 'block' }}>{p.name}</span>
                      <span className="task-tags">
                        <span className="tag" style={{ background: st.tagBg, color: st.tagFg }}>Project</span>
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            !projects.isLoading && (
              <div className="empty">
                <span className="empty-icon"><FolderKanban size={26} strokeWidth={1.75} /></span>
                <div className="h3">No projects yet</div>
                <div className="callout secondary">Projects created by your admin will appear here.</div>
              </div>
            )
          )}
        </div>
      </div>
    </>
  );
}
